import { app, clipboard, ipcMain, nativeTheme, session, shell } from 'electron';
import { IPC } from '../shared/ipc';
import { modelById } from '../shared/models';
import { recommend } from '../shared/recommend';
import type { AppSnapshot, HardwareProfile, RecommendationSet, Settings } from '../shared/types';
import { getAppWindow, showAppWindow } from './appWindow';
import { Dictation } from './dictation';
import { Downloads } from './downloads';
import { Engine } from './engine';
import { detectHardware } from './hardware';
import { Hotkey, label } from './hotkey';
import { initLog, log } from './log';
import { NativeHelper } from './native';
import { OverlayWindow } from './overlay';
import { modelsDir, userDir } from './paths';
import { SettingsStore } from './settings';
import { createTray } from './tray';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main() {
  app.setAppUserModelId('app.quill.dictation');
  // Keep animations smooth in a hidden/transparent window.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  // If the GPU is blocklisted, let WebGL fall back to software rendering so the
  // ribbon still appears (it's small; SwiftShader draws it comfortably).
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  await app.whenReady();
  initLog(userDir('logs'));
  log.info(`Quill ${app.getVersion()} starting (${process.platform} ${process.arch})`);

  // Microphone access for our own windows only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && isOwn(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isOwn(origin));

  const settings = new SettingsStore();
  const native = new NativeHelper();
  await native.start();
  const engine = new Engine();
  const downloads = new Downloads();
  const hotkey = new Hotkey(native);
  await hotkey.apply(settings.get().hotkey);
  const overlay = new OverlayWindow();
  overlay.create();

  let hardware: HardwareProfile | null = null;
  let recs: RecommendationSet | null = null;

  const theme = () => {
    const m = settings.get().motion;
    // null = follow the system: the overlay reads prefers-reduced-motion, which
    // Chromium maps to Windows' "Animation effects" setting.
    return { dark: nativeTheme.shouldUseDarkColors, reducedMotion: m === 'reduced' ? true : m === 'full' ? false : null };
  };

  const dictation = new Dictation({
    overlay,
    engine,
    hotkey,
    native: native.available ? native : null,
    settings: () => settings.get(),
    theme,
    readiness: () => {
      const s = settings.get();
      if (!engine.hasAnyBuild()) return { ok: false, message: 'Transcription engine missing — reinstall Quill' };
      if (!s.modelId || !downloads.isInstalled(s.modelId)) return { ok: false, message: 'Choose a voice model in Quill to begin' };
      if (engine.status.state === 'error') {
        // Try again in the background; the session can still record meanwhile.
        void loadModel();
      }
      return { ok: true, modelId: s.modelId };
    },
  });
  dictation.on('needs-setup', () => showAppWindow('models'));

  // ── State broadcast to the app window ──────────────────────────────────────
  const snapshot = (): AppSnapshot => ({
    settings: settings.get(),
    hardware,
    recommendations: recs,
    models: downloads.states(),
    engine: engine.status,
    downloads: downloads.progress(),
    history: dictation.history,
    version: app.getVersion(),
    platform: process.platform,
    hotkeyAvailable: hotkey.usingNative || !hotkey.error,
    hotkeyError: hotkey.error,
  });
  let tray: ReturnType<typeof createTray> | null = null;
  let pending: NodeJS.Timeout | null = null;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const w = getAppWindow();
      if (w && !w.isDestroyed()) w.webContents.send(IPC.update, snapshot());
      tray?.rebuild();
    }, 50);
  };

  // ── Model lifecycle ───────────────────────────────────────────────────────
  async function loadModel() {
    const s = settings.get();
    if (!s.modelId || !downloads.isInstalled(s.modelId)) return;
    const device = recs?.device ?? 'cpu';
    try {
      await engine.ensure(s.modelId, downloads.pathFor(s.modelId)!, s.engine === 'cpu' ? 'cpu' : s.engine === 'gpu' ? 'gpu' : device);
    } catch (e) {
      log.error(`model load: ${(e as Error).message}`);
    }
  }

  async function refreshHardware() {
    hardware = await detectHardware(native.available ? native : null, engine.hasGpuBuild());
    engine.setCpuFeatures({ avx2: hardware.cpu.avx2 || hardware.cpu.neon });
    recs = recommend(hardware, settings.get().language, settings.get().engine);
    log.info(`hardware: ${hardware.cpu.brand}, ${(hardware.totalMemory / 2 ** 30).toFixed(1)} GB, gpus=[${hardware.gpus.map((g) => g.name).join(', ')}], vulkan=${hardware.vulkan} → ${recs.recommended.modelId} on ${recs.device}`);
    broadcast();
  }

  engine.on('status', broadcast);
  downloads.on('progress', broadcast);
  dictation.on('result', broadcast);
  settings.on('change', async (next: Settings, prev: Settings) => {
    if (next.hotkey !== prev.hotkey) await hotkey.apply(next.hotkey);
    if (next.language !== prev.language || next.engine !== prev.engine) {
      if (hardware) recs = recommend(hardware, next.language, next.engine);
    }
    if (next.modelId !== prev.modelId || next.engine !== prev.engine) void loadModel();
    if (next.launchAtLogin !== prev.launchAtLogin) applyLoginItem(next.launchAtLogin);
    if (next.motion !== prev.motion) overlay.send({ type: 'theme', ...theme() });
    broadcast();
  });
  nativeTheme.on('updated', () => {
    overlay.send({ type: 'theme', ...theme() });
    broadcast();
  });

  // ── IPC from the app window ───────────────────────────────────────────────
  ipcMain.handle(IPC.snapshot, () => snapshot());
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<Settings>) => settings.update(patch));
  ipcMain.handle(IPC.downloadModel, async (_e, id: string) => {
    try {
      await downloads.download(id);
      // First model? Use it right away — it should just work.
      const s = settings.get();
      if (!s.modelId || !downloads.isInstalled(s.modelId)) settings.update({ modelId: id });
      broadcast();
      return { ok: true };
    } catch (e) {
      broadcast();
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle(IPC.cancelDownload, (_e, id: string) => downloads.cancel(id));
  ipcMain.handle(IPC.deleteModel, async (_e, id: string) => {
    if (engine.modelId === id) await engine.unload();
    downloads.remove(id);
    if (settings.get().modelId === id) {
      const other = downloads.states().find((m) => m.installed);
      settings.update({ modelId: other?.id ?? null });
    }
    broadcast();
  });
  ipcMain.handle(IPC.useModel, (_e, id: string) => {
    if (downloads.isInstalled(id)) settings.update({ modelId: id });
  });
  ipcMain.handle(IPC.refreshHardware, async () => {
    await refreshHardware();
    return snapshot();
  });
  ipcMain.handle(IPC.startDictation, () => {
    // Give the click a moment to settle so focus returns to the previous app.
    getAppWindow()?.minimize();
    setTimeout(() => dictation.start(), 250);
  });
  ipcMain.handle(IPC.copyText, (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle(IPC.clearHistory, () => {
    dictation.history.length = 0;
    broadcast();
  });
  ipcMain.handle(IPC.openModelsFolder, () => shell.openPath(modelsDir()));

  tray = createTray({
    dictate: () => (dictation.busy ? dictation.finish() : dictation.start()),
    open: (section) => showAppWindow(section),
    quit: () => app.quit(),
    hotkeyLabel: () => hotkey.activeLabel || label(settings.get().hotkey),
    modelLabel: () => {
      const m = modelById(engine.modelId ?? settings.get().modelId);
      return m ? `Model: ${m.name}` : 'No model selected';
    },
  });

  app.on('second-instance', () => showAppWindow());
  app.on('window-all-closed', () => {
    /* Quill lives in the tray; closing the window doesn't quit. */
  });
  app.on('before-quit', () => {
    void native.stop();
    void engine.unload();
    overlay.destroy();
  });

  // End-to-end tests drive the real pipeline through this handle (never set in normal use).
  if (process.env.QUILL_E2E) (globalThis as Record<string, unknown>).__quill = { dictation, engine, settings, downloads, hotkey, native };

  applyLoginItem(settings.get().launchAtLogin);
  await refreshHardware();
  void loadModel();

  const s = settings.get();
  const launchedHidden = process.argv.includes('--hidden');
  if (!s.onboarded || !s.modelId || !downloads.isInstalled(s.modelId) || !launchedHidden) showAppWindow();
}

function applyLoginItem(enabled: boolean) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

function isOwn(url: string) {
  return url.startsWith('file://') || (!!process.env.QUILL_DEV_SERVER && url.startsWith(process.env.QUILL_DEV_SERVER));
}
