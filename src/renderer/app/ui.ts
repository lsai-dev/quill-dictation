/** Tiny DOM helpers and controls for the Quill app window. */

type Child = Node | string | number | false | null | undefined;
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svg(markup: string, cls = 'icon'): HTMLElement {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = markup;
  return span;
}

// SF Symbols–style line icons, drawn on a 20-unit grid.
export const icons = {
  home: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1H12v-5H8v5H4.5a1 1 0 0 1-1-1z"/></svg>',
  models: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m10 2.8 6.5 3.6v7.2L10 17.2l-6.5-3.6V6.4z"/><path d="M3.8 6.6 10 10l6.2-3.4M10 10v7"/></svg>',
  settings: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></svg>',
  cpu: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5" y="5" width="10" height="10" rx="2"/><rect x="8" y="8" width="4" height="4" rx=".8"/><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5"/></svg>',
  memory: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2.5" y="6" width="15" height="8" rx="1.5"/><path d="M6 9v2M9 9v2M12 9v2M15 9v2M5 14v2M15 14v2"/></svg>',
  gpu: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2.5" y="5.5" width="15" height="9" rx="1.6"/><circle cx="12.5" cy="10" r="2.2"/><path d="M5.5 8.5h2M5.5 11.5h2M5 14.5v2"/></svg>',
  check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 10.5 3.2 3L15 6.5"/></svg>',
  download: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4.5 15.5h11"/></svg>',
  trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/></svg>',
  lock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/></svg>',
  mic: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7.5" y="3" width="5" height="9" rx="2.5"/><path d="M5 9.5a5 5 0 0 0 10 0M10 14.5V17"/></svg>',
  bolt: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M11 2.5 4.5 11H10l-1 6.5L15.5 9H10z"/></svg>',
  target: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="3.2"/><circle cx="10" cy="10" r=".6" fill="currentColor"/></svg>',
  feather: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4c-5 0-9 3-10 9l-1.5 3.5M6 13c4 0 7-2 8.5-5.5M8.5 10.5H13"/></svg>',
  sparkle: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3c.6 3.4 2.6 5.4 6 6-3.4.6-5.4 2.6-6 6-.6-3.4-2.6-5.4-6-6 3.4-.6 5.4-2.6 6-6z"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 5 5-5 5"/></svg>',
  folder: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 1.8h6A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/></svg>',
  replay: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10a5.5 5.5 0 1 0 1.7-4"/><path d="M4.2 3.5v3h3"/></svg>',
  wand: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 16.5 9-9M11 6l1.5-1.5M14.5 2.8v2M13.5 3.8h2M16.8 7.2v1.6M16 8h1.6M8 3.2v1.6M7.2 4h1.6"/></svg>',
  enter: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5v5a2 2 0 0 1-2 2h-9M7.5 8.5l-3 3 3 3"/></svg>',
};

let uid = 0;

/** A titled section that unfolds. Height animates from 0 with grid rows, so it is interruptible. */
export function disclosure(title: string, content: HTMLElement) {
  const id = `disclosure-${++uid}`;
  const btn = h('button', { class: 'disclosure-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, h('span', null, title), svg(icons.chevron, 'icon small disclosure-chevron'));
  const panel = h('div', { class: 'unfold', id }, h('div', { class: 'unfold-inner' }, content));
  panel.inert = true;
  const el = h('section', { class: 'disclosure' }, btn, panel);
  const setOpen = (on: boolean) => {
    el.classList.toggle('open', on);
    panel.classList.toggle('open', on);
    panel.inert = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.addEventListener('click', () => setOpen(!el.classList.contains('open')));
  return { el, setOpen };
}

/** A determinate progress bar (0–1). Only ever shows real progress. */
export function progressBar(label = 'Progress') {
  const fill = h('i', { class: 'bar-fill' });
  const el = h('div', { class: 'bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  return {
    el,
    set(p: number, verifying = false) {
      const v = Math.max(0, Math.min(1, p));
      fill.style.transform = `scaleX(${verifying ? 1 : v})`;
      el.setAttribute('aria-valuenow', String(Math.round((verifying ? 1 : v) * 100)));
      el.classList.toggle('verifying', verifying);
    },
  };
}

export function toggle(checked: boolean, onChange: (v: boolean) => void, label: string) {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

export function segmented<T extends string>(value: T, options: { value: T; label: string }[], onChange: (v: T) => void, label: string) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const thumb = h('span', { class: 'seg-thumb', 'aria-hidden': 'true' });
  wrap.append(thumb);
  const buttons = options.map((o) => {
    const b = h('button', { class: 'seg', role: 'radio', type: 'button', 'aria-checked': String(o.value === value) }, o.label);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      place();
      onChange(o.value);
    });
    wrap.append(b);
    return b;
  });
  const place = () => {
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const b = buttons[i];
    if (!b || !b.offsetWidth) return;
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft - 2}px)`;
  };
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(wrap);
  return wrap;
}

export function select(value: string, options: { value: string; label: string }[], onChange: (v: string) => void, label: string) {
  const s = h('select', { class: 'select', 'aria-label': label });
  for (const o of options) s.append(h('option', { value: o.value }, o.label));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

/** Circular progress ring (0–1). */
export function ring(size = 22) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const el = svg(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="2.4"/><circle class="ring-bar" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`,
    'ring',
  );
  const bar = el.querySelector('.ring-bar') as SVGCircleElement;
  return {
    el,
    set(p: number) {
      bar.style.strokeDashoffset = String(c * (1 - Math.max(0, Math.min(1, p))));
    },
  };
}

/** Keycap rendering for shortcuts: "win+space" → [⊞ Win] [Space]. */
export function keycaps(spec: string) {
  const wrap = h('span', { class: 'keycaps' });
  spec.split('+').forEach((k, i) => {
    if (i) wrap.append(h('span', { class: 'plus' }, '+'));
    const key = k.trim().toLowerCase();
    const label = key === 'win' ? 'Win' : key === 'ctrl' ? 'Ctrl' : key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
    const cap = h('kbd', { class: `key ${key === 'space' ? 'wide' : ''}` });
    if (key === 'win') cap.append(svg('<svg viewBox="0 0 12 12" width="10" height="10"><path fill="currentColor" d="M0 0h5.6v5.6H0zM6.4 0H12v5.6H6.4zM0 6.4h5.6V12H0zM6.4 6.4H12V12H6.4z"/></svg>', 'win-logo'));
    cap.append(label);
    wrap.append(cap);
  });
  return wrap;
}

export function relativeTime(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  return `${hrs} hr ago`;
}

/** Whether to keep things still: Settings › Motion, or the system setting when that says "System". */
export function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced';
}

export function onMotionChange(cb: (reduced: boolean) => void) {
  window.addEventListener('quill:motion', (e) => cb((e as CustomEvent<boolean>).detail));
}

const fading = new WeakMap<Element, number>();

/** Fade elements out, change them, fade them back in — interruptible, and instant with reduced motion. */
export function crossfade(els: HTMLElement[], change: () => void) {
  if (reducedMotion()) {
    change();
    return;
  }
  for (const e of els) {
    clearTimeout(fading.get(e));
    e.classList.add('fade-out');
  }
  const t = window.setTimeout(() => {
    change();
    for (const e of els) e.classList.remove('fade-out');
  }, 140);
  for (const e of els) fading.set(e, t);
}
