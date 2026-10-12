import { MODELS } from '../../shared/models';
import { recommend } from '../../shared/recommend';
import { DEFAULT_SETTINGS, type AppSnapshot, type HardwareProfile, type Settings } from '../../shared/types';

/**
 * A stand-in backend so the app UI can be developed and reviewed in a plain
 * browser. Simulates downloads and engine loading.
 */
export function createMockApi(): NonNullable<Window['quill']> {
  const GiB = 1024 ** 3;
  const params = new URLSearchParams(location.search);
  const profile = params.get('hw') ?? 'gpu';
  const hardware: HardwareProfile = {
    cpu: {
      brand: profile === 'laptop' ? '11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz' : 'AMD Ryzen 7 5800X 8-Core Processor',
      vendor: 'AuthenticAMD',
      physicalCores: profile === 'laptop' ? 4 : 8,
      logicalCores: profile === 'laptop' ? 8 : 16,
      avx2: true, avx512: false, fma: true, f16c: true, neon: false,
    },
    totalMemory: (profile === 'laptop' ? 16 : 32) * GiB,
    availableMemory: (profile === 'laptop' ? 8 : 20) * GiB,
    gpus: profile === 'laptop'
      ? [{ name: 'Intel Iris Xe Graphics', vendor: 'intel', vramBytes: 128 * 1024 ** 2, sharedBytes: 8 * GiB, integrated: true }]
      : [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', vramBytes: 12 * GiB, sharedBytes: 16 * GiB, integrated: false }],
    vulkan: true,
    platform: 'win32',
    source: 'native',
  };
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    onboarded: params.has('onboarded'),
    modelId: params.has('onboarded') ? 'large-v3-turbo-q5_0' : null,
  };
  const installed = new Set<string>(params.has('onboarded') ? ['large-v3-turbo-q5_0', 'base.en'] : []);
  const downloads = new Map<string, { received: number; total: number }>();
  let listener: ((s: AppSnapshot) => void) | null = null;
  // ?update=available|downloading|ready previews the update UI.
  const u = params.get('update');
  let update: AppSnapshot['update'] =
    u === 'available'
      ? { state: 'available', currentVersion: '0.1.0', version: '0.2.0', notes: 'Faster transcription on graphics cards, a calmer listening animation, and smarter punctuation.' }
      : u === 'ready'
        ? { state: 'ready', currentVersion: '0.1.0', version: '0.2.0' }
        : { state: 'up-to-date', currentVersion: '0.1.0', checkedAt: Date.now() };

  const snap = (): AppSnapshot => ({
    settings,
    hardware,
    recommendations: recommend(hardware, settings.language, settings.engine),
    models: MODELS.map((m) => ({ id: m.id, installed: installed.has(m.id), path: installed.has(m.id) ? `C:\\Users\\you\\AppData\\Roaming\\Quill\\models\\${m.file}` : null })),
    engine: settings.modelId && installed.has(settings.modelId)
      ? { state: 'ready', modelId: settings.modelId, device: profile === 'laptop' ? 'cpu' : 'gpu', loadMs: 840 }
      : { state: 'idle' },
    downloads: [...downloads.entries()].map(([modelId, d]) => ({ modelId, received: d.received, total: d.total, bytesPerSec: 38e6, state: 'downloading' as const })),
    history: params.has('onboarded')
      ? [
          { text: 'Let’s move the design review to Thursday afternoon and invite the whole team.', audioMs: 4200, processMs: 410, modelId: 'large-v3-turbo-q5_0', at: Date.now() - 90_000 },
          { text: 'Remember to pick up the dry cleaning before six.', audioMs: 2600, processMs: 320, modelId: 'large-v3-turbo-q5_0', at: Date.now() - 1_900_000 },
        ]
      : [],
    version: '0.1.0',
    platform: 'win32',
    hotkeyAvailable: true,
    hotkeyError: null,
    update,
  });
  const push = () => listener?.(snap());

  return {
    snapshot: async () => snap(),
    onUpdate: (cb) => { listener = cb; },
    onNavigate: () => undefined,
    onDictationPhase: () => undefined,
    setSettings: async (patch) => { settings = { ...settings, ...patch }; push(); return settings; },
    downloadModel: async (id) => {
      const m = MODELS.find((x) => x.id === id)!;
      downloads.set(id, { received: 0, total: m.sizeBytes });
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          const d = downloads.get(id);
          if (!d) { clearInterval(t); resolve(); return; }
          d.received = Math.min(d.total, d.received + d.total / 40);
          if (d.received >= d.total) {
            clearInterval(t);
            downloads.delete(id);
            installed.add(id);
            if (!settings.modelId) settings = { ...settings, modelId: id };
            resolve();
          }
          push();
        }, 100);
      });
      return { ok: true };
    },
    cancelDownload: async (id) => { downloads.delete(id); push(); },
    deleteModel: async (id) => { installed.delete(id); if (settings.modelId === id) settings = { ...settings, modelId: null }; push(); },
    useModel: async (id) => { settings = { ...settings, modelId: id }; push(); },
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
