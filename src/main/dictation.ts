import { EventEmitter } from 'node:events';
import { prepareForModel, SAMPLE_RATE } from '../shared/audio';
import { cleanTranscript, smartSpace } from '../shared/text';
import type { DictationResult, HotkeyMode, Settings } from '../shared/types';
import type { Engine } from './engine';
import type { Hotkey } from './hotkey';
import { insertText } from './inject';
import type { NativeHelper } from './native';
import type { OverlayWindow } from './overlay';
import { log } from './log';

type Phase = 'idle' | 'listening' | 'stopping' | 'processing' | 'refining';

/** Optional polish between transcription and insertion (see cleanup.ts). */
export interface DictationCleanup {
  /** Whether cleanup is on and its model is ready to use right now. */
  ready: () => boolean;
  /** Never throws; the worst case is the original text. */
  polish: (text: string, language: string) => Promise<{ text: string; outcome: 'polished' | 'unchanged' | 'fallback' | 'skipped'; ms: number }>;
  /** Stop a running polish (its text is kept as spoken). */
  cancel: () => void;
}

/** A press shorter than this is a tap (toggle); longer is hold-to-talk. */
const HOLD_THRESHOLD_MS = 380;
const MAX_RECORDING_MS = 10 * 60 * 1000;

export interface DictationDeps {
  overlay: OverlayWindow;
  engine: Engine;
  hotkey: Hotkey;
  native: NativeHelper | null;
  settings: () => Settings;
  theme: () => { dark: boolean; reducedMotion: boolean | null };
  /** Resolves the loaded model, or a reason dictation can't start yet. */
  readiness: () => { ok: true; modelId: string } | { ok: false; message: string };
  cleanup?: DictationCleanup;
}

/**
 * The dictation session state machine.
 *
 *   idle ──hotkey──▶ listening ──hotkey/stop──▶ stopping ──audio──▶ processing ──▶ [refining] ──▶ idle
 *                       │                                                                 │
 *                       └──────────────────────── Esc / cancel ───────────────────────────┘
 *
 * Refining (cleanup) is optional. "Insert as-is" during refining skips straight to
 * inserting the transcript; Esc cancels everything. Each session inserts at most once,
 * and a result that arrives after its session ended is dropped.
 */
export class Dictation extends EventEmitter {
  private phase: Phase = 'idle';
  private pressAt = 0;
  private holdCandidate = false;
  private session = 0;
  private maxTimer: NodeJS.Timeout | null = null;
  private target: { handle: string | null } = { handle: null };
  private last: { handle: string | null; lastChar: string | null; at: number } = { handle: null, lastChar: null, at: 0 };
  history: DictationResult[] = [];

  constructor(private d: DictationDeps) {
    super();
    d.hotkey.on('down', () => this.onDown());
    d.hotkey.on('up', () => this.onUp());
    d.hotkey.on('escape', () => this.cancel());
    d.overlay.on('action', (a: string) => (a === 'stop' ? this.finish() : a === 'skip' ? this.skipCleanup() : this.cancel()));
    d.overlay.on('audio', (pcm: Float32Array) => void this.onAudio(pcm));
    d.overlay.on('mic-error', (msg: string) => this.fail(msg));
  }

  get busy() {
    return this.phase !== 'idle';
  }

  private get mode(): HotkeyMode {
    return this.d.settings().hotkeyMode;
  }

  private onDown() {
    const mode = this.mode;
    if (this.phase === 'idle') {
      this.start();
      this.pressAt = Date.now();
      this.holdCandidate = mode !== 'toggle';
      return;
    }
    if (this.phase === 'listening' && mode !== 'hold') this.finish();
  }

  private onUp() {
    if (this.phase !== 'listening' || !this.holdCandidate) return;
    this.holdCandidate = false;
    const held = Date.now() - this.pressAt;
    if (this.mode === 'hold' || held >= HOLD_THRESHOLD_MS) this.finish(); // released after holding: push-to-talk
    // otherwise it was a tap: keep listening until the next press
  }

  /** Begin a session (also used by the app's "Try it" button). */
  start() {
    if (this.phase !== 'idle') return;
    const s = this.d.settings();
    const theme = this.d.theme();
    const ready = this.d.readiness();
    if (!ready.ok) {
      this.d.overlay.show({ type: 'show', reducedMotion: theme.reducedMotion, dark: theme.dark, sounds: false, microphoneId: 'none', hotkeyLabel: this.d.hotkey.activeLabel, mode: s.hotkeyMode });
      this.d.overlay.send({ type: 'error', message: ready.message });
      this.emit('needs-setup');
      return;
    }
    this.session++;
    this.phase = 'listening';
    this.target = { handle: null };
    void this.d.native?.foreground().then((f) => (this.target = { handle: f?.handle ?? null }));
    this.d.hotkey.captureEscape(true);
    this.d.overlay.show({
      type: 'show',
      reducedMotion: theme.reducedMotion,
      dark: theme.dark,
      sounds: s.sounds,
      microphoneId: s.microphoneId,
      hotkeyLabel: this.d.hotkey.activeLabel,
      mode: s.hotkeyMode,
    });
    const session = this.session;
    this.maxTimer = setTimeout(() => session === this.session && this.finish(), MAX_RECORDING_MS);
    log.info(`dictation ${this.session}: listening`);
    this.emit('phase', this.phase);
  }

  finish() {
    if (this.phase !== 'listening') return;
    this.phase = 'stopping';
    this.clearTimer();
    log.info(`dictation ${this.session}: stopping`);
    this.d.overlay.send({ type: 'stop' }); // overlay replies with the captured audio
    this.emit('phase', this.phase);
  }

  /** During cleanup: insert the transcript as spoken, now. */
  skipCleanup() {
    if (this.phase !== 'refining') return;
    log.info(`dictation ${this.session}: inserting without cleanup`);
    this.d.cleanup?.cancel();
  }

  cancel() {
    if (this.phase === 'idle') return;
    if (this.phase === 'refining') this.d.cleanup?.cancel();
    this.session++;
    this.phase = 'idle';
    this.clearTimer();
    this.d.hotkey.captureEscape(false);
    this.d.overlay.send({ type: 'cancel' });
    this.emit('phase', this.phase);
  }

  private fail(message: string) {
    log.info(`dictation ${this.session}: ${message}`);
    this.session++;
    this.phase = 'idle';
    this.clearTimer();
    this.d.hotkey.captureEscape(false);
    this.d.overlay.send({ type: 'error', message });
    this.emit('phase', this.phase);
  }

  private async onAudio(pcm: Float32Array) {
    if (this.phase !== 'stopping') return;
    const session = this.session;
    const s = this.d.settings();
    const { audio, analysis } = prepareForModel(pcm);
    if (!analysis.hasSpeech) {
      log.info(`no speech (${pcm.length / SAMPLE_RATE}s, noise ${analysis.noiseDb.toFixed(1)} dB)`);
      this.fail(pcm.length < SAMPLE_RATE * 0.6 ? 'Hold to talk, or tap once to start' : 'Didn’t catch that');
      return;
    }
    this.phase = 'processing';
    log.info(`dictation ${session}: transcribing ${(audio.length / SAMPLE_RATE).toFixed(1)} s (${(analysis.speechMs / 1000).toFixed(1)} s of speech)`);
    this.d.overlay.send({ type: 'process' });
    this.emit('phase', this.phase);

    try {
      const r = await this.d.engine.transcribe(audio, {
        language: s.language,
        prompt: buildPrompt(s.customVocabulary),
      });
      if (session !== this.session) return; // cancelled meanwhile
      let text = cleanTranscript(r.text, { voiceCommands: s.voiceCommands, speechMs: analysis.speechMs });
      if (!text) {
        this.fail('Didn’t catch that');
        return;
      }
      const transcribeMs = r.process_ms;
      let polished: Awaited<ReturnType<DictationCleanup['polish']>> | null = null;
      if (this.d.cleanup?.ready()) {
        this.phase = 'refining';
        this.d.overlay.send({ type: 'refine' });
        this.emit('phase', this.phase);
        polished = await this.d.cleanup.polish(text, s.language === 'auto' ? r.language || 'auto' : s.language);
        if (session !== this.session) return; // cancelled meanwhile
        log.info(`dictation ${session}: cleanup ${polished.outcome} in ${polished.ms} ms`);
      }
      const original = text;
      if (polished) text = polished.text;
      const sameTarget = !!this.target.handle && this.target.handle === this.last.handle && Date.now() - this.last.at < 15 * 60 * 1000;
      if (s.smartSpacing) text = smartSpace(text, { sameTarget, lastChar: this.last.lastChar });
      await insertText(text, { method: s.insertMethod, restoreClipboard: s.restoreClipboard }, this.d.native);
      if (session !== this.session) return;
      this.last = { handle: this.target.handle, lastChar: text.slice(-1), at: Date.now() };
      this.phase = 'idle';
      this.d.hotkey.captureEscape(false);
      this.d.overlay.send({ type: 'success', text });
      const result: DictationResult = {
        text: text.trim(),
        audioMs: Math.round((pcm.length / SAMPLE_RATE) * 1000),
        processMs: transcribeMs + (polished?.ms ?? 0),
        modelId: this.d.engine.modelId ?? '',
        at: Date.now(),
        ...(polished ? { cleanup: polished.outcome, cleanupMs: polished.ms } : {}),
        ...(polished?.outcome === 'polished' && original.trim() !== text.trim() ? { original: original.trim() } : {}),
      };
      this.history.unshift(result);
      this.history.length = Math.min(this.history.length, 25);
      log.info(`dictated ${text.length} chars in ${r.process_ms} ms (audio ${result.audioMs} ms)`);
      this.emit('result', result);
      this.emit('phase', this.phase);
    } catch (e) {
      if (session !== this.session) return;
      log.error(`transcription failed: ${(e as Error).message}`);
      this.fail('Transcription failed — open Quill for details');
    }
  }

  private clearTimer() {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }
}

/** A short, natural prompt biases Whisper toward your names and jargon and toward proper punctuation. */
export function buildPrompt(vocabulary: string): string {
  const words = vocabulary
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 40);
  return words.length ? `Glossary: ${words.join(', ')}.` : '';
}
