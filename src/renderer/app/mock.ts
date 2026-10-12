import { CLEANUP_MODELS } from '../../shared/cleanupModels';
import { MODELS } from '../../shared/models';
import { recommend, recommendSetup } from '../../shared/recommend';
import { DEFAULT_SETTINGS, type AppSnapshot, type DownloadProgress, type EngineStatus, type HardwareProfile, type Settings } from '../../shared/types';

/**
 * A stand-in backend so the app UI can be developed and reviewed in a plain
 * browser. Simulates downloads and engine loading.
 *
 *   ?hw=gpu|laptop|old      hardware profile
 *   ?onboarded              skip first-run setup (dictation installed)
 *   ?cleanup                cleanup installed and on
 *   ?lang=es                dictation language
 *   ?fail                   downloads fail part-way (to review error and recovery)
 *   ?update=available|ready preview the update banner
 */
export function createMockApi(): NonNullable<Window['quill']> {
  const GiB = 1024 ** 3;
  const params = new URLSearchParams(location.search);
  const profile = params.get('hw') ?? 'gpu';
  const laptop = profile === 'laptop';
  const old = profile === 'old';
  const hardware: HardwareProfile = {
    cpu: {
      brand: old ? 'Intel(R) Celeron(R) N4500 @ 1.10GHz' : laptop ? '11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz' : 'AMD Ryzen 7 5800X 8-Core Processor',
      vendor: 'AuthenticAMD',
      physicalCores: old ? 2 : laptop ? 4 : 8,
      logicalCores: old ? 2 : laptop ? 8 : 16,
      avx2: !old, avx512: false, fma: !old, f16c: !old, neon: false,
    },
    totalMemory: (old ? 4 : laptop ? 16 : 32) * GiB,
    availableMemory: (old ? 1.2 : laptop ? 8 : 20) * GiB,
    gpus: laptop || old
      ? [{ name: 'Intel Iris Xe Graphics', vendor: 'intel', vramBytes: 128 * 1024 ** 2, sharedBytes: 8 * GiB, integrated: true }]
      : [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vramBytes: 12 * GiB, sharedBytes: 16 * GiB, integrated: false }],
    vulkan: true,
    platform: 'win32',
    source: 'native',
  };
  const language = params.get('lang') ?? 'en';
  const onboarded = params.has('onboarded') || params.has('cleanup');
  const first = recommendSetup(hardware, language, 'auto');
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    language,
    onboarded,
    modelId: onboarded ? first.dictationId : null,
    cleanup: params.has('cleanup'),
    cleanupModelId: params.has('cleanup') ? first.cleanupId : null,
  };
  const installed = new Set<string>(onboarded ? [first.dictationId, 'base.en'] : []);
  if (params.has('cleanup') && first.cleanupId) installed.add(first.cleanupId);
  const downloads = new Map<string, DownloadProgress>();
  const failed = new Map<string, DownloadProgress>();
  const cancelled = new Set<string>();
  let cleanupEngine: EngineStatus = settings.cleanup && settings.cleanupModelId ? { state: 'ready', modelId: settings.cleanupModelId, device: profile === 'gpu' ? 'gpu' : 'cpu', loadMs: 900 } : { state: 'idle' };
  let listener: ((s: AppSnapshot) => void) | null = null;
  // ?update=available|downloading|ready previews the update UI.
  const u = params.get('update');
  let update: AppSnapshot['update'] =
    u === 'available'
      ? { state: 'available', currentVersion: '0.1.0', version: '0.2.0', notes: 'Faster transcription on graphics cards, a calmer listening animation, and smarter punctuation.' }
      : u === 'ready'
        ? { state: 'ready', currentVersion: '0.1.0', version: '0.2.0' }
        : { state: 'up-to-date', currentVersion: '0.1.0', checkedAt: Date.now() };

  const snap = (): AppSnapshot => {
    const recs = recommend(hardware, settings.language, settings.engine);
    return {
      settings,
      hardware,
      recommendations: recs,
      setup: recommendSetup(hardware, settings.language, settings.engine, { dictationId: settings.modelId && installed.has(settings.modelId) ? settings.modelId : null, recs }),
      models: [...MODELS, ...CLEANUP_MODELS].map((m) => ({ id: m.id, installed: installed.has(m.id), path: installed.has(m.id) ? `C:\\Users\\you\\AppData\\Roaming\\Quill\\models\\${m.file}` : null })),
      engine: settings.modelId && installed.has(settings.modelId)
        ? { state: 'ready', modelId: settings.modelId, device: profile === 'gpu' ? 'gpu' : 'cpu', loadMs: 840 }
        : { state: 'idle' },
      cleanupEngine,
      downloads: [...downloads.values(), ...failed.values()],
      history: onboarded
        ? [
            {
              text: 'Let’s move the design review to Thursday afternoon and invite the whole team.',
              original: 'um let’s move the design review to Wednesday no wait Thursday afternoon and uh invite the whole team',
              cleanup: 'polished', cleanupMs: 420,
              audioMs: 5200, processMs: 820, modelId: first.dictationId, at: Date.now() - 90_000,
            },
            { text: 'Remember to pick up the dry cleaning before six.', audioMs: 2600, processMs: 320, modelId: first.dictationId, at: Date.now() - 1_900_000 },
          ]
        : [],
      version: '0.1.0',
      platform: 'win32',
      hotkeyAvailable: true,
      hotkeyError: null,
      update,
    };
  };
  const push = () => listener?.(snap());

  const loadCleanup = () => {
    if (!settings.cleanup || !settings.cleanupModelId || !installed.has(settings.cleanupModelId)) {
      cleanupEngine = { state: 'idle' };
      push();
      return;
    }
    const id = settings.cleanupModelId;
    cleanupEngine = { state: 'loading', modelId: id };
    push();
    setTimeout(() => {
      if (settings.cleanupModelId !== id || !settings.cleanup) return;
      cleanupEngine = { state: 'ready', modelId: id, device: profile === 'gpu' ? 'gpu' : 'cpu', loadMs: 1200 };
      push();
    }, 1400);
  };

  const downloadOne = (id: string) =>
    new Promise<'ok' | 'cancelled' | 'error'>((resolve) => {
      const m = [...MODELS, ...CLEANUP_MODELS].find((x) => x.id === id)!;
      failed.delete(id);
      cancelled.delete(id);
      const d: DownloadProgress = { modelId: id, received: 0, total: m.sizeBytes, bytesPerSec: 48e6, state: 'downloading' };
      downloads.set(id, d);
      push();
      const t = setInterval(() => {
        if (cancelled.has(id)) {
          clearInterval(t);
          downloads.delete(id);
          push();
          resolve('cancelled');
          return;
        }
        d.received = Math.min(d.total, d.received + d.total / 45);
        if (params.has('fail') && d.received > d.total * 0.4) {
          clearInterval(t);
          downloads.delete(id);
          failed.set(id, { ...d, state: 'error', bytesPerSec: 0, error: 'Couldn’t reach the download server. Check your connection and try again.' });
          params.delete('fail'); // the retry succeeds
          push();
          resolve('error');
          return;
        }
        if (d.received >= d.total) {
          d.state = 'verifying';
          push();
          clearInterval(t);
          setTimeout(() => {
            downloads.delete(id);
            installed.add(id);
            if (MODELS.some((x) => x.id === id) && (!settings.modelId || !installed.has(settings.modelId))) settings = { ...settings, modelId: id };
            if (CLEANUP_MODELS.some((x) => x.id === id) && (!settings.cleanupModelId || !installed.has(settings.cleanupModelId) || settings.cleanupModelId === id)) {
              settings = { ...settings, cleanupModelId: id, cleanup: true };
              loadCleanup();
            }
            push();
            resolve('ok');
          }, 500);
          return;
        }
        push();
      }, 100);
    });

  const downloadModels = async (ids: string[]) => {
    for (const id of ids) {
      if (installed.has(id)) continue;
      const r = await downloadOne(id);
      if (r === 'cancelled') return { ok: false, cancelled: true };
      if (r === 'error') return { ok: false, error: failed.get(id)?.error };
    }
    return { ok: true };
  };

  return {
    snapshot: async () => snap(),
    onUpdate: (cb) => { listener = cb; },
    onNavigate: () => undefined,
    onDictationPhase: () => undefined,
    setSettings: async (patch) => {
      settings = { ...settings, ...patch };
      if ('cleanup' in patch || 'cleanupModelId' in patch) loadCleanup();
      push();
      return settings;
    },
    downloadModel: (id) => downloadModels([id]),
    downloadModels,
    cancelDownload: async (id) => { cancelled.add(id); failed.delete(id); push(); },
    dismissDownload: async (id) => { failed.delete(id); push(); },
    deleteModel: async (id) => {
      installed.delete(id);
      if (settings.modelId === id) settings = { ...settings, modelId: null };
      if (settings.cleanupModelId === id) settings = { ...settings, cleanupModelId: null, cleanup: false };
      loadCleanup();
      push();
    },
    useModel: async (id) => { settings = { ...settings, modelId: id }; push(); },
    useCleanupModel: async (id) => { settings = { ...settings, cleanupModelId: id, cleanup: true }; loadCleanup(); },
    retryModels: async () => { loadCleanup(); return snap(); },
    refreshHardware: async () => snap(),
    startDictation: async () => undefined,
    copyText: async () => undefined,
    clearHistory: async () => undefined,
    openModelsFolder: async () => undefined,
    checkForUpdates: async () => {
      update = { state: 'checking', currentVersion: '0.1.0' };
      push();
      setTimeout(() => { update = { state: 'up-to-date', currentVersion: '0.1.0', checkedAt: Date.now() }; push(); }, 900);
    },
    downloadUpdate: async () => {
      let p = 0;
      const t = setInterval(() => {
        p += 7;
        update = p >= 100 ? { state: 'ready', currentVersion: '0.1.0', version: '0.2.0' } : { state: 'downloading', currentVersion: '0.1.0', version: '0.2.0', percent: p };
        if (p >= 100) clearInterval(t);
        push();
      }, 120);
    },
    installUpdate: async () => undefined,
  };
}
