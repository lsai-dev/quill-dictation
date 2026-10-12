import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { LineProcess } from '../src/main/lineProcess';
import { buildPrompt } from '../src/main/dictation';

const fake = () => new LineProcess('fake', process.execPath, [resolve(__dirname, 'fixtures/fake-sidecar.mjs')]);

describe('LineProcess', () => {
  it('handshakes, matches responses to requests and ignores non-protocol output', async () => {
    const p = fake();
    const ready = await p.start();
    expect(ready.version).toBe('test');
    const events: unknown[] = [];
    p.on('event', (e) => events.push(e));
    const r = await p.request<{ pong: boolean }>('ping');
    expect(r.pong).toBe(true);
    expect(events).toContainEqual({ event: 'hotkey', state: 'down' });
    await p.stop();
  });

  it('sends binary payloads intact, even when requests overlap', async () => {
    const p = fake();
    await p.start();
    const a = new Float32Array(48000).fill(0.5);
    const b = new Float32Array([1, 2, 3]);
    const [ra, rb] = await Promise.all([
      p.request<{ n: number; sum: number }>('sum', {}, Buffer.from(a.buffer)),
      p.request<{ n: number; sum: number }>('sum', {}, Buffer.from(b.buffer)),
    ]);
    expect(ra).toMatchObject({ n: 48000, sum: 24000 });
    expect(rb).toMatchObject({ n: 3, sum: 6 });
    await p.stop();
  });

  it('surfaces errors and rejects pending requests when the process dies', async () => {
    const p = fake();
    await p.start();
    await expect(p.request('nope')).rejects.toThrow(/unknown command/);
    await expect(p.request('crash')).rejects.toThrow(/stopped unexpectedly/);
    expect(p.running).toBe(false);
  });
});

describe('buildPrompt', () => {
  it('turns a vocabulary list into a short glossary prompt', () => {
    expect(buildPrompt('')).toBe('');
    expect(buildPrompt('Kubernetes, Quill,\n Anthropic')).toBe('Glossary: Kubernetes, Quill, Anthropic.');
  });
});
