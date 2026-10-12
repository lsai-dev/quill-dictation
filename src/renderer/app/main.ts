import { HomeView } from './views/home';
import { ModelsView } from './views/models';
import { SettingsView } from './views/settings';
import { Onboarding } from './views/onboarding';
import { api, initStore, snapshot, subscribe } from './store';
import { navigate, onNavigate, type Section } from './router';
import { h, icons, keycaps, svg } from './ui';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.mica = params.get('mica') === '1' ? 'on' : 'off';
document.documentElement.dataset.platform = params.get('platform') ?? 'web';

export const BRAND_MARK = `<svg viewBox="0 0 48 24" aria-hidden="true">
  <defs>
    <linearGradient id="bm-l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfaff"/><stop offset="1" stop-color="#c9c2e6"/></linearGradient>
    <linearGradient id="bm-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9a9ff"/><stop offset="1" stop-color="#6c54f2"/></linearGradient>
    <linearGradient id="bm-edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(70,50,160,.25)"/><stop offset="1" stop-color="rgba(70,50,160,.45)"/></linearGradient>
  </defs>
  <path d="M2.5 16C8.5 8.8 17 8.4 24 13 17 15.8 8.6 18.6 2.5 16Z" fill="url(#bm-l)" stroke="url(#bm-edge)" stroke-width=".8"/>
  <path d="M24 13C30 6.4 38.2 5 45.5 8.4 38.2 12.2 30.2 16.6 24 13Z" fill="url(#bm-r)" stroke="url(#bm-edge)" stroke-width=".8"/>
  <path d="M5 15.4C10 11 17 10.4 22.5 12.8" fill="none" stroke="#fff" stroke-width=".9" stroke-linecap="round" opacity=".9"/>
</svg>`;

// Motion follows Settings › Motion, or the system's preference when that's "System".
const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');
function applyMotion() {
  const pref = snapshot()?.settings.motion ?? 'system';
  const reduced = pref === 'reduced' || (pref === 'system' && systemReduced.matches);
  const next = reduced ? 'reduced' : 'full';
  if (document.documentElement.dataset.motion === next) return;
  document.documentElement.dataset.motion = next;
  window.dispatchEvent(new CustomEvent('quill:motion', { detail: reduced }));
}

async function boot() {
  await initStore();
  applyMotion();
  systemReduced.addEventListener('change', applyMotion);
  subscribe(applyMotion);
  const root = document.getElementById('root')!;
  const first = (params.get('section') as Section) || 'home';

  // First run is its own space: the app isn't built until setup is finished, so
  // nothing of it can show behind (or through) the introduction.
  if (!snapshot().settings.onboarded) {
    document.body.classList.add('onboarding-open');
    root.append(
      Onboarding({
        // Built a beat before the introduction leaves, so the hand-off is a cross-fade.
        prepare: () => mountApp(root, 'home', true),
        done: () => document.body.classList.remove('onboarding-open'),
      }),
    );
    return;
  }
  mountApp(root, first, false);
}

function mountApp(root: HTMLElement, section: Section, reveal: boolean) {
  const views: Record<Section, HTMLElement> = {
    home: HomeView(),
    models: ModelsView(),
    settings: SettingsView(),
  };
  const content = h('main', { class: 'content', id: 'content' }, ...Object.values(views));

  const navItem = (s: Section, label: string, icon: string) =>
    h('button', { class: 'nav-item', type: 'button', 'data-section': s, onClick: () => navigate(s) }, svg(icon), h('span', null, label));
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' }, navItem('home', 'Home', icons.home), navItem('models', 'Models', icons.models), navItem('settings', 'Settings', icons.settings));
  const foot = h('div', { class: 'sidebar-foot' });
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, svg(BRAND_MARK, 'brand-mark'), h('span', { class: 'brand-name' }, 'Quill')),
    nav,
    foot,
  );
  const shell = h('div', { class: `app ${reveal ? 'revealing' : ''}` }, sidebar, content);
  root.prepend(h('div', { class: 'titlebar', 'aria-hidden': 'true' }), shell);
  if (reveal) requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.remove('revealing')));

  const show = (s: Section) => {
    for (const [k, v] of Object.entries(views)) v.classList.toggle('active', k === s);
    nav.querySelectorAll('.nav-item').forEach((b) => {
      const on = (b as HTMLElement).dataset.section === s;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    content.scrollTop = 0;
  };
  onNavigate(show);
  api.onNavigate((s) => navigate(s as Section));
  navigate(section);

  let footKey = '';
  subscribe((s) => {
    if (s.settings.hotkey === footKey) return;
    footKey = s.settings.hotkey;
    foot.replaceChildren(h('div', { class: 'foot-label' }, 'Dictate anywhere'), keycaps(s.settings.hotkey));
  });
}

void boot();
