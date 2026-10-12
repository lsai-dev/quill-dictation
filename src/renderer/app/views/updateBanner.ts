import type { UpdateStatus } from '../../../shared/types';
import { api, subscribe } from '../store';
import { h, icons, ring, svg } from '../ui';

/**
 * "A new version is available" — shown only when there's something to do.
 * Download on your say-so, then restart when it suits you.
 */
export function UpdateBanner() {
  const el = h('div', { class: 'update-banner', role: 'status', 'aria-live': 'polite', hidden: true });
  let lastKey = '';
  subscribe((s) => {
    const u = s.update;
    const key = JSON.stringify([u.state, 'version' in u ? u.version : '', u.state === 'downloading' ? Math.floor(u.percent) : 0]);
    if (key === lastKey) return;
    lastKey = key;
    render(el, u);
  });
  return el;
}

function render(el: HTMLElement, u: UpdateStatus) {
  const show = u.state === 'available' || u.state === 'downloading' || u.state === 'ready' || (u.state === 'error' && !!u.version);
  if (!show) {
    el.classList.remove('visible');
    el.hidden = true;
    return;
  }
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('visible'));
  const version = 'version' in u ? u.version : undefined;
  let title = '';
  let detail = '';
  let action: HTMLElement;
  if (u.state === 'available') {
    title = `Quill ${u.version} is available`;
    detail = u.notes ?? 'Includes improvements and fixes. Your settings and voice models stay as they are.';
    action = h('button', { class: 'btn primary', type: 'button', onClick: () => api.downloadUpdate() }, svg(icons.download, 'icon small'), 'Download');
  } else if (u.state === 'downloading') {
    title = `Downloading Quill ${version ?? ''}`.trim();
    detail = 'Only the parts that changed are downloaded. Keep dictating — nothing is interrupted.';
    const r = ring(18);
    r.set(u.percent / 100);
    action = h('span', { class: 'update-progress' }, r.el, `${Math.floor(u.percent)}%`);
  } else if (u.state === 'ready') {
    title = `Quill ${u.version} is ready`;
    detail = 'Restart to finish updating — it takes a few seconds. Otherwise it installs the next time Quill quits.';
    action = h('button', { class: 'btn primary', type: 'button', onClick: () => api.installUpdate() }, 'Restart to Update');
  } else {
    title = 'The update didn’t finish';
    detail = (u as Extract<UpdateStatus, { state: 'error' }>).message;
    action = h('button', { class: 'btn', type: 'button', onClick: () => api.downloadUpdate() }, 'Try Again');
  }
  el.replaceChildren(
    svg(icons.sparkle, 'icon update-icon'),
    h('div', { class: 'update-copy' }, h('div', { class: 'update-title' }, title), h('p', { class: 'update-detail' }, detail)),
    action,
  );
}
