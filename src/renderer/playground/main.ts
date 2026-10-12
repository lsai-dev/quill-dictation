import { createRibbon } from '../ribbon';

const canvas = document.getElementById('ribbon') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const params = new URLSearchParams(location.search);

// The overlay is 300 × 136 logical px; the playground shows it magnified.
function applyScale(scale: number) {
  stage.style.setProperty('--w', `${300 * scale}px`);
  stage.style.setProperty('--h', `${136 * scale}px`);
}
const scaleInput = document.getElementById('scale') as HTMLInputElement;
scaleInput.value = params.get('scale') ?? scaleInput.value;
applyScale(Number(scaleInput.value));

const ribbon = createRibbon(canvas, { viewHeight: 2.3 * 1.0, anchorY: 0.6, persistent: params.has('persistent') });
(window as any).ribbon = ribbon;
const stateEl = document.getElementById('state')!;
ribbon.onStateChange = (s) => (stateEl.textContent = s);

const bg = document.getElementById('bg') as HTMLSelectElement;
const setBg = (v: string) => {
  document.body.dataset.bg = v;
  ribbon.setDark(v !== 'light');
};
bg.value = params.get('bg') ?? 'light';
setBg(bg.value);
bg.onchange = () => setBg(bg.value);
scaleInput.oninput = () => applyScale(Number(scaleInput.value));

document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
  b.onclick = () => (ribbon as any)[b.dataset.act!]();
});

const voice = document.getElementById('voice') as HTMLInputElement;
voice.oninput = () => ribbon.setEnergy(Number(voice.value));

// Synthetic speech: syllable bursts with phrase-level loudness changes.
let speakOn = false;
const speak = document.getElementById('speak') as HTMLInputElement;
speak.onchange = () => (speakOn = speak.checked);
function speechEnvelope(t: number) {
  const phrase = 0.55 + 0.45 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1);
  const syll = Math.max(0, Math.sin(t * 2 * Math.PI * 3.6) * 0.8 + Math.sin(t * 2 * Math.PI * 1.7 + 2) * 0.5);
  const pause = Math.sin(t * 0.9) > -0.6 ? 1 : 0;
  return Math.min(1, phrase * syll * pause);
}
(window as any).speechEnvelope = speechEnvelope;
setInterval(() => {
  if (speakOn) ribbon.setEnergy(speechEnvelope(performance.now() / 1000));
}, 16);

const reduced = document.getElementById('reduced') as HTMLInputElement;
reduced.onchange = () => ribbon.setReducedMotion(reduced.checked);

const mic = document.getElementById('mic') as HTMLInputElement;
let stopMic: (() => void) | null = null;
mic.onchange = async () => {
  if (!mic.checked) { stopMic?.(); return; }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const id = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const x of buf) s += x * x;
    ribbon.setLevel(10 * Math.log10(s / buf.length + 1e-12));
  }, 16);
  stopMic = () => { clearInterval(id); stream.getTracks().forEach((t) => t.stop()); ctx.close(); };
};

if (params.has('auto')) ribbon.show();
