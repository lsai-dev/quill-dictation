import { BrowserWindow, nativeTheme, shell } from 'electron';
import { release } from 'node:os';
import { preloadPath, rendererUrl, assetPath } from './paths';

let win: BrowserWindow | null = null;

/** Windows 11 22H2+ supports the Mica backdrop. */
export function supportsMica(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(release().split('.')[2] ?? 0);
  return build >= 22621;
}

export function getAppWindow() {
  return win;
}

export function showAppWindow(section?: string) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (section) win.webContents.send('app:navigate', section);
    return win;
  }
  const mica = supportsMica();
  win = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: 'Quill',
    icon: assetPath('icon.png'),
    backgroundColor: mica ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f',
            height: 44,
          },
        }),
    webPreferences: {
      preload: preloadPath('app'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const src = rendererUrl('app');
  const query = { mica: mica ? '1' : '0', platform: process.platform, ...(section ? { section } : {}) };
  if (src.url) void win.loadURL(`${src.url}?${new URLSearchParams(query)}`);
  else void win.loadFile(src.file!, { query });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));
  // Links open in the browser, never inside Quill.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.QUILL_DEV_SERVER ?? '\0')) e.preventDefault();
  });
  nativeTheme.on('updated', updateTitleBar);
  return win;
}

function updateTitleBar() {
  if (!win || win.isDestroyed() || process.platform === 'darwin') return;
  try {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f', height: 44 });
  } catch {
    /* not supported on this platform */
  }
}
