import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type OverlayCommand, type Settings } from '../src/shared/types';

const inserted: string[] = [];
vi.mock('../src/main/inject', () => ({
  insertText: vi.fn(async (text: string) => {
    inserted.push(text);
  }),
}));
// Every clip "has speech": these tests are about the session, not the voice detector.
vi.mock('../src/shared/audio', async (orig) => ({
  ...(await orig<typeof import('../src/shared/audio')>()),
  prepareForModel: (pcm: Float32Array) => ({ audio: pcm, analysis: { hasSpeech: true, speechMs: 2000, noiseDb: -60 } }),
}));

const { Dictation } = await import('../src/main/dictation');

type Polish = { text: string; outcome: 'polished' | 'unchanged' | 'fallback' | 'skipped'; ms: number };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(opts: { transcript?: string; cleanup?: boolean } = {}) {
  const overlay = Object.assign(new EventEmitter(), {
    sent: [] as OverlayCommand[],
    show(c: OverlayCommand) {
      this.sent.push(c);
    },
    send(c: OverlayCommand) {
      this.sent.push(c);
    },
  });
  const hotkey = Object.assign(new EventEmitter(), { activeLabel: 'Win + Space', captureEscape: vi.fn() });
  const transcripts = [opts.transcript ?? 'um so we should ship it on Friday'];
  const engine = {
    modelId: 'base.en',
    transcribe: vi.fn(async () => ({ text: transcripts.shift() ?? 'second dictation here', language: 'en', audio_ms: 2000, process_ms: 300, segments: [] })),
  };
  let pending = deferred<Polish>();
  const polish = vi.fn((_text: string, _language: string) => pending.promise);
  const cancelPolish = vi.fn(() => pending.resolve({ text: '__original__', outcome: 'skipped', ms: 5 }));
  const settings: Settings = { ...DEFAULT_SETTINGS, modelId: 'base.en', smartSpacing: false, cleanup: opts.cleanup ?? true };
  const d = new Dictation({
    overlay: overlay as never,
    engine: engine as never,
    hotkey: hotkey as never,
    native: null,
    settings: () => settings,
    theme: () => ({ dark: false, reducedMotion: null }),
    readiness: () => ({ ok: true, modelId: 'base.en' }),
    cleanup: {
      ready: () => settings.cleanup,
      polish: async (text, language) => {
        const r = await polish(text, language);
        return r.text === '__original__' ? { ...r, text } : r;
      },
      cancel: cancelPolish,
    },
  });
  const speak = async () => {
    d.start();
    d.finish();
    overlay.emit('audio', new Float32Array(32000).fill(0.1));
    await vi.waitFor(() => expect(engine.transcribe).toHaveBeenCalled());
  };
  return {
    d,
    overlay,
    engine,
    polish,
    cancelPolish,
    speak,
    resolvePolish: (r: Polish) => pending.resolve(r),
    nextPolish: () => (pending = deferred<Polish>()),
    types: () => overlay.sent.map((c) => c.type),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('dictation with cleanup', () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  it('inserts the polished text after the refine phase', async () => {
    const t = setup();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalledWith('um so we should ship it on Friday', 'en'));
    expect(t.types()).toContain('refine');
    t.resolvePolish({ text: 'So we should ship it on Friday.', outcome: 'polished', ms: 420 });
    await vi.waitFor(() => expect(inserted).toEqual(['So we should ship it on Friday.']));
    expect(t.d.history[0]).toMatchObject({ text: 'So we should ship it on Friday.', original: 'um so we should ship it on Friday', cleanup: 'polished', cleanupMs: 420 });
    expect(t.d.busy).toBe(false);
  });

  it('Esc while polishing inserts nothing, even if the polish finishes later', async () => {
    const t = setup();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalled());
    t.d.cancel();
    expect(t.cancelPolish).toHaveBeenCalled();
    t.resolvePolish({ text: 'Late result.', outcome: 'polished', ms: 900 });
    await settle();
    expect(inserted).toEqual([]);
    expect(t.d.busy).toBe(false);
    expect(t.types()).toContain('cancel');
  });

  it('"Insert as spoken" inserts the transcript once, without the polish', async () => {
    const t = setup();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalled());
    t.overlay.emit('action', 'skip');
    await vi.waitFor(() => expect(inserted).toEqual(['um so we should ship it on Friday']));
    t.overlay.emit('action', 'skip'); // a second click does nothing
    await settle();
    expect(inserted).toHaveLength(1);
    expect(t.d.history[0].cleanup).toBe('skipped');
    expect(t.d.history[0].original).toBeUndefined();
  });

  it('falls back to the transcript when cleanup gives up', async () => {
    const t = setup();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalled());
    t.resolvePolish({ text: 'um so we should ship it on Friday', outcome: 'fallback', ms: 4000 });
    await vi.waitFor(() => expect(inserted).toEqual(['um so we should ship it on Friday']));
    expect(t.d.history[0].cleanup).toBe('fallback');
  });

  it('keeps consecutive dictations apart', async () => {
    const t = setup();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalledTimes(1));
    // A new dictation can't start while one is still being written…
    t.d.start();
    expect(t.overlay.sent.filter((c) => c.type === 'show')).toHaveLength(1);
    t.resolvePolish({ text: 'First.', outcome: 'polished', ms: 100 });
    await vi.waitFor(() => expect(inserted).toEqual(['First.']));
    // …and the next one gets its own polish, never the previous result.
    t.nextPolish();
    t.engine.transcribe.mockClear();
    await t.speak();
    await vi.waitFor(() => expect(t.polish).toHaveBeenCalledTimes(2));
    expect(t.polish.mock.calls[1][0]).toBe('second dictation here');
    t.resolvePolish({ text: 'Second dictation here.', outcome: 'polished', ms: 100 });
    await vi.waitFor(() => expect(inserted).toEqual(['First.', 'Second dictation here.']));
  });

  it('skips the refine phase entirely when cleanup is off', async () => {
    const t = setup({ cleanup: false });
    await t.speak();
    await vi.waitFor(() => expect(inserted).toEqual(['um so we should ship it on Friday']));
    expect(t.polish).not.toHaveBeenCalled();
    expect(t.types()).not.toContain('refine');
    expect(t.d.history[0].cleanup).toBeUndefined();
  });
});
