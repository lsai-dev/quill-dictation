// End-to-end: real Electron app, real engine, real model, real speech.
//
//   QUILL_MODEL=/path/ggml-tiny.en.bin QUILL_AUDIO=/path/speech.wav \
//     xvfb-run -a node test/e2e/dictation.e2e.mjs
//
// Chromium plays QUILL_AUDIO as the microphone. The test starts a dictation,
// lets it listen, finishes it, and checks that the transcript came back and
// was pasted into a focused text field.
import { _electron as electron } from 'playwright';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const model = process.env.QUILL_MODEL;
const audio = process.env.QUILL_AUDIO;
const expect = (process.env.QUILL_EXPECT ?? 'country').toLowerCase();
const shots = process.env.QUILL_SHOTS;
if (!model || !audio) {
  console.error('Set QUILL_MODEL and QUILL_AUDIO');
  process.exit(2);
}

const userData = mkdtempSync(join(tmpdir(), 'quill-e2e-'));
mkdirSync(join(userData, 'models'), { recursive: true });
const file = basename(model);
copyFileSync(model, join(userData, 'models', file));
const modelId = file.replace(/^ggml-/, '').replace(/\.bin$/, '');
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ onboarded: true, modelId, language: 'en', sounds: false }));

const app = await electron.launch({
  cwd: resolve('.'),
  args: ['.', '--no-sandbox', `--user-data-dir=${userData}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${resolve(audio)}`],
  env: { ...process.env, QUILL_E2E: '1', QUILL_DEBUG: '1' },
  timeout: 60000,
});
const output = [];
app.process().stdout?.on('data', (d) => output.push(String(d)));
app.process().stderr?.on('data', (d) => output.push(String(d)));
// Diagnostic screenshots are best-effort: the overlay hides itself as a
// dictation ends, and a capture of a window that hides mid-way never completes.
const shot = async (page, name) => {
  if (!shots || !page) return;
  await page.screenshot({ path: join(shots, name), timeout: 5000 }).catch((e) => console.log(`· ${name} not captured: ${e.message.split('\n')[0]}`));
};
const fail = async (msg) => {
  console.error('✗', msg);
  const status = await app.evaluate(() => globalThis.__quill?.engine.status).catch(() => null);
  console.error('  engine status:', JSON.stringify(status));
  await shot(app.windows().find((w) => w.url().includes('overlay.html')), 'e2e-failure.png');
  console.error('  app log (tail):');
  for (const line of output.join('').split(/\r?\n/).filter((l) => l.trim() && !/dbus|Fontconfig/.test(l)).slice(-60)) console.error('   ', line);
  try {
    if (shots) copyFileSync(join(userData, 'logs', 'quill.log'), join(shots, 'quill.log'));
  } catch {
    console.error('  (no quill.log in the test profile)');
  }
  await app.close().catch(() => undefined);
  process.exit(1);
};
const main = (fn, arg) => app.evaluate(fn, arg);
const poll = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fail(`timed out waiting for ${label}`);
};

await poll(() => app.windows().length >= 2, 20000, 'windows');
const appWin = app.windows().find((w) => w.url().includes('app.html'));
const overlay = app.windows().find((w) => w.url().includes('overlay.html'));
overlay.on('console', (m) => output.push(`[overlay ${m.type()}] ${m.text()}\n`));
overlay.on('pageerror', (e) => output.push(`[overlay error] ${e.message}\n`));

const status = await poll(async () => {
  const s = await main(() => globalThis.__quill?.engine.status);
  if (s?.state === 'error') return fail(`engine error: ${s.message}`);
  return s?.state === 'ready' ? s : null;
}, 120000, 'engine ready');
console.log(`✓ engine ready: ${status.modelId} on ${status.device} (${status.loadMs} ms)`);
const hw = await main(() => {
  const { hardware, recs } = globalThis.__quill.hardware();
  const q = globalThis.__quill;
  return { cpu: hardware?.cpu.brand, avx2: hardware?.cpu.avx2, gpus: hardware?.gpus.map((g) => g.name), source: hardware?.source, pick: recs?.recommended.modelId, device: recs?.device, hotkeyNative: q.hotkey.usingNative, hotkeyError: q.hotkey.error };
});
console.log(`✓ hardware: ${JSON.stringify(hw)}`);
if (process.platform === 'win32' && !hw.hotkeyNative) await fail(`Win+Space hook not active: ${hw.hotkeyError}`);

// A focused text field to dictate into.
await appWin.evaluate(() => {
  const t = document.createElement('textarea');
  t.id = 'e2e-target';
  Object.assign(t.style, { position: 'fixed', inset: '80px', zIndex: 99, fontSize: '16px' });
  document.body.append(t);
  t.focus();
});
await appWin.bringToFront();

await main(() => globalThis.__quill.dictation.start());
await new Promise((r) => setTimeout(r, 1500));
await shot(overlay, 'e2e-listening.png');
await new Promise((r) => setTimeout(r, Number(process.env.QUILL_LISTEN_MS ?? 10000)));
await main(() => globalThis.__quill.dictation.finish());
await new Promise((r) => setTimeout(r, 300));
await shot(overlay, 'e2e-processing.png');

const result = await poll(() => main(() => globalThis.__quill.dictation.history[0] ?? null), 180000, 'transcript');
console.log(`✓ transcript (${result.processMs} ms for ${result.audioMs} ms of audio): "${result.text}"`);
if (!result.text.toLowerCase().includes(expect)) await fail(`transcript does not contain "${expect}"`);

const pasted = await poll(async () => (await appWin.evaluate(() => document.getElementById('e2e-target').value)) || null, 5000, 'pasted text').catch(() => null);
if (pasted) console.log(`✓ pasted into the focused field: "${pasted.trim().slice(0, 80)}…"`);
else console.log('· paste not observed (no input injection available on this system)');

await app.close();
console.log('✓ end-to-end dictation passed');
