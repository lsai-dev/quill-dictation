import { app, clipboard, ipcMain, nativeTheme, session, shell } from 'electron';
import { IPC } from '../shared/ipc';
import { cleanupModelById } from '../shared/cleanupModels';
import { modelById } from '../shared/models';
import { recommend, recommendSetup } from '../shared/recommend';
import type { AppSnapshot, HardwareProfile, RecommendationSet, Settings, SetupRecommendation } from '../shared/types';
import { getAppWindow, showAppWindow } from './appWindow';
import { Dictation } from './dictation';
import { CleanupEngine } from './cleanup';
import { DownloadCancelled, Downloads } from './downloads';
import { Engine, inferenceThreads } from './engine';
import { detectHardware } from './hardware';
import { Hotkey, label } from './hotkey';
import { initLog, log } from './log';
import { NativeHelper } from './native';
import { OverlayWindow } from './overlay';
import { modelsDir, userDir } from './paths';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { Updater } from './updater';

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

  // CI: exercise the real update feed, then exit.
  if (process.env.QUILL_UPDATE_SELFTEST) {
    await new Updater().selfTest(process.env.QUILL_UPDATE_SELFTEST, process.env.QUILL_UPDATE_SELFTEST_FROM);
    app.exit(0);
    return;
  }

  // Microphone access for our own windows only.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && isOwn(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isOwn(origin));

  const settings = new SettingsStore();
  const native = new NativeHelper();
  await native.start();
  const engine = new Engine();
  const cleanup = new CleanupEngine();
  const downloads = new Downloads();
  const updater = new Updater();
  const hotkey = new Hotkey(native);
  await hotkey.apply(settings.get().hotkey);
  const overlay = new OverlayWindow();
  // The engine's thread count depends on whether the UI renders in software, so
  // the first model load waits (briefly) for the overlay to report it.
  let softwareRendering = false;
  const rendererKnown = new Promise<void>((resolve) => {
    overlay.once('renderer', (info: { software: boolean }) => {
      engine.setSoftwareRendering(info.software);
      resolve();
    });
    setTimeout(resolve, 2000);
  });
  overlay.on('renderer', (info: { software: boolean }) => {
    softwareRendering = info.software;
    engine.setSoftwareRendering(info.software);
    if (hardware) cleanup.setThreads(inferenceThreads(hardware.cpu.physicalCores, softwareRendering));
  });
  overlay.create();

  let hardware: HardwareProfile | null = null;
  let recs: RecommendationSet | null = null;
  let setup: SetupRecommendation | null = null;

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
    cleanup: {
      ready: () => settings.get().cleanup && cleanup.ready,
      polish: (text, language) => cleanup.polish(text, { language, deadlineMs: cleanupDeadline(text) }),
      cancel: () => cleanup.cancel(),
    },
  });

  /** How long a polish may take before the transcript goes in as spoken. */
  function cleanupDeadline(text: string) {
    const id = settings.get().cleanupModelId;
    const est = setup?.cleanupEstimates.find((e) => e.modelId === id)?.latencySec ?? 2;
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.round(Math.min(60_000, Math.max(4_000, (est * Math.max(1, words / 25) * 3 + 1.5) * 1000)));
  }
  dictation.on('needs-setup', () => showAppWindow('models'));

  // ── State broadcast to the app window ──────────────────────────────────────
  const snapshot = (): AppSnapshot => ({
    settings: settings.get(),
    hardware,
    recommendations: recs,
    setup,
    models: downloads.states(),
    engine: engine.status,
    cleanupEngine: cleanup.status,
    downloads: downloads.progress(),
    history: dictation.history,
    version: app.getVersion(),
    platform: process.platform,
    hotkeyAvailable: hotkey.usingNative || !hotkey.error,
    hotkeyError: hotkey.error,
    update: updater.status,
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
    await rendererKnown;
    try {
      await engine.ensure(s.modelId, downloads.pathFor(s.modelId)!, s.engine === 'cpu' ? 'cpu' : s.engine === 'gpu' ? 'gpu' : device);
    } catch (e) {
      log.error(`model load: ${(e as Error).message}`);
    }
  }

  /** Cleanup: loaded while it's on (and its model is here), unloaded to free memory when off. */
  async function loadCleanup() {
    const s = settings.get();
    const id = s.cleanupModelId;
    if (!s.cleanup || !id || !downloads.isInstalled(id) || !cleanup.available) {
      if (cleanup.status.state !== 'idle') await cleanup.unload();
      return;
    }
    const est = setup?.cleanupEstimates.find((e) => e.modelId === id);
    // The engine is built for AVX2/NEON processors; never start it where it can't run.
    if (hardware && !hardware.cpu.avx2 && !hardware.cpu.neon && est?.device !== 'gpu') return;
    await rendererKnown;
    cleanup.setLanguage(s.language);
    try {
      await cleanup.ensure(id, downloads.pathFor(id)!, est?.device === 'gpu' && s.engine !== 'cpu' ? 'gpu' : 'cpu');
    } catch (e) {
      log.error(`cleanup load: ${(e as Error).message}`);
    }
  }

  function plan() {
    if (!hardware) return;
    const s = settings.get();
    recs = recommend(hardware, s.language, s.engine);
    const chosen = s.modelId && downloads.isInstalled(s.modelId) ? s.modelId : null;
    setup = recommendSetup(hardware, s.language, s.engine, { dictationId: chosen, recs });
  }

  async function refreshHardware() {
    hardware = await detectHardware(native.available ? native : null, engine.hasGpuBuild());
    engine.setCpuFeatures({ avx2: hardware.cpu.avx2 || hardware.cpu.neon, physicalCores: hardware.cpu.physicalCores });
    cleanup.setThreads(inferenceThreads(hardware.cpu.physicalCores, softwareRendering));
    plan();
    log.info(`hardware: ${hardware.cpu.brand}, ${(hardware.totalMemory / 2 ** 30).toFixed(1)} GB, gpus=[${hardware.gpus.map((g) => g.name).join(', ')}], vulkan=${hardware.vulkan} → ${recs!.recommended.modelId} on ${recs!.device}; cleanup ${setup!.cleanupId ?? 'none'}${setup!.cleanup ? ` on ${setup!.cleanup.device}` : ''}`);
    broadcast();
  }

  engine.on('status', broadcast);
  cleanup.on('status', broadcast);
  updater.on('status', broadcast);
  updater.isBusy = () => dictation.busy;
  updater.onOpenApp = () => showAppWindow('home');
  downloads.on('progress', broadcast);
  dictation.on('result', broadcast);
  // Let the app window pause its decorative ribbon while you dictate.
  dictation.on('phase', (phase: string) => {
    const w = getAppWindow();
    if (w && !w.isDestroyed()) w.webContents.send(IPC.dictationPhase, phase);
  });
  settings.on('change', async (next: Settings, prev: Settings) => {
    if (next.hotkey !== prev.hotkey) await hotkey.apply(next.hotkey);
    if (next.language !== prev.language || next.engine !== prev.engine || next.modelId !== prev.modelId) plan();
    if (next.modelId !== prev.modelId || next.engine !== prev.engine) void loadModel();
    if (next.cleanup !== prev.cleanup || next.cleanupModelId !== prev.cleanupModelId || next.engine !== prev.engine) void loadCleanup();
    if (next.language !== prev.language) cleanup.setLanguage(next.language);
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
  /** After a download: a first model of either kind is put to use right away — it should just work. */
  function adopt(id: string) {
    const s = settings.get();
    if (modelById(id) && (!s.modelId || !downloads.isInstalled(s.modelId))) settings.update({ modelId: id });
    if (cleanupModelById(id) && (!s.cleanupModelId || !downloads.isInstalled(s.cleanupModelId) || s.cleanupModelId === id)) {
      settings.update({ cleanupModelId: id, cleanup: true });
    }
  }

  // A setup (dictation, then cleanup) downloads one model at a time; cancelling one stops the rest.
  let queueGeneration = 0;
  async function downloadAll(ids: string[]): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
    const gen = ++queueGeneration;
    for (const id of ids) {
      if (gen !== queueGeneration) return { ok: false, cancelled: true };
      if (downloads.isInstalled(id)) {
        adopt(id);
        continue;
      }
      try {
        await downloads.download(id);
        adopt(id);
        broadcast();
      } catch (e) {
        broadcast();
        if (e instanceof DownloadCancelled) return { ok: false, cancelled: true };
        return { ok: false, error: (e as Error).message };
      }
    }
    return { ok: true };
  }

  ipcMain.handle(IPC.downloadModel, (_e, id: string) => downloadAll([String(id)]));
  ipcMain.handle(IPC.downloadModels, (_e, ids: string[]) => downloadAll((Array.isArray(ids) ? ids : []).map(String).slice(0, 4)));
  ipcMain.handle(IPC.cancelDownload, (_e, id: string) => {
    queueGeneration++;
    downloads.cancel(id);
  });
  ipcMain.handle(IPC.dismissDownload, (_e, id: string) => downloads.dismiss(String(id)));
  ipcMain.handle(IPC.deleteModel, async (_e, id: string) => {
    if (cleanupModelById(id)) {
      if (cleanup.modelId === id) await cleanup.unload();
      downloads.remove(id);
      if (settings.get().cleanupModelId === id) {
        const other = downloads.states().find((m) => m.installed && cleanupModelById(m.id));
        settings.update({ cleanupModelId: other?.id ?? null, ...(other ? {} : { cleanup: false }) });
      }
      broadcast();
      return;
    }
    if (engine.modelId === id) await engine.unload();
    downloads.remove(id);
    if (settings.get().modelId === id) {
      const other = downloads.states().find((m) => m.installed && modelById(m.id));
      settings.update({ modelId: other?.id ?? null });
    }
    broadcast();
  });
  ipcMain.handle(IPC.useModel, (_e, id: string) => {
    if (modelById(id) && downloads.isInstalled(id)) settings.update({ modelId: id });
  });
  ipcMain.handle(IPC.useCleanupModel, (_e, id: string) => {
    if (cleanupModelById(id) && downloads.isInstalled(id)) settings.update({ cleanupModelId: id, cleanup: true });
  });
  ipcMain.handle(IPC.retryModels, async () => {
    await Promise.allSettled([loadModel(), loadCleanup()]);
    return snapshot();
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
  ipcMain.handle(IPC.checkForUpdates, () => updater.check(true));
  ipcMain.handle(IPC.downloadUpdate, () => updater.download());
  ipcMain.handle(IPC.installUpdate, () => updater.install());

  tray = createTray({
    dictate: () => (dictation.busy ? dictation.finish() : dictation.start()),
    open: (section) => showAppWindow(section),
    quit: () => app.quit(),
    hotkeyLabel: () => hotkey.activeLabel || label(settings.get().hotkey),
    update: () => {
      const u = updater.status;
      if (u.state === 'available') return { label: `Download Quill ${u.version}…`, click: () => void updater.download() };
      if (u.state === 'downloading') return { label: `Downloading update… ${Math.floor(u.percent)}%`, click: () => showAppWindow('home') };
      if (u.state === 'ready') return { label: `Restart to Update to ${u.version}`, click: () => updater.install() };
      return { label: 'Check for Updates…', click: () => void updater.check(true) };
    },
    modelLabel: () => {
      const s = settings.get();
      const m = modelById(engine.modelId ?? s.modelId);
      const c = s.cleanup ? cleanupModelById(cleanup.modelId ?? s.cleanupModelId) : undefined;
      if (!m) return 'No model selected';
      return c ? `Dictation: ${m.name} · Cleanup: ${c.name}` : `Dictation: ${m.name}`;
    },
  });

  app.on('second-instance', () => showAppWindow());
  app.on('window-all-closed', () => {
    /* Quill lives in the tray; closing the window doesn't quit. */
  });
  app.on('before-quit', () => {
    updater.stop();
    void native.stop();
    void engine.unload();
    void cleanup.unload();
    overlay.destroy();
  });

  // End-to-end tests drive the real pipeline through this handle (never set in normal use).
  if (process.env.QUILL_E2E) (globalThis as Record<string, unknown>).__quill = { dictation, engine, cleanup, settings, downloads, hotkey, native, hardware: () => ({ hardware, recs, setup }) };

  applyLoginItem(settings.get().launchAtLogin);
  await refreshHardware();
  void loadModel();
  void loadCleanup();
  updater.start();

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
