import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';
import { LineProcess } from './lineProcess';
import { nativeBinary } from './paths';
import { log } from './log';
import type { EngineStatus } from '../shared/types';

export interface TranscribeOptions {
  language: string;
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  language: string;
  audio_ms: number;
  process_ms: number;
  segments: { text: string; no_speech_prob?: number }[];
}

interface Target {
  modelId: string;
  path: string;
  device: 'gpu' | 'cpu';
}

/**
 * Owns the transcription engine process. The GPU (Vulkan) build is tried first
 * when the hardware warrants it; if it can't start, can't load, or ever
 * crashes, Quill quietly falls back to the CPU build — dictation keeps working.
 */
export class Engine extends EventEmitter {
  private proc: LineProcess | null = null;
  private variant: 'vulkan' | 'cpu' | null = null;
  private loaded: Target | null = null;
  private wanted: Target | null = null;
  private loading: Promise<void> | null = null;
  private gpuFailures = 0;
  status: EngineStatus = { state: 'idle' };

  private setStatus(s: EngineStatus) {
    this.status = s;
    this.emit('status', s);
  }

  hasGpuBuild() {
    return !!nativeBinary('quill-engine-vulkan');
  }

  hasAnyBuild() {
    return !!(nativeBinary('quill-engine-cpu') || nativeBinary('quill-engine-vulkan'));
  }

  /** Make sure `path` is loaded on the preferred device. Idempotent. */
  ensure(modelId: string, path: string, device: 'gpu' | 'cpu'): Promise<void> {
    const target: Target = { modelId, path, device: device === 'gpu' && this.gpuFailures < 2 && this.hasGpuBuild() ? 'gpu' : 'cpu' };
    this.wanted = target;
    if (this.loaded && same(this.loaded, target) && this.proc?.running) return Promise.resolve();
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
        log.warn(`GPU engine failed (${(e as Error).message}); falling back to CPU`);
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
    const threads = Math.max(1, Math.min(8, Math.floor((cpus().length || 2) / 2)));
    const r = await this.proc!.request<{ load_ms: number }>(
      'load',
      { model: t.path, gpu: t.device === 'gpu', flash_attn: true, threads },
      undefined,
      180000,
    );
    this.loaded = t;
    log.info(`engine: loaded ${t.modelId} on ${t.device} in ${Date.now() - started} ms`);
    this.setStatus({ state: 'ready', modelId: t.modelId, device: t.device, loadMs: r.load_ms ?? Date.now() - started });
  }

  private async spawn(variant: 'vulkan' | 'cpu') {
    await this.proc?.stop();
    this.loaded = null;
    const bin = nativeBinary(variant === 'vulkan' ? 'quill-engine-vulkan' : 'quill-engine-cpu');
    if (!bin) throw new Error(`Transcription engine (${variant}) is missing from this installation`);
    const proc = new LineProcess(`engine:${variant}`, bin);
    proc.on('exit', (code: number | null) => {
      if (this.proc !== proc) return;
      this.loaded = null;
      if (variant === 'vulkan' && code !== 0) this.gpuFailures++;
      if (this.status.state !== 'idle') this.setStatus({ state: 'error', message: 'The transcription engine stopped. It will restart on your next dictation.' });
    });
    this.proc = proc;
    this.variant = variant;
    const ready = await proc.start(20000);
    log.info(`engine ${variant} ready: ${String(ready.system_info ?? '').slice(0, 160)}`);
  }

  async transcribe(audio: Float32Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    // Recover from a crash or a pending load transparently.
    if (this.loading) await this.loading.catch(() => undefined);
    if ((!this.loaded || !this.proc?.running) && this.wanted) await this.ensure(this.wanted.modelId, this.wanted.path, this.wanted.device);
    if (!this.loaded || !this.proc) throw new Error('No model is loaded');
    const payload = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    const audioSec = audio.length / 16000;
    const timeout = Math.max(60000, audioSec * 12000);
    try {
      return await this.proc.request<TranscribeResult>(
        'transcribe',
        { language: opts.language || 'auto', translate: false, prompt: opts.prompt ?? '', beam_size: 0 },
        payload,
        timeout,
      );
    } catch (e) {
      // A GPU driver crash mid-transcription: retry once on the CPU.
      if (this.loaded?.device === 'gpu' && !this.proc?.running) {
        log.warn('engine crashed on GPU; retrying on CPU');
        this.gpuFailures = 2;
        const t = this.loaded ?? this.wanted!;
        await this.ensure(t.modelId, t.path, 'cpu');
        return this.proc!.request<TranscribeResult>('transcribe', { language: opts.language || 'auto', prompt: opts.prompt ?? '', beam_size: 0 }, payload, timeout);
      }
      throw e;
    }
  }

  async unload() {
    this.wanted = null;
    this.loaded = null;
    await this.proc?.stop();
    this.proc = null;
    this.variant = null;
    this.setStatus({ state: 'idle' });
  }

  get modelId() {
    return this.loaded?.modelId ?? null;
  }
}

function same(a: Target, b: Target) {
  return a.path === b.path && a.device === b.device;
}

function friendlyError(e: Error): string {
  const m = e.message || '';
  if (/missing from this installation/i.test(m)) return 'The transcription engine is missing. Reinstall Quill to restore it.';
  if (/memory|alloc/i.test(m)) return 'Not enough memory for this model. Choose a lighter one.';
  if (/no such file|not found|failed to open/i.test(m)) return 'The model file could not be opened. Try downloading it again.';
  return m;
}
