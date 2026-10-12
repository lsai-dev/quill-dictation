import { createRibbon } from '../ribbon';
import type { OverlayCommand } from '../../shared/types';
import { MicCapture, micErrorMessage } from './capture';
import { sounds } from './sounds';

const api = window.quillOverlay;
const canvas = document.getElementById('ribbon') as HTMLCanvasElement;
const statusEl = document.getElementById('status')!;
const labelEl = document.getElementById('label')!;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const skipBtn = document.getElementById('skip') as HTMLButtonElement;

// The ribbon sits in the upper part of the window; the status pill below it.
const ribbon = createRibbon(canvas, { viewHeight: 2.5, anchorY: 0.6 });
const capture = new MicCapture();
const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');

let soundsOn = true;
let recording = false;
/** Whether the current session still wants the microphone (guards slow device start-up). */
let wantMic = false;
let active = false;
let motionPref: boolean | null = null;

capture.onLevel = (db) => ribbon.setLevel(db);

function applyMotion() {
  ribbon.setReducedMotion(motionPref ?? systemReduced.matches);
}
systemReduced.addEventListener('change', applyMotion);

function setDark(dark: boolean) {
  document.body.classList.toggle('dark', dark);
  ribbon.setDark(dark);
}

let labelTimer = 0;
function setStatus(text: string | null, opts: { recording?: boolean } = {}) {
  statusEl.classList.toggle('recording', !!opts.recording);
  if (text === null) {
    statusEl.classList.remove('visible');
    return;
  }
  statusEl.classList.add('visible');
  if (labelEl.textContent === text) return;
  // Cross-fade the words, never jump.
  clearTimeout(labelTimer);
  labelEl.classList.add('swap');
  labelTimer = window.setTimeout(() => {
    labelEl.textContent = text;
    labelEl.classList.remove('swap');
  }, 130);
}

function setActive(on: boolean) {
  active = on;
  document.body.classList.toggle('active', on);
  if (!on) setHover(false);
}

// Place controls on the ribbon's centre line.
function layout() {
  const [, y] = ribbon.renderer.toScreen([0, 0.02, 0]);
  document.documentElement.style.setProperty('--ry', `${Math.round(y)}px`);
}
new ResizeObserver(layout).observe(document.body);

// ── Hover: the window is click-through except over the ribbon and controls ──
let hovering = false;
function setHover(on: boolean) {
  if (on === hovering) return;
  hovering = on;
  document.body.classList.toggle('hover', on);
  api?.hover(on);
}
function inHotArea(x: number, y: number) {
  if (!active) return false;
  const w = window.innerWidth;
  const ry = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ry')) || 58;
  const inRibbon = Math.abs(x - w / 2) < 96 && Math.abs(y - ry) < 36;
  const inControls = hovering && Math.abs(y - ry) < 22 && (x < 72 || x > w - 72);
  const inBand = hovering && Math.abs(y - ry) < 30; // moving between ribbon and buttons
  return inRibbon || inControls || inBand;
}
window.addEventListener('mousemove', (e) => setHover(inHotArea(e.clientX, e.clientY)));
document.addEventListener('mouseleave', () => setHover(false));

stopBtn.addEventListener('click', () => api?.action('stop'));
cancelBtn.addEventListener('click', () => api?.action('cancel'));
skipBtn.addEventListener('click', () => api?.action('skip'));

ribbon.onHidden = () => {
  setActive(false);
  setStatus(null);
  api?.hidden();
};

let starting: Promise<void> | null = null;
async function startCapture(deviceId: string) {
  wantMic = true;
  const run = (async () => {
    try {
      await capture.start(deviceId);
      recording = true;
      // Stopped or cancelled while the device was opening: release it.
      if (!wantMic) {
        capture.abort();
        recording = false;
      }
    } catch (e) {
      recording = false;
      if (wantMic) api?.micError(micErrorMessage(e));
    }
  })();
  starting = run;
  await run;
}

function handle(c: OverlayCommand) {
  switch (c.type) {
    case 'show': {
      soundsOn = c.sounds;
      motionPref = c.reducedMotion;
      setDark(c.dark);
      applyMotion();
      setActive(true);
      layout();
      document.body.classList.remove('no-stop', 'refining');
      ribbon.show();
      if (c.microphoneId === 'none') return; // setup message follows
      setStatus('Listening', { recording: true });
      if (soundsOn) sounds.start();
      void startCapture(c.microphoneId);
      break;
    }
    case 'stop': {
      document.body.classList.add('no-stop');
      setStatus('Transcribing');
      if (soundsOn) sounds.stop();
      ribbon.process();
      void (async () => {
        // If the microphone is still opening, let it finish so we return what it heard.
        if (starting) await starting;
        wantMic = false;
        const pcm = recording ? await capture.stop() : new Float32Array(0);
        recording = false;
        api?.sendAudio(pcm);
      })();
      break;
    }
    case 'process':
      document.body.classList.add('no-stop');
      setStatus('Transcribing');
      ribbon.process();
      break;
    case 'refine':
      // The same object, still working: the label and the light change, the motion carries on.
      document.body.classList.add('no-stop', 'refining');
      setStatus('Polishing');
      ribbon.refine();
      break;
    case 'success':
      document.body.classList.remove('refining');
      if (soundsOn) sounds.inserted();
      setStatus(null);
      ribbon.success();
      break;
    case 'cancel':
      document.body.classList.remove('refining');
      wantMic = false;
      if (recording) capture.abort();
      recording = false;
      setStatus(null);
      ribbon.cancel();
      break;
    case 'error':
      document.body.classList.remove('refining');
      wantMic = false;
      if (recording) capture.abort();
      recording = false;
      if (soundsOn) sounds.error();
      setStatus(c.message);
      ribbon.error(Math.min(3200, 1300 + c.message.length * 35));
      break;
    case 'hint':
      setStatus(c.message, { recording });
      break;
    case 'theme':
      motionPref = c.reducedMotion;
      setDark(c.dark);
      applyMotion();
      break;
  }
}

if (api) {
  api.onCommand(handle);
  api.ready();
  // Lets the engine leave CPU headroom when the ribbon is drawn in software.
  api.rendererInfo({ software: ribbon.software });
} else {
  // Opened directly in a browser: a self-running demo.
  (window as unknown as { demo: typeof handle }).demo = handle;
  setDark(matchMedia('(prefers-color-scheme: dark)').matches);
}
