import { formatBytes, MODELS, modelById } from '../../../shared/models';
import { formatLatency } from '../../../shared/recommend';
import type { AppSnapshot, DownloadProgress, ModelEstimate, ModelSpec, Recommendation } from '../../../shared/types';
import { api, subscribe } from '../store';
import { h, icons, ring, svg } from '../ui';

const GOAL_ICON: Record<Recommendation['goal'], string> = {
  balanced: icons.sparkle,
  accuracy: icons.target,
  speed: icons.bolt,
  memory: icons.feather,
};

export function ModelsView() {
  const pc = h('div', { class: 'card pc' });
  const picks = h('div', { class: 'picks' });
  const list = h('div', { class: 'card list models-list' });
  const langNote = h('p', { class: 'muted small' });

  const el = h(
    'section',
    { class: 'view models' },
    h('header', { class: 'view-head' }, h('h1', null, 'Models'), h('p', { class: 'subtitle' }, 'Quill runs speech recognition entirely on this PC. These suggestions are tuned to your hardware.')),
    h('h2', { class: 'group-title' }, 'Your PC'),
    pc,
    h('h2', { class: 'group-title' }, 'Recommended for this PC'),
    picks,
    h('div', { class: 'section-head' }, h('h2', { class: 'group-title' }, 'All Models'), h('button', { class: 'link', type: 'button', onClick: () => api.openModelsFolder() }, svg(icons.folder, 'icon small'), 'Show in Folder')),
    langNote,
    list,
  );

  const rows = new Map<string, ReturnType<typeof ModelRow>>();
  let lastKey = '';

  subscribe((s) => {
    renderPc(pc, s);
    const key = JSON.stringify([s.settings.language, s.settings.engine, s.recommendations?.picks.map((p) => p.modelId), s.recommendations?.device]);
    if (key !== lastKey) {
      lastKey = key;
      // One card per model; a model that wins several goals carries all their labels.
      const groups = new Map<string, Recommendation[]>();
      for (const p of s.recommendations?.picks ?? []) groups.set(p.modelId, [...(groups.get(p.modelId) ?? []), p]);
      picks.replaceChildren(...[...groups.values()].map((g) => PickCard(g)));
      picks.dataset.count = String(groups.size);
      rows.clear();
      const visible = MODELS.filter((m) => s.settings.language === 'en' || !m.englishOnly);
      list.replaceChildren(...visible.map((m) => {
        const r = ModelRow(m);
        rows.set(m.id, r);
        return r.el;
      }));
      langNote.textContent = s.settings.language === 'en' ? 'English-only models are slightly more accurate for English. Multilingual models understand 99 languages.' : 'Showing multilingual models for your dictation language.';
    }
    picks.querySelectorAll<HTMLElement>('[data-pick]').forEach((card) => updatePick(card, s));
    for (const [id, r] of rows) r.update(s, s.recommendations?.estimates.find((e) => e.modelId === id));
  });

  return el;
}

function renderPc(el: HTMLElement, s: AppSnapshot) {
  const hw = s.hardware;
  if (!hw) {
    el.replaceChildren(h('p', { class: 'muted' }, 'Looking at your hardware…'));
    return;
  }
  const gpu = hw.gpus.find((g) => !g.integrated) ?? hw.gpus[0];
  const rec = s.recommendations;
  const item = (icon: string, label: string, value: string, detail: string, active = false) =>
    h('div', { class: `pc-item ${active ? 'active' : ''}` }, svg(icon, 'icon pc-icon'), h('div', null, h('div', { class: 'pc-label' }, label), h('div', { class: 'pc-value' }, value), h('div', { class: 'pc-detail' }, detail)));
  const cpuName = hw.cpu.brand.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').replace(/\s+/g, ' ').replace(/\d+-Core/i, '').trim();
  const features = [hw.cpu.avx512 ? 'AVX-512' : hw.cpu.avx2 ? 'AVX2' : hw.cpu.neon ? 'NEON' : 'Basic vector support'];
  el.replaceChildren(
    h(
      'div',
      { class: 'pc-grid' },
      item(icons.cpu, 'Processor', cpuName, `${hw.cpu.physicalCores} cores · ${hw.cpu.logicalCores} threads · ${features.join(', ')}`, rec?.device === 'cpu'),
      item(icons.memory, 'Memory', formatBytes(hw.totalMemory), `${formatBytes(hw.availableMemory)} available now`),
      item(
        icons.gpu,
        'Graphics',
        gpu ? gpu.name : 'Not detected',
        gpu ? (gpu.integrated ? 'Integrated graphics' : `${formatBytes(gpu.vramBytes)} video memory${hw.vulkan ? '' : ' · driver update needed'}`) : 'Quill will use your processor',
        rec?.device === 'gpu',
      ),
    ),
    h('p', { class: 'pc-summary' }, rec?.summary ?? ''),
  );
}

function PickCard(group: Recommendation[]) {
  const p = group[0];
  const m = modelById(p.modelId)!;
  const action = h('div', { class: 'pick-action' });
  const card = h(
    'article',
    { class: `card pick ${p.goal === 'balanced' ? 'featured' : ''}`, 'data-pick': p.modelId, 'data-goal': p.goal },
    h('div', { class: 'pick-head' }, svg(GOAL_ICON[p.goal], 'icon pick-icon'), h('span', { class: 'pick-goal' }, group.map((g) => g.title).join(' · '))),
    h('h3', { class: 'pick-model' }, m.name),
    h('p', { class: 'pick-reason' }, p.reason),
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip' }, svg(icons.bolt, 'icon tiny'), `≈ ${p.estimate.latencySec.toFixed(p.estimate.latencySec < 1 ? 1 : 1)} s`),
      h('span', { class: 'chip' }, svg(icons.memory, 'icon tiny'), formatBytes(m.memoryBytes)),
      h('span', { class: 'chip' }, svg(icons.download, 'icon tiny'), formatBytes(m.sizeBytes)),
    ),
    action,
  );
  return card;
}

function updatePick(card: HTMLElement, s: AppSnapshot) {
  const id = card.dataset.pick!;
  const action = card.querySelector('.pick-action') as HTMLElement;
  action.replaceChildren(modelAction(id, s, card.dataset.goal === 'balanced'));
}

function modelAction(id: string, s: AppSnapshot, prominent: boolean): HTMLElement {
  const st = s.models.find((m) => m.id === id);
  const dl = s.downloads.find((d) => d.modelId === id && d.state === 'downloading');
  const inUse = s.settings.modelId === id && st?.installed;
  const m = modelById(id)!;
  if (dl) return progressButton(dl);
  if (inUse) {
    const ready = s.engine.state === 'ready' && s.engine.modelId === id;
    return h('span', { class: 'in-use' }, svg(icons.check, 'icon small'), ready ? 'In Use' : s.engine.state === 'loading' ? 'Loading…' : 'Selected');
  }
  if (st?.installed) return h('button', { class: `btn ${prominent ? 'primary' : ''}`, type: 'button', onClick: () => api.useModel(id) }, 'Use');
  return h(
    'button',
    {
      class: `btn ${prominent ? 'primary' : ''}`,
      type: 'button',
      onClick: async (e: Event) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        const r = await api.downloadModel(id);
        if (!r.ok && r.error) alertSoft(r.error);
      },
    },
    svg(icons.download, 'icon small'),
    `Download · ${formatBytes(m.sizeBytes)}`,
  );
}

function progressButton(d: DownloadProgress) {
  const r = ring(18);
  r.set(d.total ? d.received / d.total : 0);
  const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
  const eta = d.bytesPerSec > 0 ? Math.max(1, Math.round((d.total - d.received) / d.bytesPerSec)) : null;
  return h(
    'button',
    { class: 'btn progress', type: 'button', title: 'Cancel download', onClick: () => api.cancelDownload(d.modelId) },
    r.el,
    h('span', null, d.state === 'verifying' ? 'Verifying…' : `${pct}%${eta ? ` · ${eta < 60 ? `${eta}s` : `${Math.round(eta / 60)} min`} left` : ''}`),
  );
}

function ModelRow(m: ModelSpec) {
  const meta = h('div', { class: 'row-meta' });
  const action = h('div', { class: 'row-action' });
  const del = h('button', { class: 'icon-btn subtle', type: 'button', 'aria-label': `Delete ${m.name}`, title: 'Delete', onClick: () => api.deleteModel(m.id) }, svg(icons.trash));
  const el = h(
    'div',
    { class: 'row model-row' },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, m.name, m.englishOnly ? h('span', { class: 'tag' }, 'English') : h('span', { class: 'tag' }, '99 languages')), h('p', { class: 'row-sub' }, m.blurb), meta),
    h('div', { class: 'row-side' }, action, del),
  );
  return {
    el,
    update(s: AppSnapshot, est?: ModelEstimate) {
      const st = s.models.find((x) => x.id === m.id);
      del.hidden = !st?.installed;
      meta.replaceChildren(
        accuracyMeter(m.accuracy),
        h('span', { class: `rating ${est?.rating ?? ''}` }, ratingText(est)),
        h('span', { class: 'dim' }, `${formatBytes(m.sizeBytes)} download · ${formatBytes(m.memoryBytes)} memory`),
      );
      action.replaceChildren(est && !est.fits && !st?.installed ? h('span', { class: 'muted small' }, 'Too large for this PC') : modelAction(m.id, s, false));
    },
  };
}

function accuracyMeter(acc: number) {
  const filled = Math.max(1, Math.min(5, Math.round((acc - 55) / 8.5)));
  return h('span', { class: 'meter', title: 'Accuracy', 'aria-label': `Accuracy ${filled} of 5` }, ...Array.from({ length: 5 }, (_, i) => h('i', { class: i < filled ? 'on' : '' })), h('span', { class: 'meter-label' }, 'Accuracy'));
}

function ratingText(e?: ModelEstimate) {
  if (!e) return '';
  switch (e.rating) {
    case 'great':
      return `Runs great · ${formatLatency(e.latencySec)}`;
    case 'good':
      return `Runs well · ≈ ${e.latencySec.toFixed(1)} s`;
    case 'slow':
      return `Slow on this PC · ≈ ${Math.round(e.latencySec)} s`;
    default:
      return 'Needs more memory';
  }
}

function alertSoft(msg: string) {
  const t = h('div', { class: 'toast', role: 'alert' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 4200);
}
