import { modelById } from '../../../shared/models';
import { formatLatency } from '../../../shared/recommend';
import type { AppSnapshot } from '../../../shared/types';
import { AnyRibbon, createRibbon } from '../../ribbon';
import { api, subscribe } from '../store';
import { h, icons, keycaps, relativeTime, svg } from '../ui';
import { navigate } from '../router';

export function HomeView() {
  const canvas = h('canvas', { class: 'hero-canvas', 'aria-hidden': 'true' });
  const status = h('p', { class: 'hero-status' });
  const shortcut = h('div', { class: 'hero-shortcut' });
  const tryBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => api.startDictation() }, 'Try It Now');
  const micBtn = h('button', { class: 'btn', type: 'button' }, svg(icons.mic), 'Test Microphone');
  const engineLine = h('div', { class: 'engine-line' });
  const historyList = h('div', { class: 'history' });
  const historyEmpty = h('p', { class: 'muted empty' }, 'Your recent dictations will appear here. They’re kept only until you quit Quill.');

  const el = h(
    'section',
    { class: 'view home' },
    h(
      'div',
      { class: 'hero card' },
      h('div', { class: 'hero-stage' }, canvas),
      h('div', { class: 'hero-copy' }, h('h1', { class: 'hero-title' }, 'Speak, and it’s written.'), status, shortcut, h('div', { class: 'hero-actions' }, tryBtn, micBtn)),
    ),
    engineLine,
    h('div', { class: 'section-head' }, h('h2', null, 'Recent'), h('button', { class: 'link', type: 'button', onClick: () => api.clearHistory() }, 'Clear')),
    historyList,
    h('p', { class: 'privacy' }, svg(icons.lock), 'Your voice is processed entirely on this PC. Nothing is uploaded — not audio, not text.'),
  );

  // The hero ribbon: always breathing; listens to you during the mic test.
  let ribbon: AnyRibbon | null = null;
  requestAnimationFrame(() => {
    try {
      ribbon = createRibbon(canvas, { viewHeight: 2.0, anchorY: 0.5, persistent: true });
      ribbon.setDark(matchMedia('(prefers-color-scheme: dark)').matches);
      ribbon.setReducedMotion(matchMedia('(prefers-reduced-motion: reduce)').matches);
      ribbon.show();
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => ribbon?.setDark(e.matches));
    } catch {
      canvas.replaceWith(h('div', { class: 'hero-fallback' }));
    }
  });

  let micStop: (() => void) | null = null;
  micBtn.addEventListener('click', async () => {
    if (micStop) {
      micStop();
      return;
    }
    try {
      const deviceId = currentMic;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const x of buf) s += x * x;
        ribbon?.setLevel(10 * Math.log10(s / buf.length + 1e-12));
      }, 16);
      micBtn.classList.add('active');
      micBtn.lastChild!.textContent = 'Stop Test';
      micStop = () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        ribbon?.setEnergy(0);
        micBtn.classList.remove('active');
        micBtn.lastChild!.textContent = 'Test Microphone';
        micStop = null;
      };
      setTimeout(() => micStop?.(), 20000);
    } catch {
      status.textContent = 'Quill couldn’t access the microphone. Check Windows Settings › Privacy › Microphone.';
    }
  });

  let currentMic = 'default';
  let lastHotkey = '';
  subscribe((s) => {
    currentMic = s.settings.microphoneId;
    if (s.settings.hotkey !== lastHotkey) {
      lastHotkey = s.settings.hotkey;
      shortcut.replaceChildren(h('span', null, 'Press'), keycaps(s.settings.hotkey), h('span', null, 'anywhere to dictate.'));
    }
    status.textContent = statusText(s);
    tryBtn.disabled = !(s.engine.state === 'ready' || s.engine.state === 'loading');
    renderEngine(engineLine, s);
    renderHistory(historyList, historyEmpty, s);
  });

  return el;
}

function statusText(s: AppSnapshot) {
  const mode = s.settings.hotkeyMode;
  if (!s.settings.modelId) return 'Choose a voice model to get started — Quill will recommend one for this PC.';
  if (s.engine.state === 'error') return s.engine.message;
  if (mode === 'hold') return 'Hold the shortcut while you speak, and release to insert your words wherever your cursor is.';
  if (mode === 'toggle') return 'Press once to start, speak naturally, then press again to insert your words wherever your cursor is.';
  return 'Tap to start and tap again to finish — or hold while you speak. Your words appear wherever your cursor is.';
}

function renderEngine(el: HTMLElement, s: AppSnapshot) {
  const m = modelById(s.settings.modelId);
  const e = s.engine;
  const est = s.recommendations?.estimates.find((x) => x.modelId === s.settings.modelId);
  let dot = 'idle';
  let text: string;
  if (!m) {
    text = 'No model selected';
  } else if (e.state === 'ready') {
    dot = 'ready';
    const where = e.device === 'gpu' ? `on your ${s.hardware?.gpus.find((g) => !g.integrated)?.name ?? 'graphics card'}` : 'on your processor';
    text = `${m.name} is ready ${where}${est ? ` · transcribes ${formatLatency(est.latencySec)}` : ''}`;
  } else if (e.state === 'loading') {
    dot = 'loading';
    text = `Preparing ${m.name}…`;
  } else if (e.state === 'error') {
    dot = 'error';
    text = e.message;
  } else {
    text = s.models.find((x) => x.id === m.id)?.installed ? `${m.name} will load when you first dictate` : `${m.name} isn’t downloaded yet`;
  }
  el.replaceChildren(
    h('span', { class: `status-dot ${dot}`, 'aria-hidden': 'true' }),
    h('span', { class: 'engine-text' }, text),
    h('button', { class: 'link', type: 'button', onClick: () => navigate('models') }, 'Change Model', svg(icons.chevron, 'icon small')),
  );
}

function renderHistory(list: HTMLElement, empty: HTMLElement, s: AppSnapshot) {
  if (!s.history.length) {
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...s.history.slice(0, 8).map((r) => {
      const copy = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy', title: 'Copy' }, svg(icons.copy));
      copy.addEventListener('click', async () => {
        await api.copyText(r.text);
        copy.replaceChildren(svg(icons.check));
        copy.classList.add('done');
        setTimeout(() => {
          copy.replaceChildren(svg(icons.copy));
          copy.classList.remove('done');
        }, 1400);
      });
      return h(
        'div',
        { class: 'history-item' },
        h('p', { class: 'history-text' }, r.text),
        h('div', { class: 'history-meta' }, h('span', null, relativeTime(r.at)), h('span', null, `${(r.audioMs / 1000).toFixed(1)} s spoken · ${(r.processMs / 1000).toFixed(2)} s to write`), copy),
      );
    }),
  );
}
