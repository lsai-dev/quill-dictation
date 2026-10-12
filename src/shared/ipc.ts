/** IPC channel names, shared so main, preload and renderers can't drift apart. */
export const IPC = {
  // main → overlay
  overlayCommand: 'overlay:command',
  // overlay → main
  overlayAudio: 'overlay:audio',
  overlayAction: 'overlay:action',
  overlayHover: 'overlay:hover',
  overlayMicError: 'overlay:mic-error',
  overlayHidden: 'overlay:hidden',
  overlayReady: 'overlay:ready',
  overlayRenderer: 'overlay:renderer',

  // app window ↔ main
  snapshot: 'app:snapshot',
  update: 'app:update',
  setSettings: 'app:set-settings',
  downloadModel: 'app:download-model',
  cancelDownload: 'app:cancel-download',
  deleteModel: 'app:delete-model',
  useModel: 'app:use-model',
  refreshHardware: 'app:refresh-hardware',
  startDictation: 'app:start-dictation',
  copyText: 'app:copy-text',
  clearHistory: 'app:clear-history',
  openModelsFolder: 'app:open-models-folder',
  windowAction: 'app:window-action',
} as const;

export type OverlayAction = 'stop' | 'cancel';
