import { h, icons, svg } from '../ui';

/**
 * Before-and-after: one dictated sentence turning into the text Cleanup would insert.
 * Fillers and the corrected phrase are marked, then fold away; the capital and the
 * full stop arrive. It plays once when it comes into view (and on request) and never
 * loops. With reduced motion it is a still, two-line comparison.
 */

type Tok = { t: string; kind?: 'drop' | 'cap' | 'add'; to?: string };

const EXAMPLES: Record<'en' | 'es', Tok[]> = {
  en: [
    { t: 'um', kind: 'drop' }, { t: 'so', kind: 'cap', to: 'So' }, { t: 'I' }, { t: 'think' }, { t: 'we' }, { t: 'should' },
    { t: 'uh', kind: 'drop' }, { t: 'ship' }, { t: 'it' }, { t: 'on' }, { t: 'Friday', kind: 'drop' }, { t: 'no', kind: 'drop' },
    { t: 'wait', kind: 'drop' }, { t: 'Thursday' }, { t: '.', kind: 'add' },
  ],
  es: [
    { t: 'eh', kind: 'drop' }, { t: 'bueno', kind: 'drop' }, { t: 'creo', kind: 'cap', to: 'Creo' }, { t: 'que' }, { t: 'el' }, { t: 'servidor' },
    { t: 'no', kind: 'drop' }, { t: 'está', kind: 'drop' }, { t: 'este', kind: 'drop' }, { t: 'no' }, { t: 'está' }, { t: 'respondiendo' },
    { t: '.', kind: 'add' },
  ],
};

const text = (toks: Tok[], clean: boolean) =>
  toks
    .filter((k) => (clean ? k.kind !== 'drop' : k.kind !== 'add'))
    .map((k) => (clean && k.to ? k.to : k.t))
    .join(' ')
    .replace(/ \./g, '.');

export function CleanupExample() {
  const line = h('p', { class: 'morph', 'aria-hidden': 'true', 'data-phase': 'raw' });
  const still = h('div', { class: 'morph-still', 'aria-hidden': 'true' });
  const label = h('span', { class: 'morph-label' }, h('span', { class: 'l-before' }, 'You say'), h('span', { class: 'l-after' }, 'Quill writes'));
  const spoken = h('span', { class: 'visually-hidden' });
  const replay = h('button', { class: 'icon-btn morph-replay', type: 'button', 'aria-label': 'Play the example again', title: 'Play again' }, svg(icons.replay));
  const el = h('figure', { class: 'example' }, label, line, still, spoken, replay);

  let lang: 'en' | 'es' = 'en';
  let timers: number[] = [];
  let played = false;

  const build = () => {
    const toks = EXAMPLES[lang];
    line.replaceChildren(
      ...toks.map((k, i) => {
        const space = i < toks.length - 1 && toks[i + 1].kind !== 'add' ? ' ' : '';
        if (k.kind === 'cap') {
          return h('span', { class: 'w cap' }, h('span', { class: 'from' }, k.t + space), h('span', { class: 'to' }, k.to! + space));
        }
        return h('span', { class: `w ${k.kind ?? ''}` }, k.t + space);
      }),
    );
    still.replaceChildren(
      h('p', { class: 'still-before' }, h('span', { class: 'still-tag' }, 'You say'), ...EXAMPLES[lang].filter((k) => k.kind !== 'add').map((k, i, a) => h('span', { class: k.kind === 'drop' ? 'struck' : '' }, k.t + (i < a.length - 1 ? ' ' : '')))),
      h('p', { class: 'still-after' }, h('span', { class: 'still-tag' }, 'Quill writes'), text(EXAMPLES[lang], true)),
    );
    spoken.textContent = `For example, you say: “${text(EXAMPLES[lang], false)}” and Quill writes: “${text(EXAMPLES[lang], true)}”`;
    requestAnimationFrame(measure);
  };

  // Folding words collapse from their natural width, so measure it once laid out.
  const measure = () => {
    line.querySelectorAll<HTMLElement>('.w.drop, .w.add').forEach((w) => w.style.setProperty('--w', `${Math.ceil(w.scrollWidth) + 1}px`));
  };

  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const play = () => {
    clear();
    played = true;
    el.dataset.phase = line.dataset.phase = 'raw';
    // Restart from the spoken sentence without animating back to it.
    line.classList.add('instant');
    void line.offsetWidth;
    line.classList.remove('instant');
    timers.push(window.setTimeout(() => (line.dataset.phase = 'mark'), 500));
    timers.push(window.setTimeout(() => (el.dataset.phase = line.dataset.phase = 'clean'), 1250));
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && !played) play();
    },
    { threshold: 0.6 },
  );
  io.observe(el);
  replay.addEventListener('click', play);
  build();
  if ('fonts' in document) void document.fonts.ready.then(measure);

  return {
    el,
    play,
    setLanguage(l: string) {
      const next = l === 'es' ? 'es' : 'en';
      if (next === lang) return;
      lang = next;
      clear();
      el.dataset.phase = line.dataset.phase = 'raw';
      played = false;
      build();
    },
  };
}
