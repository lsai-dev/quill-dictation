import { formatBytes, modelById } from '../../../shared/models';
import { formatLatency } from '../../../shared/recommend';
import type { AppSnapshot } from '../../../shared/types';
import { AnyRibbon, createRibbon } from '../../ribbon';
import { api, snapshot, subscribe } from '../store';
import { h, icons, keycaps, ring, svg } from '../ui';

/**
 * First run. Four calm steps: hello → tuned to your PC → your voice → try it.
 * The ribbon is present throughout — the same object, changing with each step.
 */
export function Onboarding(hooks: { prepare: () => void; done: () => void }) {
  const canvas = h('canvas', { class: 'ob-canvas', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'ob-stage' }, canvas);
  const content = h('div', { class: 'ob-content' });
  const dots = h('div', { class: 'ob-dots', 'aria-hidden': 'true' });
  const el = h('div', { class: 'onboarding', role: 'dialog', 'aria-label': 'Welcome to Quill' }, h('div', { class: 'ob-drag' }), stage, content, dots);

  let ribbon: AnyRibbon | null = null;
  requestAnimationFrame(() => {
    try {
      ribbon = createRibbon(canvas, { viewHeight: 1.9, anchorY: 0.5, persistent: true });
      ribbon.setDark(matchMedia('(prefers-color-scheme: dark)').matches);
      ribbon.setReducedMotion(matchMedia('(prefers-reduced-motion: reduce)').matches);
      setTimeout(() => ribbon?.show(), 350);
      // Pause while a dictation runs (the "Try it" step): the overlay is the focus.
      api.onDictationPhase((phase) => (phase === 'idle' ? ribbon?.start() : ribbon?.stop()));
    } catch {
      /* WebGL unavailable: the copy carries the experience */
    }
  });

  const steps = [welcome, tuned, voice, tryIt];
  let unsub: (() => void) | null = null;
  let micStop: (() => void) | null = null;

  function go(i: number) {
    unsub?.();
    unsub = null;
    micStop?.();
    dots.replaceChildren(...steps.map((_, j) => h('i', { class: j === i ? 'on' : '' })));
    el.dataset.step = String(i);
    const next = steps[i]();
    content.classList.add('leaving');
    setTimeout(() => {
      content.replaceChildren(next);
      content.classList.remove('leaving');
      content.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => content.classList.remove('entering')));
      (next.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
    }, content.childElementCount ? 260 : 0);
  }

  function finish() {
    micStop?.();
    unsub?.();
    void api.setSettings({ onboarded: true });
    ribbon?.success();
    hooks.prepare();
    el.classList.add('done');
    setTimeout(() => {
      ribbon?.dispose();
      ribbon = null;
      el.remove();
      hooks.done();
    }, 700);
  }

  // ── Step 1 ─────────────────────────────────────────────────────────────────
  function welcome() {
    return h(
      'div',
      { class: 'ob-step' },
      h('h1', { class: 'ob-title' }, 'Quill'),
      h('p', { class: 'ob-lede' }, 'Your voice, written — instantly and privately.'),
      h('p', { class: 'ob-body' }, 'Press a shortcut, speak naturally, and your words appear wherever you type. Everything happens on this PC.'),
      h('div', { class: 'ob-actions' }, h('button', { class: 'btn primary large', type: 'button', onClick: () => go(1) }, 'Get Started')),
    );
  }

  // ── Step 2: hardware & recommendation ─────────────────────────────────────
  function tuned() {
    const list = h('ul', { class: 'ob-scan' });
    const rec = h('div', { class: 'ob-rec' });
    const actions = h('div', { class: 'ob-actions' });
    const step = h('div', { class: 'ob-step' }, h('h1', { class: 'ob-title small' }, 'Tuned to your PC'), h('p', { class: 'ob-body' }, 'Quill looked at your hardware to pick the best voice model for it.'), list, rec, actions);

    const s0 = snapshot();
    const hw = s0.hardware;
    const lines: [string, string][] = hw
      ? [
          [icons.cpu, hw.cpu.brand.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').replace(/\d+-Core/i, '').replace(/\s+/g, ' ').trim()],
          [icons.memory, `${formatBytes(hw.totalMemory)} memory`],
          [icons.gpu, (hw.gpus.find((g) => !g.integrated) ?? hw.gpus[0])?.name ?? 'No dedicated graphics'],
        ]
      : [[icons.cpu, 'Your processor']];
    lines.forEach(([icon, text], i) => {
      const li = h('li', { style: `animation-delay:${160 + i * 220}ms` }, svg(icon, 'icon'), h('span', null, text), svg(icons.check, 'icon ok'));
      list.append(li);
    });

    let downloading = false;
    let shownFor = '';
    unsub = subscribe((s) => renderRec(s));
    function renderRec(s: AppSnapshot) {
      const r = s.recommendations?.recommended;
      if (!r) return;
      const m = modelById(r.modelId)!;
      const st = s.models.find((x) => x.id === m.id);
      const dl = s.downloads.find((d) => d.modelId === m.id);
      // Build the card once (it animates in); afterwards only the actions change.
      if (shownFor !== m.id) {
        shownFor = m.id;
        rec.replaceChildren(
        h('div', { class: 'ob-rec-card', style: `animation-delay:${200 + lines.length * 220}ms` },
          h('div', { class: 'pick-goal' }, svg(icons.sparkle, 'icon tiny'), 'Recommended'),
          h('div', { class: 'ob-rec-name' }, m.name),
          h('p', { class: 'ob-rec-reason' }, r.reason),
          h('div', { class: 'chips' }, h('span', { class: 'chip' }, formatBytes(m.sizeBytes) + ' download'), h('span', { class: 'chip' }, formatBytes(m.memoryBytes) + ' memory'), h('span', { class: 'chip' }, formatLatency(r.estimate.latencySec)))),
        );
      }
      if (st?.installed) {
        actions.replaceChildren(h('button', { class: 'btn primary large', type: 'button', onClick: () => go(2) }, 'Continue'));
      } else if (dl || downloading) {
        const ringEl = ring(20);
        ringEl.set(dl && dl.total ? dl.received / dl.total : 0);
        actions.replaceChildren(
          h('div', { class: 'ob-progress' }, ringEl.el, h('span', null, dl ? `Downloading ${Math.floor((dl.received / Math.max(1, dl.total)) * 100)}%` : 'Starting download…')),
          h('button', { class: 'btn large', type: 'button', onClick: () => go(2) }, 'Continue While It Downloads'),
        );
      } else {
        actions.replaceChildren(
          h('button', {
            class: 'btn primary large',
            type: 'button',
            onClick: async () => {
              downloading = true;
              renderRec(snapshot());
              const res = await api.downloadModel(m.id);
              downloading = false;
              if (!res.ok) actions.prepend(h('p', { class: 'ob-error' }, res.error ?? 'Download failed'));
            },
          }, svg(icons.download, 'icon small'), `Download ${m.name}`),
        );
      }
    }
    return step;
  }

  // ── Step 3: microphone ─────────────────────────────────────────────────────
  function voice() {
    const note = h('p', { class: 'ob-note' }, 'Say a few words — the ribbon follows your voice.');
    const step = h(
      'div',
      { class: 'ob-step' },
      h('h1', { class: 'ob-title small' }, 'Say hello'),
      h('p', { class: 'ob-body' }, 'Quill listens only while you hold or tap the shortcut, and you’ll always see when the microphone is on.'),
      note,
      h('div', { class: 'ob-actions' }, h('button', { class: 'btn primary large', type: 'button', onClick: () => go(3) }, 'Continue')),
    );
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        let heard = false;
        const timer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (const x of buf) s += x * x;
          const db = 10 * Math.log10(s / buf.length + 1e-12);
          ribbon?.setLevel(db);
          if (!heard && db > -38) {
            heard = true;
            note.replaceChildren(svg(icons.check, 'icon small ok'), 'Sounds great.');
            note.classList.add('ok');
          }
        }, 16);
        micStop = () => {
          clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          ribbon?.setEnergy(0);
          micStop = null;
        };
      } catch {
        note.textContent = 'Quill can’t reach the microphone. Allow access in Windows Settings › Privacy & security › Microphone.';
        note.classList.add('warn');
      }
    })();
    return step;
  }

  // ── Step 4: try it ─────────────────────────────────────────────────────────
  function tryIt() {
    const area = h('textarea', { class: 'ob-try', rows: 3, placeholder: 'Click here, then press the shortcut and speak…', 'aria-label': 'Practice area' });
    const wait = h('p', { class: 'ob-note' });
    const s = snapshot();
    const step = h(
      'div',
      { class: 'ob-step' },
      h('h1', { class: 'ob-title small' }, 'Try it'),
      h('div', { class: 'ob-keys' }, keycaps(s.settings.hotkey)),
      h('p', { class: 'ob-body' }, 'Press the shortcut, say something, then press it again — or just hold it while you talk.'),
      area,
      wait,
      h('div', { class: 'ob-actions' }, h('button', { class: 'btn primary large', type: 'button', onClick: finish }, 'Done')),
    );
    unsub = subscribe((snap) => {
      const id = snap.settings.modelId;
      const dl = snap.downloads.find((d) => d.state === 'downloading');
      if (dl) wait.textContent = `Your model is still downloading (${Math.floor((dl.received / Math.max(1, dl.total)) * 100)}%). Dictation will work as soon as it finishes.`;
      else if (!id) wait.textContent = 'Choose a model first — you can do this any time in Models.';
      else if (snap.engine.state === 'loading') wait.textContent = 'Getting the model ready…';
      else wait.textContent = '';
      if (snap.history.length && !area.value) area.value = snap.history[0].text;
    });
    setTimeout(() => area.focus(), 400);
    return step;
  }

  go(0);
  return el;
}
