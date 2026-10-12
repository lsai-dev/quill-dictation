import { CLEANUP_MODELS, cleanupModelById, cleanupSupports } from '../../../shared/cleanupModels';
import { formatBytes, MODELS, modelById } from '../../../shared/models';
import { formatLatency, recommendSetup } from '../../../shared/recommend';
import type { AppSnapshot, CleanupEstimate, ModelEstimate } from '../../../shared/types';
import { addsLatency, downloadLabel, etaText, modelName, modelSize, setupState, type SetupState } from '../setup';
import { api, snapshot, subscribe } from '../store';
import { disclosure, h, icons, progressBar, svg, toggle } from '../ui';
import { CleanupExample } from './example';

/**
 * Models: one recommended setup — Dictation and Cleanup — with its readiness and the
 * one thing to do next. Alternatives and technical details unfold on request.
 */
export function ModelsView() {
  const readiness = h('span', { class: 'readiness', role: 'status', 'aria-live': 'polite' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'readiness-text' }));
  const setupTitle = h('h2', { class: 'setup-title', id: 'setup-title' }, 'Your setup');
  const setupSub = h('p', { class: 'setup-sub' });

  const dictation = RoleRow('dictation', 'Dictation', 'Turns your voice into text.', icons.mic);
  const cleanup = RoleRow('cleanup', 'Cleanup', 'Polishes your words while preserving meaning.', icons.sparkle);
  const cleanupSwitch = toggle(false, (on) => void setCleanup(on), 'Cleanup');
  cleanup.side.prepend(cleanupSwitch);
  const example = CleanupExample();
  const exampleWrap = h('div', { class: 'unfold example-unfold' }, h('div', { class: 'unfold-inner' }, example.el));

  const dictChoices = Choices('dictation');
  const cleanChoices = Choices('cleanup');
  dictation.change.addEventListener('click', () => openChoices(dictChoices, dictation.change));
  cleanup.change.addEventListener('click', () => openChoices(cleanChoices, cleanup.change));

  const foot = SetupFoot();
  const card = h(
    'article',
    { class: 'card setup', 'aria-labelledby': 'setup-title' },
    h('header', { class: 'setup-head' }, h('div', null, setupTitle, setupSub), readiness),
    dictation.el,
    dictChoices.el,
    h('div', { class: 'role-sep', 'aria-hidden': 'true' }),
    cleanup.el,
    cleanChoices.el,
    exampleWrap,
    foot.el,
  );

  const pc = h('div', { class: 'pc-panel' });
  const pcDisclosure = disclosure('This PC', pc);
  const el = h(
    'section',
    { class: 'view models' },
    h('header', { class: 'view-head' }, h('h1', null, 'Models'), h('p', { class: 'subtitle' }, 'Everything runs on this PC. Quill chose the setup that suits it best.')),
    card,
    pcDisclosure.el,
  );

  let open: ReturnType<typeof Choices> | null = null;
  function openChoices(c: ReturnType<typeof Choices>, trigger: HTMLButtonElement) {
    const next = open === c ? null : c;
    for (const x of [dictChoices, cleanChoices]) x.setOpen(x === next);
    dictation.change.setAttribute('aria-expanded', String(next === dictChoices));
    cleanup.change.setAttribute('aria-expanded', String(next === cleanChoices));
    dictation.change.textContent = next === dictChoices ? 'Done' : 'Change';
    cleanup.change.textContent = next === cleanChoices ? 'Done' : 'Change';
    open = next;
    if (next) next.focusSelected();
    else trigger.focus({ preventScroll: true });
  }

  async function setCleanup(on: boolean) {
    const s = snapshot();
    const st = setupState(s, on);
    await api.setSettings({ cleanup: on, ...(on && !s.settings.cleanupModelId && st.cleanupId ? { cleanupModelId: st.cleanupId } : {}) });
    if (on) example.play();
  }

  subscribe((s) => {
    const st = setupState(s);
    const ready = st.readiness === 'ready';
    setupTitle.textContent = st.needed.length && !s.models.some((m) => m.installed && modelById(m.id)) ? 'Recommended for this PC' : 'Your setup';
    setupSub.textContent = s.recommendations ? `Tuned for your ${s.recommendations.device === 'gpu' ? s.recommendations.deviceLabel.split(' · ')[0] : s.recommendations.deviceLabel}.` : 'Looking at your hardware…';
    renderReadiness(readiness, st, s);

    // Dictation
    const isInstalled = (id: string) => !!s.models.find((m) => m.id === id)?.installed;
    const sizeNote = (id: string) => (isInstalled(id) ? '' : ` · ${formatBytes(modelSize(id))} download`);
    const dEst = s.recommendations?.estimates.find((e) => e.modelId === st.dictationId);
    dictation.set(modelName(st.dictationId), `${dEst ? capital(formatLatency(dEst.latencySec)) : ''}${sizeNote(st.dictationId)}`.replace(/^ · /, ''), progressFor(s, st.dictationId));

    // Cleanup
    const cEst = s.setup?.cleanupEstimates.find((e) => e.modelId === st.cleanupId);
    const offered = !!st.cleanupId;
    cleanupSwitch.checked = s.settings.cleanup && offered;
    cleanupSwitch.disabled = !offered;
    cleanup.el.classList.toggle('off', !cleanupSwitch.checked);
    cleanup.el.classList.toggle('unavailable', !offered);
    if (offered) {
      cleanup.set(modelName(st.cleanupId), `${cEst ? capital(addsLatency(cEst.latencySec)) : ''}${sizeNote(st.cleanupId!)}`.replace(/^ · /, ''), progressFor(s, st.cleanupId!));
    } else {
      cleanup.set('Not available on this PC', s.setup?.reason ?? '', null);
    }
    if (offered && !s.setup?.cleanupId && !s.settings.cleanup) {
      // Runs here, but slowly: offered honestly, off unless you choose it.
      cleanup.set(modelName(st.cleanupId), s.setup?.reason ?? '', progressFor(s, st.cleanupId!));
    }
    cleanup.change.hidden = !offered;
    exampleWrap.classList.toggle('open', offered);
    example.setLanguage(s.settings.language);

    dictChoices.update(s, st);
    cleanChoices.update(s, st);
    foot.update(s, st);
    renderPc(pc, s);
    card.dataset.ready = String(ready);
  });

  return el;
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function progressFor(s: AppSnapshot, id: string) {
  return s.downloads.find((d) => d.modelId === id && (d.state === 'downloading' || d.state === 'verifying')) ?? null;
}

function renderReadiness(el: HTMLElement, st: SetupState, s: AppSnapshot) {
  const text = el.querySelector('.readiness-text') as HTMLElement;
  let label: string;
  switch (st.readiness) {
    case 'ready':
      label = 'Ready';
      break;
    case 'downloading':
      label = 'Downloading';
      break;
    case 'loading':
      label = 'Getting ready';
      break;
    case 'attention':
      label = 'Needs attention';
      break;
    default:
      label = s.models.some((m) => m.installed && modelById(m.id)) ? 'Download needed' : 'Not downloaded';
  }
  el.dataset.state = st.readiness;
  if (text.textContent !== label) text.textContent = label;
}

// ── A role: Dictation or Cleanup ───────────────────────────────────────────
function RoleRow(role: 'dictation' | 'cleanup', title: string, what: string, icon: string) {
  const name = h('span', { class: 'role-model-name' });
  const meta = h('span', { class: 'role-model-meta' });
  const change = h('button', { class: 'link role-change', type: 'button', 'aria-expanded': 'false', 'aria-controls': `choices-${role}` }, 'Change');
  const side = h('div', { class: 'role-side' }, change);
  const el = h(
    'div',
    { class: 'role', 'data-role': role },
    h('span', { class: 'role-glyph', 'aria-hidden': 'true' }, svg(icon)),
    h(
      'div',
      { class: 'role-body' },
      h('div', { class: 'role-line' }, h('h3', { class: 'role-name' }, title), h('span', { class: 'role-what' }, what)),
      h('div', { class: 'role-model' }, name, meta),
    ),
    side,
  );
  return {
    el,
    side,
    change,
    set(model: string, detail: string, d: AppSnapshot['downloads'][number] | null) {
      if (name.textContent !== model) name.textContent = model;
      const text = d ? (d.state === 'verifying' ? 'Verifying…' : `Downloading · ${Math.floor((d.received / Math.max(1, d.total)) * 100)}%`) : detail;
      if (meta.textContent !== text) meta.textContent = text;
      el.classList.toggle('downloading', !!d);
    },
  };
}

// ── Alternatives, unfolding inside the card ────────────────────────────────
interface Row {
  id: string;
  el: HTMLElement;
  update(s: AppSnapshot, st: SetupState): void;
}

function Choices(role: 'dictation' | 'cleanup') {
  const list = h('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': role === 'dictation' ? 'Dictation models' : 'Cleanup models' });
  const marker = h('span', { class: 'choice-marker', 'aria-hidden': 'true' });
  list.append(marker);
  const more = h('button', { class: 'link choice-more', type: 'button', 'aria-expanded': 'false' });
  const note = h('p', { class: 'choice-note' });
  const inner = h('div', { class: 'unfold-inner' }, list, more, note);
  const el = h('div', { class: 'unfold choices', id: `choices-${role}`, 'data-role': role }, inner);
  let rows: Row[] = [];
  let key = '';
  let showAll = false;
  let expanded: string | null = null;
  let selected: string | null = null;

  more.addEventListener('click', () => {
    showAll = !showAll;
    more.setAttribute('aria-expanded', String(showAll));
    key = '';
    const s = snapshot();
    rebuild(s, setupState(s));
  });

  function rebuild(s: AppSnapshot, st: SetupState) {
    let ids: string[];
    if (role === 'dictation') {
      const picks = [...new Set((s.recommendations?.picks ?? []).map((p) => p.modelId))];
      const all = MODELS.filter((m) => s.settings.language === 'en' || !m.englishOnly).map((m) => m.id);
      const current = st.dictationId;
      ids = showAll ? all : [...new Set([...picks, current, ...s.models.filter((m) => m.installed && modelById(m.id)).map((m) => m.id)])].filter((id) => all.includes(id));
      ids.sort((a, b) => all.indexOf(a) - all.indexOf(b));
      more.hidden = ids.length >= all.length && !showAll;
      more.textContent = showAll ? 'Show fewer' : `Show all ${all.length} models`;
      note.textContent = s.settings.language === 'en' ? 'English-only models are a little more accurate in English. The others understand 99 languages.' : 'Showing models that understand your dictation language.';
    } else {
      ids = CLEANUP_MODELS.filter((m) => cleanupSupports(m, s.settings.language)).map((m) => m.id);
      more.hidden = true;
      const english = CLEANUP_MODELS.filter((m) => !cleanupSupports(m, s.settings.language)).map((m) => m.name);
      note.textContent = english.length ? `${english.join(' and ')} ${english.length > 1 ? 'work' : 'works'} in English only.` : 'Cleanup never sends anything anywhere: it runs on this PC like dictation.';
    }
    const nextKey = ids.join(',');
    if (nextKey === key) return;
    key = nextKey;
    rows = ids.map((id) => ChoiceRow(role, id, () => toggleExpanded(id)));
    list.replaceChildren(marker, ...rows.map((r) => r.el));
  }

  function toggleExpanded(id: string) {
    expanded = expanded === id ? null : id;
    for (const r of rows) {
      const on = r.id === expanded;
      r.el.classList.toggle('expanded', on);
      r.el.querySelector('.choice-main')!.setAttribute('aria-expanded', String(on));
    }
  }

  // The selection marker glides to the chosen row.
  function placeMarker() {
    const row = rows.find((r) => r.id === selected)?.el;
    if (!row || !el.classList.contains('open')) {
      marker.style.opacity = '0';
      return;
    }
    const main = row.querySelector('.choice-main') as HTMLElement;
    marker.style.opacity = '1';
    marker.style.transform = `translateY(${row.offsetTop}px)`;
    marker.style.height = `${main.offsetHeight}px`;
  }
  new ResizeObserver(placeMarker).observe(list);

  return {
    el,
    setOpen(on: boolean) {
      el.classList.toggle('open', on);
      el.toggleAttribute('inert', !on);
      requestAnimationFrame(placeMarker);
    },
    focusSelected() {
      (rows.find((r) => r.id === selected)?.el.querySelector('.choice-main') as HTMLElement | null)?.focus({ preventScroll: true });
    },
    update(s: AppSnapshot, st: SetupState) {
      rebuild(s, st);
      selected = role === 'dictation' ? st.dictationId : st.cleanupId;
      for (const r of rows) r.update(s, st);
      requestAnimationFrame(placeMarker);
    },
  };
}

function ChoiceRow(role: 'dictation' | 'cleanup', id: string, onToggle: () => void): Row {
  const w = modelById(id);
  const c = cleanupModelById(id);
  const name = w?.name ?? c!.name;
  const tag = h('span', { class: 'choice-tag' });
  const meta = h('span', { class: 'choice-meta' });
  const radio = h('span', { class: 'choice-radio', 'aria-hidden': 'true' });
  const main = h(
    'button',
    { class: 'choice-main', type: 'button', role: 'radio', 'aria-expanded': 'false', onClick: onToggle },
    radio,
    h('span', { class: 'choice-name' }, name, tag),
    meta,
    svg(icons.chevron, 'icon small choice-chevron'),
  );
  const facts = h('dl', { class: 'facts' });
  const actions = h('div', { class: 'choice-actions' });
  const details = h('div', { class: 'choice-details' }, h('div', { class: 'choice-details-inner' }, h('p', { class: 'choice-blurb' }, w?.blurb ?? c!.blurb), facts, actions));
  const el = h('div', { class: 'choice', 'data-id': id }, main, details);
  let factsKey = '';

  return {
    id,
    el,
    update(s, st) {
      const installed = !!s.models.find((m) => m.id === id)?.installed;
      const current = role === 'dictation' ? st.dictationId === id : st.cleanupId === id;
      const inUse = current && installed && (role === 'dictation' || st.cleanupOn);
      const dl = s.downloads.find((d) => d.modelId === id);
      const wEst: ModelEstimate | undefined = w ? s.recommendations?.estimates.find((e) => e.modelId === id) : undefined;
      const cEst: CleanupEstimate | undefined = c ? s.setup?.cleanupEstimates.find((e) => e.modelId === id) : undefined;
      const recommended = role === 'dictation' ? s.setup?.dictationId === id || s.recommendations?.recommended.modelId === id : s.setup?.cleanupId === id;
      const goal = w ? s.recommendations?.picks.find((p) => p.modelId === id && p.goal !== 'balanced') : undefined;

      main.setAttribute('aria-checked', String(current));
      el.classList.toggle('current', current);
      tag.textContent = recommended ? 'Recommended' : goal ? goal.title : '';
      tag.hidden = !tag.textContent;

      const fits = w ? (wEst?.fits ?? true) : (cEst?.fits ?? true) && (cEst?.supported ?? true);
      let metaText: string;
      if (dl && dl.state !== 'error') metaText = `${Math.floor((dl.received / Math.max(1, dl.total)) * 100)}%`;
      else if (!fits && !installed) metaText = 'Too large for this PC';
      else if (w && wEst) metaText = `${capital(formatLatency(wEst.latencySec))} · ${formatBytes(w.sizeBytes)}`;
      else if (c && cEst) metaText = `${capital(addsLatency(cEst.latencySec))} · ${formatBytes(c.sizeBytes)}`;
      else metaText = formatBytes(modelSize(id));
      if (installed && !dl) metaText += ' · Downloaded';
      meta.textContent = metaText;
      main.setAttribute('aria-label', `${name}${tag.textContent ? `, ${tag.textContent}` : ''}, ${metaText}${current ? ', selected' : ''}`);

      const nextFacts = JSON.stringify([installed, wEst?.device, cEst?.device, s.settings.language]);
      if (nextFacts !== factsKey) {
        factsKey = nextFacts;
        const fact = (k: string, v: string) => [h('dt', null, k), h('dd', null, v)];
        const rows = w
          ? [
              ...fact('Accuracy', accuracyWords(w.accuracy)),
              ...fact('Languages', w.englishOnly ? 'English' : '99 languages'),
              ...fact('Runs on', wEst?.device === 'gpu' ? 'Graphics card' : 'Processor'),
              ...fact('Memory', `About ${formatBytes(w.memoryBytes)}`),
              ...fact('Download', `${formatBytes(w.sizeBytes)} · ${w.quant === 'f16' ? 'Full precision' : 'Compressed'}`),
              ...fact('Source', 'whisper.cpp (OpenAI Whisper), MIT'),
            ]
          : [
              ...fact('Made by', c!.maker),
              ...fact('Languages', c!.languages === 'all' ? 'English, Spanish and 199 more' : c!.languages.length === 1 ? 'English' : `${c!.languages.length} languages, including English and Spanish`),
              ...fact('Runs on', cEst?.device === 'gpu' ? 'Graphics card' : 'Processor'),
              ...fact('Memory', `About ${formatBytes(c!.memoryBytes)}`),
              ...fact('Download', `${formatBytes(c!.sizeBytes)} · ${c!.file}`),
              ...fact('License', c!.license),
            ];
        facts.replaceChildren(...rows);
      }

      const acts: HTMLElement[] = [];
      if (dl && dl.state !== 'error') {
        acts.push(h('button', { class: 'btn', type: 'button', onClick: () => api.cancelDownload(id) }, 'Cancel Download'));
      } else if (inUse) {
        acts.push(h('span', { class: 'in-use' }, svg(icons.check, 'icon small'), 'In use'));
      } else if (installed) {
        acts.push(h('button', { class: 'btn primary', type: 'button', onClick: () => (role === 'dictation' ? api.useModel(id) : api.useCleanupModel(id)) }, 'Use This Model'));
      } else if (fits) {
        acts.push(
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onClick: async () => {
                if (role === 'cleanup') await api.setSettings({ cleanupModelId: id, cleanup: true });
                const r = await api.downloadModel(id);
                if (r.ok && role === 'dictation') await api.useModel(id);
              },
            },
            svg(icons.download, 'icon small'),
            `Download · ${formatBytes(modelSize(id))}`,
          ),
        );
      }
      if (installed && !inUse && !dl) {
        acts.push(h('button', { class: 'btn subtle', type: 'button', onClick: () => api.deleteModel(id) }, 'Remove from This PC'));
      }
      if (c) acts.push(h('a', { class: 'link small', href: c.licenseUrl, target: '_blank', rel: 'noreferrer' }, 'License'));
      actions.replaceChildren(...acts);
    },
  };
}

function accuracyWords(acc: number) {
  if (acc >= 93) return 'Excellent';
  if (acc >= 86) return 'Very good';
  if (acc >= 78) return 'Good';
  if (acc >= 68) return 'Everyday';
  return 'Basic';
}

// ── The one thing to do next ───────────────────────────────────────────────
function SetupFoot() {
  const bar = progressBar();
  const cancel = h('button', { class: 'btn foot-cancel', type: 'button' }, 'Cancel');
  const progressNote = h('p', { class: 'foot-note' });
  const progressLine = h('div', { class: 'unfold foot-progress' }, h('div', { class: 'unfold-inner' }, h('div', null, h('div', { class: 'foot-bar' }, bar.el, cancel), progressNote)));
  const primary = h('button', { class: 'btn primary large foot-primary', type: 'button' });
  const secondary = h('button', { class: 'btn large foot-secondary', type: 'button' });
  const reset = h('button', { class: 'link foot-reset', type: 'button' }, 'Use Recommended Setup');
  const note = h('p', { class: 'foot-note' });
  const problem = h('p', { class: 'foot-problem', role: 'alert' });
  const actions = h('div', { class: 'foot-actions' }, primary, secondary, reset);
  const el = h('footer', { class: 'setup-foot' }, problem, progressLine, actions, note);
  let cancelAction: () => void = () => undefined;
  cancel.addEventListener('click', () => cancelAction());
  let action: () => void = () => undefined;
  let secondaryAction: () => void = () => undefined;
  primary.addEventListener('click', () => action());
  secondary.addEventListener('click', () => secondaryAction());
  // Back to the recommendation without breaking what works: download what's missing
  // first, and switch once it's here.
  reset.addEventListener('click', async () => {
    const s = snapshot();
    if (!s.hardware) return;
    const st = setupState(s);
    const rec = recommendSetup(s.hardware, s.settings.language, s.settings.engine);
    const ids = [rec.dictationId, ...(st.cleanupOn && rec.cleanupId ? [rec.cleanupId] : [])];
    const missing = ids.filter((id) => !s.models.find((m) => m.id === id)?.installed);
    if (missing.length && !(await api.downloadModels(missing)).ok) return;
    await api.useModel(rec.dictationId);
    if (st.cleanupOn && rec.cleanupId) await api.useCleanupModel(rec.cleanupId);
  });

  return {
    el,
    update(_s: AppSnapshot, st: SetupState) {
      el.dataset.state = st.readiness;
      problem.textContent = st.problem ?? '';
      problem.hidden = !st.problem;
      reset.hidden = !st.custom || st.readiness === 'downloading';
      let showPrimary = true;
      let showSecondary = false;
      let noteText = '';

      if (st.readiness === 'downloading' && st.downloading) {
        const d = st.downloading;
        bar.set(d.total ? d.received / d.total : 0, d.state === 'verifying');
        const step = st.needed.length > 1 ? `${st.needed.indexOf(d.modelId) + 1} of ${st.needed.length}: ` : '';
        progressNote.textContent = `${step}${modelName(d.modelId)} · ${formatBytes(d.received)} of ${formatBytes(d.total)} · ${etaText(d)}`;
        showPrimary = false;
        cancelAction = () => api.cancelDownload(d.modelId);
      } else if (st.failed) {
        primary.textContent = st.failed.received > 0 ? 'Resume Download' : 'Try Again';
        action = () => void api.downloadModels(st.needed);
        showSecondary = true;
        secondary.textContent = 'Not Now';
        const failedId = st.failed.modelId;
        secondaryAction = () => api.dismissDownload(failedId);
        noteText = st.failed.received > 0 ? `${formatBytes(st.failed.received)} is already here — Quill picks up where it stopped.` : '';
      } else if (st.needed.length) {
        primary.textContent = downloadLabel(st);
        action = () => void api.downloadModels(st.needed);
        noteText = 'Downloaded once, verified, and run entirely on this PC.';
      } else if (st.readiness === 'attention') {
        primary.textContent = 'Try Again';
        action = () => void api.retryModels();
      } else if (st.readiness === 'loading') {
        showPrimary = false;
        noteText = 'Loading your models — this takes a few seconds after they’re downloaded or changed.';
      } else {
        primary.textContent = 'Try It Now';
        primary.classList.remove('primary');
        action = () => void api.startDictation();
        noteText = '';
      }
      if (st.readiness !== 'ready') primary.classList.add('primary');
      primary.hidden = !showPrimary;
      secondary.hidden = !showSecondary;
      progressLine.classList.toggle('open', st.readiness === 'downloading');
      progressLine.inert = st.readiness !== 'downloading';
      actions.hidden = !showPrimary && !showSecondary && reset.hidden;
      note.textContent = noteText;
      note.hidden = !noteText;
    },
  };
}

// ── This PC ────────────────────────────────────────────────────────────────
function renderPc(el: HTMLElement, s: AppSnapshot) {
  const hw = s.hardware;
  if (!hw) {
    el.replaceChildren(h('p', { class: 'muted' }, 'Looking at your hardware…'));
    return;
  }
  const key = JSON.stringify([hw.cpu.brand, hw.totalMemory, s.recommendations?.device, s.setup?.dictationId, s.setup?.cleanupId, s.settings.modelId, s.settings.cleanupModelId, s.settings.cleanup]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const gpu = hw.gpus.find((g) => !g.integrated) ?? hw.gpus[0];
  const rec = s.recommendations;
  const cpuName = hw.cpu.brand.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').replace(/\s+/g, ' ').replace(/\d+-Core/i, '').trim();
  const item = (icon: string, label: string, value: string, detail: string, active: boolean) =>
    h('div', { class: `pc-item ${active ? 'active' : ''}` }, svg(icon, 'icon pc-icon'), h('div', null, h('div', { class: 'pc-label' }, label), h('div', { class: 'pc-value' }, value), h('div', { class: 'pc-detail' }, detail)));
  const st = setupState(s);
  const cEst = s.setup?.cleanupEstimates.find((e) => e.modelId === st.cleanupId);
  const dModel = modelById(st.dictationId);
  const cModel = st.cleanupOn ? cleanupModelById(st.cleanupId) : undefined;

  // Where the memory goes: each model on the device it runs on.
  const onGpu = (rec?.device === 'gpu' ? dModel?.memoryBytes ?? 0 : 0) + (cModel && cEst?.device === 'gpu' ? cModel.memoryBytes : 0);
  const onCpu = (rec?.device === 'cpu' ? dModel?.memoryBytes ?? 0 : 0) + (cModel && cEst?.device !== 'gpu' ? cModel.memoryBytes : 0);
  const plan = h('div', { class: 'mem-plan' });
  const bar = (label: string, total: number, parts: [string, number, string][]) => {
    const used = parts.reduce((a, p) => a + p[1], 0);
    return h(
      'div',
      { class: 'mem-row' },
      h('div', { class: 'mem-head' }, h('span', null, label), h('span', { class: 'dim' }, `${formatBytes(used)} of ${formatBytes(total)}`)),
      h('div', { class: 'mem-bar', role: 'img', 'aria-label': `${label}: ${parts.map((p) => `${p[0]} ${formatBytes(p[1])}`).join(', ')}, of ${formatBytes(total)}` },
        ...parts.filter((p) => p[1] > 0).map(([, bytes, cls]) => h('i', { class: cls, style: `width:${Math.min(100, (bytes / Math.max(total, 1)) * 100).toFixed(2)}%` }))),
      h('div', { class: 'mem-legend' }, ...parts.filter((p) => p[1] > 0).map(([name, bytes, cls]) => h('span', null, h('i', { class: cls }), `${name} ${formatBytes(bytes)}`))),
    );
  };
  if (onGpu && gpu) plan.append(bar(`${gpu.name} memory`, gpu.vramBytes, [['Dictation', rec?.device === 'gpu' ? dModel?.memoryBytes ?? 0 : 0, 'd'], ['Cleanup', cModel && cEst?.device === 'gpu' ? cModel.memoryBytes : 0, 'c']]));
  if (onCpu) plan.append(bar('System memory', hw.totalMemory, [['Dictation', rec?.device === 'cpu' ? dModel?.memoryBytes ?? 0 : 0, 'd'], ['Cleanup', cModel && cEst?.device !== 'gpu' ? cModel.memoryBytes : 0, 'c']]));

  el.replaceChildren(
    h(
      'div',
      { class: 'pc-grid' },
      item(icons.cpu, 'Processor', cpuName, `${hw.cpu.physicalCores} cores · ${hw.cpu.logicalCores} threads`, rec?.device === 'cpu'),
      item(icons.memory, 'Memory', formatBytes(hw.totalMemory), `${formatBytes(hw.availableMemory)} free now`, false),
      item(icons.gpu, 'Graphics', gpu ? gpu.name : 'Not detected', gpu ? (gpu.integrated ? 'Built into the processor' : `${formatBytes(gpu.vramBytes)}${hw.vulkan ? '' : ' · driver update needed'}`) : 'Quill uses your processor', rec?.device === 'gpu'),
    ),
    plan,
    h('p', { class: 'pc-summary' }, rec?.summary ?? '', s.setup?.cleanup ? ` ${s.setup.reason}` : ''),
    h('button', { class: 'link', type: 'button', onClick: () => api.openModelsFolder() }, svg(icons.folder, 'icon small'), 'Show Models Folder'),
  );
}
