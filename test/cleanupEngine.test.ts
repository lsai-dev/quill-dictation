import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LineProcess } from '../src/main/lineProcess';
// @ts-expect-error — a plain ESM fixture without type declarations
import { tinyGguf } from './fixtures/tiny-gguf.mjs';

/*
 * The real cleanup sidecar against a tiny random model. Runs when the binary has been
 * built (`npm run build:native`, or QUILL_CLEANUP_BIN); skipped otherwise.
 */
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = [
  process.env.QUILL_CLEANUP_BIN,
  resolve(__dirname, `../resources/bin/quill-cleanup-cpu${exe}`),
  resolve(__dirname, `../native/target-cleanup/release/quill-cleanup${exe}`),
].find((p) => p && existsSync(p));

const seg = (text: string, special = false) => ({ text, special });
const prefix = [seg('<|im_start|>', true), seg('system\nYou clean up dictated text.'), seg('<|im_end|>', true), seg('\n')];
const prompt = (t: string) => [seg('<|im_start|>', true), seg(`user\n${t}`), seg('<|im_end|>', true), seg('\n'), seg('<|im_start|>', true), seg('assistant\n')];

interface Cleaned {
  text: string;
  stop: string;
  cached_tokens: number;
  generated_tokens: number;
  drafted_tokens: number;
  accepted_tokens: number;
}

describe.skipIf(!bin)('cleanup sidecar', () => {
  let p: LineProcess;
  const model = join(mkdtempSync(join(tmpdir(), 'quill-cleanup-')), 'tiny.gguf');

  beforeAll(async () => {
    writeFileSync(model, tinyGguf());
    p = new LineProcess('cleanup', bin!, []);
    const ready = await p.start();
    expect(ready.backend).toBe('cpu');
    const loaded = await p.request<{ recurrent: boolean; device: string }>('load', { model, threads: 2 }, undefined, 30000);
    expect(loaded).toMatchObject({ device: 'CPU', recurrent: !!process.env.QUILL_CLEANUP_SNAPSHOT });
  });
  afterAll(async () => {
    await p?.stop();
  });

  const clean = (t: string, lookup: string, maxTokens = 48) =>
    p.request<Cleaned>('clean', { prefix, prompt: prompt(t), lookup, max_tokens: maxTokens }, undefined, 30000);

  it('rejects files that are not GGUF models without losing the loaded one', async () => {
    const bogus = model + '.txt';
    writeFileSync(bogus, 'not a model');
    await expect(p.request('load', { model: bogus }, undefined, 30000)).rejects.toThrow(/not a GGUF model/);
    await expect(p.request('load', { model: model + '.missing' }, undefined, 30000)).rejects.toThrow(/failed to open/);
    const info = await p.request<{ model: string }>('info');
    expect(info.model).toBe(model);
  });

  it('caches the instruction prefix between requests', async () => {
    const primed = await p.request<{ prefix_tokens: number }>('prime', { prefix });
    expect(primed.prefix_tokens).toBeGreaterThan(10);
    const r = await clean('hello there', '');
    expect(r.cached_tokens).toBe(primed.prefix_tokens);
  });

  it('drafting from the transcript never changes the result, only the speed', async () => {
    const plain = await clean('so um we should go', '');
    expect(plain.stop).toBe('limit');
    expect(plain.drafted_tokens).toBe(0);
    // Fed its own output as the "transcript", the model accepts long drafts…
    const own = await clean('so um we should go', plain.text);
    expect(own.text).toBe(plain.text);
    if (process.env.QUILL_CLEANUP_SNAPSHOT) {
      // …unless it's recurrent: those can't rewind, so they never draft.
      expect(own.drafted_tokens).toBe(0);
      return;
    }
    expect(own.accepted_tokens).toBeGreaterThan(plain.generated_tokens / 2);
    // …and with a damaged copy it rejects some, rewinds, and still matches exactly.
    const damaged = plain.text.replace(/(.{5})./g, '$1~');
    const mixed = await clean('so um we should go', damaged);
    expect(mixed.text).toBe(plain.text);
    expect(mixed.drafted_tokens).toBeGreaterThan(mixed.accepted_tokens);
  });

  it('stops at a stop string', async () => {
    const plain = await clean('stop test', '', 40);
    const marker = plain.text.slice(10, 13);
    const r = await p.request<Cleaned>('clean', { prefix, prompt: prompt('stop test'), lookup: '', max_tokens: 40, stop: [marker] });
    expect(r.stop).toBe('stop');
    expect(r.text).toBe(plain.text.slice(0, plain.text.indexOf(marker)));
  });

  it('cancels a running request promptly and stays usable', async () => {
    const long = p.send<Cleaned>('clean', { prefix, prompt: prompt('a long one'), lookup: '', max_tokens: 3500 }, undefined, 60000);
    await new Promise((r) => setTimeout(r, 20));
    await p.request('cancel', { target: long.id });
    const started = Date.now();
    await expect(long.done).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(1500);
    const after = await clean('hello there', '');
    expect(after.generated_tokens).toBeGreaterThan(0);
    // The cached instructions survive a cancellation: no re-reading them.
    expect(after.cached_tokens).toBeGreaterThan(10);
  });

  it('refuses prompts that would overflow the context', async () => {
    await expect(clean('x'.repeat(9000), '', 100)).rejects.toThrow(/too long/);
  });
});
