import { contextBridge, ipcRenderer } from 'electron';
import { IPC, OverlayAction } from '../shared/ipc';
import type { OverlayCommand } from '../shared/types';

/** The overlay's entire view of the outside world. */
const api = {
  onCommand(cb: (c: OverlayCommand) => void) {
    ipcRenderer.on(IPC.overlayCommand, (_e, c: OverlayCommand) => cb(c));
  },
  ready: () => ipcRenderer.send(IPC.overlayReady),
  sendAudio: (pcm: Float32Array) => {
    // Copy into a standalone buffer so only the samples cross the bridge.
    const copy = pcm.slice();
    ipcRenderer.send(IPC.overlayAudio, copy.buffer);
  },
  action: (a: OverlayAction) => ipcRenderer.send(IPC.overlayAction, a),
  hover: (on: boolean) => ipcRenderer.send(IPC.overlayHover, on),
  micError: (msg: string) => ipcRenderer.send(IPC.overlayMicError, msg),
  hidden: () => ipcRenderer.send(IPC.overlayHidden),
};

contextBridge.exposeInMainWorld('quillOverlay', api);
export type OverlayApi = typeof api;
