import { Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { assetPath } from './paths';

export interface TrayActions {
  dictate: () => void;
  open: (section?: string) => void;
  quit: () => void;
  hotkeyLabel: () => string;
  modelLabel: () => string;
}

let tray: Tray | null = null;

function icon() {
  // Template-style glyph: dark on light taskbars, light on dark ones.
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : nativeTheme.shouldUseDarkColors ? 'tray-light.png' : 'tray-dark.png';
  const img = nativeImage.createFromPath(assetPath(name));
  return img.isEmpty() ? nativeImage.createFromPath(assetPath('icon.png')).resize({ width: 16, height: 16 }) : img;
}

export function createTray(a: TrayActions) {
  tray = new Tray(icon());
  tray.setToolTip('Quill');
  let key = '';
  const rebuild = () => {
    const next = a.hotkeyLabel() + '|' + a.modelLabel();
    if (next === key) return;
    key = next;
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Start Dictation`, accelerator: undefined, sublabel: a.hotkeyLabel(), click: a.dictate },
        { type: 'separator' },
        { label: a.modelLabel(), enabled: false },
        { label: 'Models…', click: () => a.open('models') },
        { label: 'Settings…', click: () => a.open('settings') },
        { type: 'separator' },
        { label: 'Open Quill', click: () => a.open() },
        { label: 'Quit Quill', click: a.quit },
      ]),
    );
  };
  rebuild();
  tray.on('click', () => a.open());
  nativeTheme.on('updated', () => tray?.setImage(icon()));
  return { rebuild };
}
