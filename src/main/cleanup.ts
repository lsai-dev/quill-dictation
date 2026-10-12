import { EventEmitter } from 'node:events';
import { cleanupModelById, cleanupSupports } from '../shared/cleanupModels';
import { acceptCleanup } from '../shared/cleanupGuard';
import { buildCleanupPrompt, chunkTranscript, cleanupPrefix } from '../shared/cleanupPrompt';
import type { EngineStatus } from '../shared/types';
import { LineProcess } from './lineProcess';
import { log } from './log';
import { nativeBinary } from './paths';

interface Target {
  modelId: string;
  path: string;
  device: 'gpu' | 'cpu';
}

interface Cleaned {
  text: string;
  stop: string;
  generated_tokens: number;
  accepted_tokens: number;
  drafted_tokens: number;
  process_ms: number;
}

export interface PolishOptions {
  /** The transcript's language (an ISO code). Text in a language the model doesn't handle is left alone. */
  language: string;
  /** Give up (keeping the original for whatever isn't done) after this long. */
  deadlineMs: number;
}

export interface PolishResult {
  text: string;
  outcome: 'polished' | 'unchanged' | 'fallback' | 'skipped';
  ms: number;
}

/**
 * Owns the transcript-cleanup engine (quill-cleanup): a small language model that
 * polishes transcripts locally. Like the transcription engine it prefers the GPU build
 * when the plan puts cleanup there and quietly falls back to the CPU build.
 *
 * Cleanup is never allowed to cost the user their words: every result passes the
 * guard in shared/cleanupGuard.ts, and anything that fails, errors, is cancelled or
 * runs past its deadline leaves the original transcript in place.
 */
export class CleanupEngine extends EventEmitter {
  private proc: LineProcess | null = null;
  private variant: 'vulkan' | 'cpu' | null = null;
  private loaded: Target | null = null;
  private wanted: Target | null = null;
  private loading: Promise<void> | null = null;
  private gpuFailures = 0;
  private threads = 0;
  /** The dictation language, so the instructions primed at load are the ones used. */
  private language = 'en';
  /** The `clean` request in flight, so it can be cancelled. */
  private active: number | null = null;
  /** Bumped by cancel(); a polish started under an older generation stops. */
  private generation = 0;
  status: EngineStatus = { state: 'idle' };

  /** Whether this installation includes the cleanup engine at all. */
  get available() {
    return !!(nativeBinary('quill-cleanup-cpu') || nativeBinary('quill-cleanup-vulkan'));
  }

  hasGpuBuild() {
    return !!nativeBinary('quill-cleanup-vulkan');
  }

  setThreads(n: number) {
    this.threads = n;
  }

  /** Re-primes the cached instructions for a new dictation language (in the background). */
  setLanguage(language: string) {
    if (language === this.language) return;
    this.language = language;
    const spec = cleanupModelById(this.loaded?.modelId);
    if (spec && this.ready) void this.proc!.request('prime', { prefix: cleanupPrefix(spec, language) }, undefined, 120000).catch(() => undefined);
  }

  get modelId() {
    return this.loaded?.modelId ?? null;
  }

  get ready() {
    return this.status.state === 'ready' && !!this.loaded && !!this.proc?.running;
  }

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.emit('status', s);
  }

  /** Make sure `path` is loaded on the preferred device. Idempotent. */
  ensure(modelId: string, path: string, device: 'gpu' | 'cpu'): Promise<void> {
    const target: Target = { modelId, path, device: device === 'gpu' && this.gpuFailures < 2 && this.hasGpuBuild() ? 'gpu' : 'cpu' };
    this.wanted = target;
    if (this.loaded && this.loaded.path === target.path && this.loaded.device === target.device && this.proc?.running) return Promise.resolve();
    if (this.loading) return this.loading.then(() => this.ensure(modelId, path, device));
    this.loading = this.load(target).finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(t: Target) {
    this.setStatus({ state: 'loading', modelId: t.modelId });
    try {
      await this.loadOn(t);
    } catch (e) {
      if (t.device === 'gpu') {
        log.warn(`cleanup: GPU engine failed (${(e as Error).message}); using the CPU`);
        this.gpuFailures++;
        const cpu = { ...t, device: 'cpu' as const };
        this.wanted = cpu;
        try {
          await this.loadOn(cpu);
          return;
        } catch (e2) {
          e = e2;
        }
      }
      this.loaded = null;
      this.setStatus({ state: 'error', message: friendlyError(e as Error) });
      throw e;
    }
  }

  private async loadOn(t: Target) {
    const variant = t.device === 'gpu' ? 'vulkan' : 'cpu';
    if (!this.proc?.running || this.variant !== variant) await this.spawn(variant);
    const started = Date.now();
    await this.proc!.request('load', { model: t.path, gpu: t.device === 'gpu', threads: this.threads, ctx: 4096 }, undefined, 180000);
    // Read the instructions once now, so the first dictation only pays for itself.
    const spec = cleanupModelById(t.modelId);
    if (spec) await this.proc!.request('prime', { prefix: cleanupPrefix(spec, this.language) }, undefined, 120000);
    this.loaded = t;
    const loadMs = Date.now() - started;
    log.info(`cleanup: loaded ${t.modelId} on ${t.device} in ${loadMs} ms`);
    this.setStatus({ state: 'ready', modelId: t.modelId, device: t.device, loadMs });
  }

  private async spawn(variant: 'vulkan' | 'cpu') {
    await this.proc?.stop();
    this.loaded = null;
    const bin = nativeBinary(variant === 'vulkan' ? 'quill-cleanup-vulkan' : 'quill-cleanup-cpu');
    if (!bin) throw new Error(`Cleanup engine (${variant}) is missing from this installation`);
    const proc = new LineProcess(`cleanup:${variant}`, bin, [], 'above-normal');
    proc.on('exit', (code: number | null) => {
      if (this.proc !== proc) return;
      this.loaded = null;
      this.active = null;
      if (variant === 'vulkan' && code !== 0) this.gpuFailures++;
      if (this.status.state !== 'idle') this.setStatus({ state: 'error', message: 'Cleanup stopped unexpectedly. It will restart on your next dictation.' });
    });
    this.proc = proc;
    this.variant = variant;
    const ready = await proc.start(20000);
    log.info(`cleanup ${variant} ready: ${String(ready.system_info ?? '').slice(0, 120)}`);
  }

  /** Stop whatever polish is running; its text is left as it was. */
  cancel() {
    this.generation++;
    this.abortActive();
  }

  private abortActive() {
    const id = this.active;
    if (id !== null && this.proc?.running) void this.proc.request('cancel', { target: id }, undefined, 2000).catch(() => undefined);
  }

  /**
   * Polish `text`. Never throws and never returns anything the guard rejected: the
   * worst case is the original text with outcome 'fallback'.
   */
  async polish(text: string, opts: PolishOptions): Promise<PolishResult> {
    const started = Date.now();
    const gen = this.generation;
    const done = (t: string, outcome: PolishResult['outcome']): PolishResult => ({ text: t, outcome, ms: Date.now() - started });
    const spec = cleanupModelById(this.wanted?.modelId);
    if (!spec || !cleanupSupports(spec, opts.language)) return done(text, 'skipped');

    // Never make a dictation wait for a model to load: if the engine isn't ready (still
    // loading, or recovering from a crash), this one goes in as spoken.
    if (!this.ready || !this.proc) {
      if (this.wanted && !this.loading) void this.ensure(this.wanted.modelId, this.wanted.path, this.wanted.device).catch(() => undefined);
      return done(text, 'skipped');
    }

    const deadline = started + opts.deadlineMs;
    const chunks = chunkTranscript(text);
    const out: string[] = [];
    let changed = false;
    let failed = false;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (gen !== this.generation) return done(text, 'skipped');
      const remaining = deadline - Date.now();
      if (remaining < 150) {
        // Out of time: the rest stays exactly as spoken.
        failed = true;
        for (const rest of chunks.slice(i)) out.push(rest.text + rest.sep);
        break;
      }
      // Short pieces ("OK.") have nothing worth polishing.
      if (c.text.split(/\s+/).filter(Boolean).length < 3) {
        out.push(c.text + c.sep);
        continue;
      }
      const p = buildCleanupPrompt(spec.format, c.text, opts.language);
      const req = this.proc.send<Cleaned>(
        'clean',
        { prefix: p.prefix, prompt: p.prompt, lookup: c.text, max_tokens: p.maxTokens, stop: p.stop },
        undefined,
        remaining + 2000,
      );
      this.active = req.id;
      const timer = setTimeout(() => this.abortActive(), remaining);
      try {
        const r = await req.done;
        const verdict = acceptCleanup(c.text, r.text);
        if (r.stop === 'limit' || !verdict.ok) {
          log.info(`cleanup: kept the original (${r.stop === 'limit' ? 'runaway' : verdict.reason}) for ${c.text.length} chars`);
          failed = true;
          out.push(c.text + c.sep);
        } else {
          changed = changed || verdict.changed;
          out.push(verdict.text + c.sep);
          log.debug(`cleanup: ${r.generated_tokens} tokens (${r.accepted_tokens}/${r.drafted_tokens} drafted) in ${r.process_ms} ms`);
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg !== 'cancelled') log.warn(`cleanup: ${msg}`);
        failed = true;
        out.push(c.text + c.sep);
        if (msg === 'cancelled' || !this.proc?.running) {
          // Keep the rest exactly as spoken.
          for (const rest of chunks.slice(i + 1)) out.push(rest.text + rest.sep);
          break;
        }
      } finally {
        clearTimeout(timer);
        if (this.active === req.id) this.active = null;
      }
    }
    if (gen !== this.generation) return done(text, 'skipped');
    const result = out.join('');
    if (failed && !changed) return done(text, 'fallback');
    return done(result, changed ? 'polished' : 'unchanged');
  }

  async unload() {
    this.cancel();
    this.wanted = null;
    this.loaded = null;
    await this.proc?.stop();
    this.proc = null;
    this.variant = null;
    this.setStatus({ state: 'idle' });
  }
}

function friendlyError(e: Error): string {
  const m = e.message || '';
  if (/missing from this installation/i.test(m)) return 'The cleanup engine is missing. Reinstall Quill to restore it.';
  if (/memory|alloc/i.test(m)) return 'Not enough memory for this cleanup model. Choose a lighter one.';
  if (/not a GGUF|failed to open|could not load/i.test(m)) return 'The cleanup model file could not be opened. Try downloading it again.';
  return m;
}
