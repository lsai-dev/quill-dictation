import { BrowserWindow, ipcMain, screen } from 'electron';
import { EventEmitter } from 'node:events';
import { IPC, OverlayAction } from '../shared/ipc';
import type { OverlayCommand } from '../shared/types';
import { toFloat32 } from '../shared/audio';
import { preloadPath, rendererUrl } from './paths';
import { log } from './log';

/** Logical size of the overlay. The ribbon animates inside it; it never moves. */
export const OVERLAY_SIZE = { width: 320, height: 148 };
const BOTTOM_MARGIN = 22;

/**
 * The floating ribbon's window: transparent, always on top, never focusable
 * (so the app you're dictating into keeps its caret), and click-through
 * everywhere except the ribbon and its controls.
 */
export class OverlayWindow extends EventEmitter {
  private win: BrowserWindow | null = null;
  private ready = false;
  private queue: OverlayCommand[] = [];
  private interactive = false;

  create() {
    const win = new BrowserWindow({
      ...OVERLAY_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      roundedCorners: false,
      thickFrame: false,
      title: 'Quill',
      webPreferences: {
        preload: preloadPath('overlay'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    // Above the taskbar and full-screen apps.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setBackgroundThrottling(false);
    const src = rendererUrl('overlay');
    if (src.url) void win.loadURL(src.url);
    else void win.loadFile(src.file!);
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      log.error(`overlay renderer gone: ${d.reason}`);
      this.ready = false;
      setTimeout(() => {
        this.win?.destroy();
        this.create();
      }, 300);
    });
    this.win = win;

    ipcMain.removeAllListeners(IPC.overlayReady);
    ipcMain.on(IPC.overlayReady, (e) => {
      if (e.sender !== this.win?.webContents) return;
      this.ready = true;
      for (const c of this.queue.splice(0)) this.send(c);
    });
    ipcMain.removeAllListeners(IPC.overlayRenderer);
    ipcMain.on(IPC.overlayRenderer, (e, info: { software?: boolean }) => {
      if (e.sender === this.win?.webContents) this.emit('renderer', { software: !!info?.software });
    });
    ipcMain.removeAllListeners(IPC.overlayAudio);
    ipcMain.on(IPC.overlayAudio, (e, buf: unknown) => {
      if (e.sender === this.win?.webContents) this.emit('audio', toFloat32(buf));
    });
    ipcMain.removeAllListeners(IPC.overlayAction);
    ipcMain.on(IPC.overlayAction, (e, a: OverlayAction) => {
      if (e.sender === this.win?.webContents) this.emit('action', a);
    });
    ipcMain.removeAllListeners(IPC.overlayHover);
    ipcMain.on(IPC.overlayHover, (e, hovering: boolean) => {
      if (e.sender === this.win?.webContents) this.setInteractive(!!hovering);
    });
    ipcMain.removeAllListeners(IPC.overlayMicError);
    ipcMain.on(IPC.overlayMicError, (e, msg: string) => {
      if (e.sender === this.win?.webContents) this.emit('mic-error', String(msg));
    });
    ipcMain.removeAllListeners(IPC.overlayHidden);
    ipcMain.on(IPC.overlayHidden, (e) => {
      if (e.sender !== this.win?.webContents) return;
      this.setInteractive(false);
      this.win?.hide();
      this.emit('hidden');
    });
  }

  /** Bottom-centre of the display the user is working on. */
  private position() {
    if (!this.win) return;
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = Math.round(area.x + (area.width - OVERLAY_SIZE.width) / 2);
    const y = Math.round(area.y + area.height - OVERLAY_SIZE.height - BOTTOM_MARGIN);
    this.win.setBounds({ x, y, ...OVERLAY_SIZE });
  }

  show(cmd: OverlayCommand) {
    if (!this.win) this.create();
    if (!this.win!.isVisible()) {
      this.position();
      this.win!.showInactive();
      this.win!.setAlwaysOnTop(true, 'screen-saver');
    }
    this.send(cmd);
  }

  send(cmd: OverlayCommand) {
    if (!this.win) return;
    if (!this.ready) {
      this.queue.push(cmd);
      return;
    }
    this.win.webContents.send(IPC.overlayCommand, cmd);
  }

  private setInteractive(on: boolean) {
    if (!this.win || on === this.interactive) return;
    this.interactive = on;
    // When not hovering the ribbon, clicks pass straight through to your work.
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  get visible() {
    return !!this.win?.isVisible();
  }

  destroy() {
    this.win?.destroy();
    this.win = null;
  }
}
