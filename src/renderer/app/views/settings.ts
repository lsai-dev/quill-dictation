import type { AppSnapshot, Settings } from '../../../shared/types';
import { api, subscribe } from '../store';
import { h, icons, keycaps, segmented, select, svg, toggle } from '../ui';

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['auto', 'Detect automatically'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'], ['pl', 'Polish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
];

const SHORTCUTS: [string, string][] = [
  ['win+space', 'Win + Space'],
  ['ctrl+space', 'Ctrl + Space'],
  ['alt+space', 'Alt + Space'],
  ['ctrl+shift+space', 'Ctrl + Shift + Space'],
  ['f9', 'F9'],
];

const set = (patch: Partial<Settings>) => api.setSettings(patch);

function row(label: string, control: Node, detail?: string) {
  return h('div', { class: 'row setting' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, label), detail ? h('p', { class: 'row-sub' }, detail) : null), h('div', { class: 'row-side' }, control));
}

function group(title: string, ...rows: Node[]) {
  return h('div', { class: 'group' }, h('h2', { class: 'group-title' }, title), h('div', { class: 'card list' }, ...rows));
}

export function SettingsView() {
  const body = h('div', { class: 'settings-body' });
  const el = h('section', { class: 'view settings' }, h('header', { class: 'view-head' }, h('h1', null, 'Settings')), body);

  let built = '';
  subscribe((s) => {
    // Rebuild only when something structural changes, so controls keep focus.
    const key = JSON.stringify({ ...s.settings, customVocabulary: undefined, hk: s.hotkeyError });
    if (key === built) return;
    built = key;
    const scroll = el.parentElement?.scrollTop ?? 0;
    body.replaceChildren(...build(s));
    if (el.parentElement) el.parentElement.scrollTop = scroll;
  });
  return el;
}

function build(s: AppSnapshot): Node[] {
  const st = s.settings;
  const mic = select(st.microphoneId, [{ value: 'default', label: 'System default' }], (v) => set({ microphoneId: v }), 'Microphone');
  void navigator.mediaDevices?.enumerateDevices().then((devices) => {
    for (const d of devices.filter((x) => x.kind === 'audioinput' && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications')) {
      mic.append(h('option', { value: d.deviceId }, d.label || 'Microphone'));
    }
    mic.value = st.microphoneId;
    if (mic.value !== st.microphoneId) mic.value = 'default';
  });

  const vocab = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Names, products, jargon — separated by commas', 'aria-label': 'Custom vocabulary' });
  vocab.value = st.customVocabulary;
  let t = 0;
  vocab.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(() => set({ customVocabulary: vocab.value }), 400);
  });

  return [
    group(
      'Shortcut',
      row('Keyboard shortcut', select(st.hotkey, SHORTCUTS.map(([value, label]) => ({ value, label })), (v) => set({ hotkey: v }), 'Keyboard shortcut'), s.hotkeyError ?? undefined),
      row(
        'Behavior',
        segmented(st.hotkeyMode, [
          { value: 'auto', label: 'Automatic' },
          { value: 'toggle', label: 'Press' },
          { value: 'hold', label: 'Hold' },
        ], (v) => set({ hotkeyMode: v }), 'Shortcut behavior'),
        st.hotkeyMode === 'auto'
          ? 'Tap to start and tap to finish, or hold while speaking and release to finish.'
          : st.hotkeyMode === 'toggle'
            ? 'Press once to start, press again to finish.'
            : 'Hold while speaking, release to finish.',
      ),
      h('div', { class: 'row hint-row' }, svg(icons.sparkle, 'icon small'), h('span', null, 'Press '), keycaps('esc'), h('span', null, ' at any time to cancel.')),
    ),
    group(
      'Dictation',
      row('Language', select(st.language, LANGUAGES.map(([value, label]) => ({ value, label })), (v) => set({ language: v }), 'Language')),
      row('Microphone', mic),
      row('Custom vocabulary', vocab, 'Helps Quill spell names and specialized terms correctly.'),
      row('Voice commands', toggle(st.voiceCommands, (v) => set({ voiceCommands: v }), 'Voice commands'), 'Say “new line” or “new paragraph”.'),
      row('Smart spacing', toggle(st.smartSpacing, (v) => set({ smartSpacing: v }), 'Smart spacing'), 'Adds a space when you continue dictating in the same place.'),
    ),
    group(
      'Inserting Text',
      row(
        'Method',
        segmented(st.insertMethod, [
          { value: 'paste', label: 'Paste' },
          { value: 'type', label: 'Type' },
        ], (v) => set({ insertMethod: v }), 'Insert method'),
        st.insertMethod === 'paste' ? 'Fast and works almost everywhere.' : 'Types each character — for apps that block pasting.',
      ),
      row('Restore clipboard', toggle(st.restoreClipboard, (v) => set({ restoreClipboard: v }), 'Restore clipboard'), 'Puts back whatever you had copied after inserting.'),
    ),
    group(
      'Appearance & Sound',
      row(
        'Motion',
        segmented(st.motion, [
          { value: 'system', label: 'System' },
          { value: 'reduced', label: 'Reduced' },
          { value: 'full', label: 'Full' },
        ], (v) => set({ motion: v }), 'Motion'),
        'Reduced motion keeps the ribbon still and shows each state with light alone.',
      ),
      row('Sounds', toggle(st.sounds, (v) => set({ sounds: v }), 'Sounds'), 'Soft tones when the microphone opens and closes.'),
    ),
    group(
      'General',
      row('Open at login', toggle(st.launchAtLogin, (v) => set({ launchAtLogin: v }), 'Open at login'), 'Quill waits quietly in the system tray.'),
      row(
        'Processing',
        segmented(st.engine, [
          { value: 'auto', label: 'Automatic' },
          { value: 'gpu', label: 'Graphics' },
          { value: 'cpu', label: 'Processor' },
        ], (v) => set({ engine: v }), 'Processing device'),
        s.recommendations ? `Currently: ${s.recommendations.deviceLabel}` : undefined,
      ),
    ),
    h(
      'div',
      { class: 'about' },
      h('div', { class: 'about-mark', 'aria-hidden': 'true' }),
      h('div', null, h('div', { class: 'about-name' }, `Quill ${s.version}`), h('p', { class: 'muted small' }, 'Private by design: speech recognition runs on this PC and nothing you say leaves it. Models are downloaded once from the open-source whisper.cpp project.')),
    ),
  ];
}
