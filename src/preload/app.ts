import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { AppSnapshot, Settings } from '../shared/types';

export interface DownloadOutcome {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
}

const api = {
  snapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke(IPC.snapshot),
  onUpdate(cb: (s: AppSnapshot) => void) {
    ipcRenderer.on(IPC.update, (_e, s: AppSnapshot) => cb(s));
  },
  onDictationPhase(cb: (phase: string) => void) {
    ipcRenderer.on(IPC.dictationPhase, (_e, p: string) => cb(p));
  },
  onNavigate(cb: (section: string) => void) {
    ipcRenderer.on('app:navigate', (_e, s: string) => cb(s));
  },
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.setSettings, patch),
  downloadModel: (id: string): Promise<DownloadOutcome> => ipcRenderer.invoke(IPC.downloadModel, id),
  /** Downloads one after another (a setup: dictation, then cleanup). */
  downloadModels: (ids: string[]): Promise<DownloadOutcome> => ipcRenderer.invoke(IPC.downloadModels, ids),
  cancelDownload: (id: string) => ipcRenderer.invoke(IPC.cancelDownload, id),
  dismissDownload: (id: string) => ipcRenderer.invoke(IPC.dismissDownload, id),
  deleteModel: (id: string) => ipcRenderer.invoke(IPC.deleteModel, id),
  useModel: (id: string) => ipcRenderer.invoke(IPC.useModel, id),
  useCleanupModel: (id: string) => ipcRenderer.invoke(IPC.useCleanupModel, id),
  retryModels: (): Promise<AppSnapshot> => ipcRenderer.invoke(IPC.retryModels),
  refreshHardware: (): Promise<AppSnapshot> => ipcRenderer.invoke(IPC.refreshHardware),
  startDictation: () => ipcRenderer.invoke(IPC.startDictation),
  copyText: (t: string) => ipcRenderer.invoke(IPC.copyText, t),
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory),
  openModelsFolder: () => ipcRenderer.invoke(IPC.openModelsFolder),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
};

contextBridge.exposeInMainWorld('quill', api);
export type AppApi = typeof api;
