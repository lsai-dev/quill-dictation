// Standalone engine benchmark: load a model and transcribe a WAV, no Electron.
//
//   node test/e2e/engine-bench.mjs <engine-binary> <ggml-model.bin> <speech.wav> [threads]
//
// Prints load/warm-up/transcription timings and the transcript.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [, , bin, model, wav, threads = '0'] = process.argv;
if (!bin || !model || !wav) {
  console.error('usage: engine-bench.mjs <engine> <model> <wav> [threads]');
  process.exit(2);
}

// 16-bit PCM WAV → f32 samples.
function readWav(path) {
  const b = readFileSync(path);
  let o = 12;
  let fmt = null;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== 16000) throw new Error('need 16 kHz mono 16-bit WAV');
      const n = size / 2;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return f;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QUILL_ENGINE_LOG: 'info' } });
child.stderr.on('data', (d) => process.stderr.write(`  [engine] ${d}`));
let buf = '';
const waiters = [];
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    waiters.shift()?.(JSON.parse(line));
  }
});
const next = () => new Promise((r) => waiters.push(r));
const send = (obj, payload) => {
  const header = Buffer.from(JSON.stringify(payload ? { ...obj, bytes: payload.length } : obj) + '\n');
  child.stdin.write(payload ? Buffer.concat([header, payload]) : header);
  return next();
};

const t0 = Date.now();
const ready = await next();
console.log(`ready in ${Date.now() - t0} ms: ${ready.backend} — ${String(ready.system_info).slice(0, 140)}`);
const t1 = Date.now();
const load = await send({ id: 1, cmd: 'load', model, gpu: false, threads: Number(threads) });
console.log(`load: ${JSON.stringify(load)} (wall ${Date.now() - t1} ms)`);
const pcm = readWav(wav);
const t2 = Date.now();
const r = await send({ id: 2, cmd: 'transcribe', language: 'en', beam_size: 0 }, Buffer.from(pcm.buffer));
console.log(`transcribe: ${r.process_ms} ms for ${r.audio_ms} ms (wall ${Date.now() - t2} ms): ${r.text}`);
await send({ id: 3, cmd: 'shutdown' });
process.exit(r.ok && /country/i.test(r.text) ? 0 : 1);
