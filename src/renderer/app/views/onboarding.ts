import { formatBytes } from '../../../shared/models';
import { formatLatency } from '../../../shared/recommend';
import type { AppSnapshot } from '../../../shared/types';
import { AnyRibbon, createRibbon } from '../../ribbon';
import { addsLatency, downloadLabel, etaText, modelName, setupState } from '../setup';
import { api, snapshot, subscribe } from '../store';
import { h, icons, keycaps, progressBar, reducedMotion, svg, toggle } from '../ui';
import { CleanupExample } from './example';

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
      ribbon.setReducedMotion(reducedMotion());
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

  // ── Step 2: hardware & the recommended setup ──────────────────────────────
  function tuned() {
    const list = h('ul', { class: 'ob-scan' });
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
      list.append(h('li', { style: `animation-delay:${160 + i * 200}ms` }, svg(icon, 'icon'), h('span', null, text), svg(icons.check, 'icon ok')));
    });

    // The plan, as two quiet lines: what each part does and which model does it.
    const dName = h('span', { class: 'ob-model' });
    const dMeta = h('span', { class: 'ob-meta' });
    const cName = h('span', { class: 'ob-model' });
    const cMeta = h('span', { class: 'ob-meta' });
    let cleanupOn = !!s0.setup?.cleanupId;
    const sw = toggle(cleanupOn, (on) => {
      cleanupOn = on;
      if (on) example.play();
      render(snapshot());
    }, 'Cleanup');
    const example = CleanupExample();
    example.el.classList.add('compact');
    const exampleWrap = h('div', { class: 'unfold open' }, h('div', { class: 'unfold-inner' }, example.el));
    const cleanupRow = h(
      'div',
      { class: 'ob-role' },
      h('span', { class: 'role-glyph', 'aria-hidden': 'true' }, svg(icons.sparkle)),
      h('div', { class: 'ob-role-body' }, h('div', { class: 'ob-role-line' }, h('span', { class: 'ob-role-name' }, 'Cleanup'), cName, cMeta), h('p', { class: 'ob-role-what' }, 'Polishes your words while preserving meaning.')),
      sw,
    );
    const card = h(
      'div',
      { class: 'ob-setup', style: `animation-delay:${200 + lines.length * 200}ms` },
      h(
        'div',
        { class: 'ob-role' },
        h('span', { class: 'role-glyph', 'aria-hidden': 'true' }, svg(icons.mic)),
        h('div', { class: 'ob-role-body' }, h('div', { class: 'ob-role-line' }, h('span', { class: 'ob-role-name' }, 'Dictation'), dName, dMeta), h('p', { class: 'ob-role-what' }, 'Turns your voice into text.')),
      ),
      h('div', { class: 'role-sep', 'aria-hidden': 'true' }),
      cleanupRow,
      exampleWrap,
    );

    const bar = progressBar('Download progress');
    const progressNote = h('p', { class: 'ob-progress-note' });
    const progress = h('div', { class: 'unfold ob-progress' }, h('div', { class: 'unfold-inner' }, h('div', null, bar.el, progressNote)));
    const message = h('p', { class: 'ob-error', role: 'alert' });
    const actions = h('div', { class: 'ob-actions' });
    const note = h('p', { class: 'ob-fine' });
    const step = h(
      'div',
      { class: 'ob-step' },
      h('h1', { class: 'ob-title small' }, 'Tuned to your PC'),
      h('p', { class: 'ob-body' }, 'Quill looked at your hardware and chose a setup that runs entirely on it.'),
      list,
      card,
      progress,
      message,
      actions,
      note,
    );

    let actionsKey = '';
    unsub = subscribe((s) => render(s));
    function render(s: AppSnapshot) {
      const st = setupState(s, cleanupOn);
      const dEst = s.recommendations?.estimates.find((e) => e.modelId === st.dictationId);
      dName.textContent = modelName(st.dictationId);
      dMeta.textContent = dEst ? formatLatency(dEst.latencySec) : '';
      const offered = !!st.cleanupId;
      cleanupRow.classList.toggle('off', !st.cleanupOn);
      sw.disabled = !offered;
      sw.checked = st.cleanupOn;
      exampleWrap.classList.toggle('open', offered && st.cleanupOn);
      example.setLanguage(s.settings.language);
      if (offered) {
        const cEst = s.setup?.cleanupEstimates.find((e) => e.modelId === st.cleanupId);
        cName.textContent = modelName(st.cleanupId);
        cMeta.textContent = cEst ? addsLatency(cEst.latencySec) + (s.setup?.cleanupId ? '' : ' here') : '';
      } else {
        cName.textContent = '';
        cMeta.textContent = 'Not available on this PC';
      }

      const d = st.downloading;
      progress.classList.toggle('open', !!d);
      if (d) {
        bar.set(d.total ? d.received / d.total : 0, d.state === 'verifying');
        const n = st.needed.length > 1 ? `${st.needed.indexOf(d.modelId) + 1} of ${st.needed.length}: ` : '';
        progressNote.textContent = `${n}${modelName(d.modelId)} · ${formatBytes(d.received)} of ${formatBytes(d.total)} · ${etaText(d)}`;
      }
      message.textContent = st.failed ? st.failed.error ?? 'The download didn’t finish.' : '';
      message.hidden = !st.failed;

      const dictationReady = !!s.models.find((m) => m.id === st.dictationId)?.installed;
      const mode = d ? 'downloading' : st.failed ? 'failed' : st.needed.length ? 'download' : 'done';
      const key = `${mode}|${dictationReady}|${downloadLabel(st)}`;
      if (key === actionsKey) return;
      actionsKey = key;
      const start = async () => {
        await api.setSettings({ cleanup: st.cleanupOn, ...(st.cleanupOn && st.cleanupId ? { cleanupModelId: st.cleanupId } : {}) });
        void api.downloadModels(st.needed);
      };
      if (mode === 'downloading') {
        actions.replaceChildren(
          h('button', { class: 'btn primary large', type: 'button', onClick: () => go(2) }, dictationReady ? 'Continue' : 'Continue While It Downloads'),
          h('button', { class: 'btn large subtle', type: 'button', onClick: () => api.cancelDownload(d!.modelId) }, 'Cancel'),
        );
        note.textContent = '';
      } else if (mode === 'failed') {
        actions.replaceChildren(
          h('button', { class: 'btn primary large', type: 'button', onClick: start }, st.failed!.received > 0 ? 'Resume Download' : 'Try Again'),
          ...(dictationReady ? [h('button', { class: 'btn large subtle', type: 'button', onClick: () => go(2) }, 'Continue Without Cleanup')] : []),
        );
        note.textContent = '';
      } else if (mode === 'download') {
        actions.replaceChildren(h('button', { class: 'btn primary large', type: 'button', onClick: start }, svg(icons.download, 'icon small'), downloadLabel(st)));
        note.textContent = 'Downloaded once, verified, and run entirely on this PC. You can change models any time.';
      } else {
        actions.replaceChildren(h('button', { class: 'btn primary large', type: 'button', onClick: async () => {
          await api.setSettings({ cleanup: st.cleanupOn, ...(st.cleanupOn && st.cleanupId ? { cleanupModelId: st.cleanupId } : {}) });
          go(2);
        } }, 'Continue'));
        note.textContent = '';
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
      else if (snap.settings.cleanup && snap.cleanupEngine.state === 'ready') wait.textContent = 'Cleanup is on: Quill will tidy fillers and punctuation before inserting.';
      else wait.textContent = '';
      if (snap.history.length && !area.value) area.value = snap.history[0].text;
    });
    setTimeout(() => area.focus(), 400);
    return step;
  }

  go(0);
  return el;
}
