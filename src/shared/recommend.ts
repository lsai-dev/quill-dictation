import { formatBytes, modelsForLanguage } from './models';
import type {
  EnginePreference,
  GpuInfo,
  HardwareProfile,
  ModelEstimate,
  ModelSpec,
  Recommendation,
  RecommendationGoal,
  RecommendationSet,
} from './types';

/*
 * Performance model
 * ─────────────────
 * Times are calibrated against whisper.cpp on a reference 8-core AVX2 desktop
 * CPU, where one unit of `computeCost` (a 30 s encoder pass) takes ≈0.13 s and
 * one unit of `decodeCost` (one generated token) takes ≈3 ms. Other hardware is
 * expressed as a speed multiple of that reference.
 */
const ENCODE_SEC_PER_UNIT = 0.13;
const DECODE_SEC_PER_UNIT = 0.003;
const TOKENS_PER_DICTATION = 42; // ≈ 10 seconds of speech
const FIXED_OVERHEAD_SEC = 0.08;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface DeviceSpeed {
  device: 'gpu' | 'cpu';
  encode: number; // speed multiple vs reference CPU
  decode: number;
  memoryBudget: number; // bytes the model may comfortably use
  label: string;
  gpu?: GpuInfo;
}

export function cpuSpeed(hw: HardwareProfile): number {
  const cores = Math.max(1, Math.min(hw.cpu.physicalCores || hw.cpu.logicalCores / 2 || 1, 8));
  let simd = 0.45; // SSE-only machines are much slower
  if (hw.cpu.avx2) simd = hw.cpu.avx512 ? 1.15 : 1.0;
  else if (hw.cpu.neon) simd = 0.9;
  // Threads scale sub-linearly (memory bandwidth); SMT adds a little.
  const smt = hw.cpu.logicalCores > hw.cpu.physicalCores ? 1.08 : 1;
  return Math.pow(cores / 8, 0.85) * simd * smt;
}

export function ramBudget(hw: HardwareProfile): number {
  const total = hw.totalMemory;
  const avail = hw.availableMemory || total * 0.5;
  return Math.min(total * 0.4, Math.max(avail * 0.6, total * 0.2));
}

/** How fast a GPU runs whisper.cpp (Vulkan) relative to the reference CPU. */
export function gpuSpeed(g: GpuInfo): number {
  if (g.vendor === 'apple') return 8;
  if (g.integrated) return 1.8;
  const vram = g.vramBytes / GiB;
  if (g.vendor === 'intel') return 7; // Arc
  if (vram >= 12) return 18;
  if (vram >= 8) return 14;
  if (vram >= 6) return 10;
  if (vram >= 4) return 7;
  return 4;
}

export function bestGpu(hw: HardwareProfile): GpuInfo | undefined {
  return [...hw.gpus].sort((a, b) => gpuSpeed(b) - gpuSpeed(a) || b.vramBytes - a.vramBytes)[0];
}

function gpuUsable(g: GpuInfo | undefined, hw: HardwareProfile, forced: boolean): g is GpuInfo {
  if (!g || !hw.vulkan) return false;
  if (forced) return g.integrated || g.vramBytes >= 1 * GiB || g.vendor === 'apple';
  // "Just works": only pick the GPU automatically when it's clearly better.
  return !g.integrated && g.vramBytes >= 2 * GiB;
}

export function chooseDevice(hw: HardwareProfile, pref: EnginePreference): DeviceSpeed {
  const g = bestGpu(hw);
  const cpu = cpuSpeed(hw);
  const cpuLabel = `${hw.cpu.physicalCores || hw.cpu.logicalCores}-core ${shortCpuName(hw.cpu.brand)}`;
  if (pref !== 'cpu' && gpuUsable(g, hw, pref === 'gpu')) {
    const enc = gpuSpeed(g);
    const vramBudget = g.integrated ? ramBudget(hw) : Math.max(0, g.vramBytes * 0.85 - 350 * MiB);
    return {
      device: 'gpu',
      encode: enc,
      decode: Math.max(cpu, Math.min(6, enc / 2.5)),
      memoryBudget: vramBudget,
      label: g.vramBytes > 0 && !g.integrated ? `${g.name} · ${formatBytes(g.vramBytes)}` : g.name,
      gpu: g,
    };
  }
  return { device: 'cpu', encode: cpu, decode: cpu, memoryBudget: ramBudget(hw), label: cpuLabel };
}

export function estimate(m: ModelSpec, d: DeviceSpeed): ModelEstimate {
  const latency =
    (m.computeCost * ENCODE_SEC_PER_UNIT) / d.encode +
    (TOKENS_PER_DICTATION * m.decodeCost * DECODE_SEC_PER_UNIT) / d.decode +
    FIXED_OVERHEAD_SEC;
  const fits = m.memoryBytes <= d.memoryBudget;
  let rating: ModelEstimate['rating'] = 'slow';
  if (!fits) rating = 'unsupported';
  else if (latency <= 1.2) rating = 'great';
  else if (latency <= 3) rating = 'good';
  return {
    modelId: m.id,
    latencySec: Math.round(latency * 100) / 100,
    memoryBytes: m.memoryBytes,
    fits,
    device: d.device,
    rating,
  };
}

/** Accuracy for the user's language: English-only models get a small edge in English. */
function effectiveAccuracy(m: ModelSpec, language: string): number {
  return m.accuracy + (language === 'en' && m.englishOnly ? 1.5 : 0);
}

function balancedScore(m: ModelSpec, e: ModelEstimate, language: string, budget: number): number {
  const lat = e.latencySec;
  const latencyPenalty = 7 * Math.max(0, lat - 0.7) + 12 * Math.max(0, lat - 2.0);
  const memoryPenalty = 3 * (m.memoryBytes / Math.max(budget, 1));
  // A first dictation shouldn't wait on a multi-gigabyte download.
  const downloadPenalty = 1.4 * (m.sizeBytes / GiB);
  return effectiveAccuracy(m, language) - latencyPenalty - memoryPenalty - downloadPenalty;
}

const TITLES: Record<RecommendationGoal, string> = {
  balanced: 'Recommended',
  accuracy: 'Highest accuracy',
  speed: 'Fastest',
  memory: 'Lightest',
};

export function recommend(hw: HardwareProfile, language: string, pref: EnginePreference = 'auto'): RecommendationSet {
  const d = chooseDevice(hw, pref);
  const models = modelsForLanguage(language);
  const rows = models.map((m) => ({ m, e: estimate(m, d) }));
  const usable = rows.filter((r) => r.e.fits);
  // If nothing fits (very low memory), fall back to the smallest model.
  const pool = usable.length ? usable : [rows.reduce((a, b) => (a.m.memoryBytes <= b.m.memoryBytes ? a : b))];
  const acc = (r: (typeof rows)[number]) => effectiveAccuracy(r.m, language);

  const pickBy = (cands: typeof pool, better: (a: (typeof pool)[number], b: (typeof pool)[number]) => boolean) =>
    cands.reduce((best, r) => (better(r, best) ? r : best));

  const balanced = pickBy(pool, (a, b) => balancedScore(a.m, a.e, language, d.memoryBudget) > balancedScore(b.m, b.e, language, d.memoryBudget));

  const tolerable = pool.filter((r) => r.e.latencySec <= 4);
  const accuracy = pickBy(tolerable.length ? tolerable : pool, (a, b) =>
    acc(a) > acc(b) + 0.01 || (Math.abs(acc(a) - acc(b)) <= 0.01 && a.e.latencySec < b.e.latencySec));

  // Fastest: the quickest model, preferring the more accurate one when the
  // difference is imperceptible (< 150 ms).
  const quickest = Math.min(...pool.map((r) => r.e.latencySec));
  const speed = pickBy(pool.filter((r) => r.e.latencySec <= quickest + 0.15), (a, b) => acc(a) > acc(b));

  const decent = pool.filter((r) => acc(r) >= 70);
  const memoryPool = (decent.length ? decent : pool).filter((r) => r.e.latencySec <= 3);
  const memory = pickBy(memoryPool.length ? memoryPool : pool, (a, b) =>
    a.m.memoryBytes < b.m.memoryBytes || (a.m.memoryBytes === b.m.memoryBytes && acc(a) > acc(b)));

  const make = (goal: RecommendationGoal, r: (typeof pool)[number]): Recommendation => ({
    goal,
    modelId: r.m.id,
    title: TITLES[goal],
    reason: reasonFor(goal, r.m, r.e, d),
    estimate: r.e,
  });

  const recommended = make('balanced', balanced);
  return {
    recommended,
    picks: [recommended, make('accuracy', accuracy), make('speed', speed), make('memory', memory)],
    estimates: rows.map((r) => r.e),
    device: d.device,
    deviceLabel: d.label,
    summary: summaryFor(hw, d, balanced.m, balanced.e),
  };
}

export function formatLatency(sec: number): string {
  if (sec < 0.35) return 'instantly';
  if (sec < 0.95) return 'in under a second';
  if (sec < 1.5) return 'in about a second';
  return `in about ${Math.round(sec)} seconds`;
}

function reasonFor(goal: RecommendationGoal, m: ModelSpec, e: ModelEstimate, d: DeviceSpeed): string {
  const where = d.device === 'gpu' ? 'on your graphics card' : 'on your processor';
  const when = formatLatency(e.latencySec);
  switch (goal) {
    case 'balanced':
      return `The best balance of accuracy and speed ${where}. A typical sentence appears ${when}.`;
    case 'accuracy':
      return `The most accurate model this PC runs comfortably. Sentences appear ${when}.`;
    case 'speed':
      return `Text appears ${when}, with accuracy that holds up for everyday writing.`;
    case 'memory':
      return `Uses only about ${formatBytes(m.memoryBytes)} of memory, leaving room for everything else you run.`;
  }
}

function summaryFor(hw: HardwareProfile, d: DeviceSpeed, m: ModelSpec, e: ModelEstimate): string {
  const mem = formatBytes(hw.totalMemory);
  if (d.device === 'gpu' && d.gpu) {
    return `Quill will use your ${d.gpu.name} for transcription. ${m.name} runs ${formatLatency(e.latencySec)} — everything stays on this PC.`;
  }
  const gpuNote = hw.gpus.some((g) => !g.integrated && g.vramBytes >= 2 * GiB) && !hw.vulkan
    ? ' Update your graphics driver to let Quill use your graphics card.'
    : '';
  return `Quill will run on your ${d.label} with ${mem} of memory. ${m.name} transcribes ${formatLatency(e.latencySec)}.${gpuNote}`;
}

export function shortCpuName(brand: string): string {
  const b = brand.replace(/\(R\)|\(TM\)|CPU|Processor|@.*$/gi, '').replace(/\s+/g, ' ').trim();
  const m =
    b.match(/(Core\s+(Ultra\s+)?i?\d[\w-]*\s*[\w-]*)/i) ||
    b.match(/(Ryzen\s+(AI\s+)?\d+\s*[\w-]*)/i) ||
    b.match(/(Snapdragon[\w\s-]+)/i) ||
    b.match(/(Apple\s+M\d\w*)/i);
  if (m) return m[1].replace(/\s+\d+-Core$/i, '').trim();
  return b.split(' ').slice(0, 3).join(' ') || 'processor';
}
