import { CLEANUP_MODELS, cleanupModelById, cleanupSupports } from './cleanupModels';
import { formatBytes, modelById, modelsForLanguage } from './models';
import type {
  CleanupEstimate,
  CleanupModelSpec,
  EnginePreference,
  GpuInfo,
  HardwareProfile,
  ModelEstimate,
  ModelSpec,
  Recommendation,
  RecommendationGoal,
  RecommendationSet,
  SetupRecommendation,
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
  // Measured: whisper.cpp's SSE-only build is ~8× slower than its AVX2 build.
  let simd = 0.13;
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

  // On slow machines nothing is "fast", so limits scale with the quickest option.
  const quickest = Math.min(...pool.map((r) => r.e.latencySec));
  const tolerable = pool.filter((r) => r.e.latencySec <= Math.max(4, quickest * 1.8));
  const accuracy = pickBy(tolerable, (a, b) =>
    acc(a) > acc(b) + 0.01 || (Math.abs(acc(a) - acc(b)) <= 0.01 && a.e.latencySec < b.e.latencySec));

  // Fastest: the quickest model, preferring the more accurate one when the
  // difference is imperceptible (< 150 ms).
  const speed = pickBy(pool.filter((r) => r.e.latencySec <= quickest + 0.15), (a, b) => acc(a) > acc(b));

  const decent = pool.filter((r) => acc(r) >= 70);
  const memoryPool = (decent.length ? decent : pool).filter((r) => r.e.latencySec <= Math.max(3, quickest * 1.8));
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

/*
 * Cleanup: dictation and polish, planned together
 * ────────────────────────────────────────────────
 * A cleanup model generates text one token at a time, and each token reads every
 * weight once — so on a processor its speed is set mostly by memory bandwidth, and
 * on a graphics card by video-memory bandwidth. Reading the prompt is compute-bound.
 * Constants are calibrated against published llama.cpp measurements (see
 * docs/cleanup-models.md): a Ryzen 9 3900X decodes a 2.1 GB Q4 model at ≈17 tok/s
 * (≈36 GB/s effective) and Qwen3.5 0.8B at ≈44 tok/s.
 *
 * Both models stay loaded, so they must fit together — plus each engine's runtime
 * and room for everything else you run.
 */
const CPU_BANDWIDTH = 32e9; // bytes/s, reference desktop, effective
const CPU_FLOPS = 700e9; // effective prompt-processing throughput of the reference CPU
const TOKEN_OVERHEAD_SEC = 0.006;
const CLEANUP_PROMPT_TOKENS = 60; // a 10 s dictation in its prompt wrapper (the instructions are cached)
const CLEANUP_OUTPUT_TOKENS = 45;
const CLEANUP_FIXED_SEC = 0.05;
/** Drafting from the transcript (dense models only) cuts the number of decoding steps. */
const DRAFT_SPEEDUP = { cpu: 2.0, gpu: 2.5 };
/** Each inference engine's own footprint: process, runtime and scratch buffers. */
export const ENGINE_RUNTIME_BYTES = 180 * MiB;
const GPU_CONTEXT_BYTES = 250 * MiB;

/** Memory Quill's models may use together, after leaving room for the system and your apps. */
export function systemBudget(hw: HardwareProfile): number {
  const total = hw.totalMemory;
  const avail = hw.availableMemory || total * 0.5;
  const reserve = Math.max(2.5 * GiB, total * 0.3);
  return Math.max(0, Math.min(total - reserve, Math.max(avail * 0.8, total * 0.35)));
}

/** Effective memory bandwidth of a graphics card, in bytes/s. */
export function gpuBandwidth(g: GpuInfo): number {
  if (g.vendor === 'apple') return 100e9;
  if (g.integrated) return 60e9;
  if (g.vendor === 'intel') return 250e9;
  const vram = g.vramBytes / GiB;
  if (vram >= 12) return 360e9;
  if (vram >= 8) return 300e9;
  if (vram >= 6) return 250e9;
  if (vram >= 4) return 150e9;
  return 100e9;
}

/** The cleanup engine is built for AVX2 (x86) or NEON (ARM) processors. */
export function cleanupCpuSupported(hw: HardwareProfile): boolean {
  return hw.cpu.avx2 || hw.cpu.neon;
}

export function cleanupLatency(m: CleanupModelSpec, hw: HardwareProfile, device: 'gpu' | 'cpu', gpu?: GpuInfo): number {
  const draft = m.architecture === 'dense' ? DRAFT_SPEEDUP[device] : 1;
  if (device === 'gpu' && gpu) {
    const perToken = m.sizeBytes / gpuBandwidth(gpu) + 0.004;
    const prompt = (CLEANUP_PROMPT_TOKENS * 2 * m.params) / (CPU_FLOPS * gpuSpeed(gpu) * 3);
    return prompt + (CLEANUP_OUTPUT_TOKENS * perToken) / draft + CLEANUP_FIXED_SEC;
  }
  const f = Math.max(0.05, cpuSpeed(hw));
  const bandwidth = CPU_BANDWIDTH * Math.min(1.25, Math.max(0.35, Math.sqrt(f)));
  const perToken = m.sizeBytes / bandwidth + TOKEN_OVERHEAD_SEC / Math.max(0.3, f);
  const prompt = (CLEANUP_PROMPT_TOKENS * 2 * m.params) / (CPU_FLOPS * f);
  return prompt + (CLEANUP_OUTPUT_TOKENS * perToken) / draft + CLEANUP_FIXED_SEC;
}

function cleanupScore(m: CleanupModelSpec, e: CleanupEstimate, budget: number): number {
  const lat = e.latencySec;
  const latencyPenalty = 6 * Math.max(0, lat - 0.8) + 10 * Math.max(0, lat - 2.0);
  const downloadPenalty = 1.0 * (m.sizeBytes / GiB);
  const memoryPenalty = 3 * (e.memoryBytes / Math.max(budget, 1));
  return m.quality - latencyPenalty - downloadPenalty - memoryPenalty;
}

/** Cleanup that would add more than this to a dictation isn't recommended (it stays available). */
export const CLEANUP_MAX_LATENCY_SEC = 3;

/**
 * Plans dictation and cleanup together. The dictation pick is `recommend()`'s (or the
 * model you chose); cleanup is the best model that fits beside it — on the graphics
 * card when there's room, otherwise on the processor — and answers quickly enough.
 */
export function recommendSetup(
  hw: HardwareProfile,
  language: string,
  pref: EnginePreference = 'auto',
  opts: { dictationId?: string | null; recs?: RecommendationSet } = {},
): SetupRecommendation {
  const recs = opts.recs ?? recommend(hw, language, pref);
  const d = chooseDevice(hw, pref);
  const chosen = opts.dictationId ? modelById(opts.dictationId) : undefined;
  const dictation = chosen ?? modelById(recs.recommended.modelId)!;
  const dictEst = recs.estimates.find((e) => e.modelId === dictation.id) ?? estimate(dictation, d);

  const ram = systemBudget(hw);
  // What's left for cleanup in each place, once dictation has what it needs.
  const ramForDictation = d.device === 'cpu' ? dictation.memoryBytes : 0;
  const ramLeft = ram - ramForDictation - ENGINE_RUNTIME_BYTES * 2;
  const vramLeft = d.device === 'gpu' && d.gpu ? d.memoryBudget - dictation.memoryBytes - GPU_CONTEXT_BYTES : 0;
  const cpuOk = cleanupCpuSupported(hw);

  const estimates: CleanupEstimate[] = CLEANUP_MODELS.map((m) => {
    const supported = cleanupSupports(m, language) && (cpuOk || vramLeft >= m.memoryBytes);
    const onGpu = d.device === 'gpu' && !!d.gpu && vramLeft >= m.memoryBytes;
    const device: 'gpu' | 'cpu' = onGpu ? 'gpu' : 'cpu';
    const latency = cleanupLatency(m, hw, device, d.gpu);
    const fits = onGpu || (cpuOk && ramLeft >= m.memoryBytes);
    let rating: CleanupEstimate['rating'] = 'slow';
    if (!supported || !fits) rating = 'unsupported';
    else if (latency <= 1.0) rating = 'great';
    else if (latency <= 2.5) rating = 'good';
    return {
      modelId: m.id,
      latencySec: Math.round(latency * 100) / 100,
      memoryBytes: m.memoryBytes,
      fits,
      device,
      rating,
      supported,
    };
  });

  const usable = estimates.filter((e) => e.supported && e.fits && e.latencySec <= CLEANUP_MAX_LATENCY_SEC);
  const best = usable.length
    ? usable.reduce((a, b) =>
        cleanupScore(cleanupModelById(b.modelId)!, b, ram) > cleanupScore(cleanupModelById(a.modelId)!, a, ram) ? b : a)
    : null;
  const cm = best ? cleanupModelById(best.modelId)! : null;
  const memoryBytes =
    dictation.memoryBytes + ENGINE_RUNTIME_BYTES + (best ? best.memoryBytes + ENGINE_RUNTIME_BYTES : 0);

  return {
    dictationId: dictation.id,
    cleanupId: best?.modelId ?? null,
    cleanup: best,
    cleanupEstimates: estimates,
    totalLatencySec: Math.round((dictEst.latencySec + (best?.latencySec ?? 0)) * 100) / 100,
    memoryBytes,
    memoryBudget: d.device === 'gpu' ? d.memoryBudget + ram : ram,
    reason: cleanupReason(hw, language, estimates, best, cm),
  };
}

function cleanupReason(hw: HardwareProfile, language: string, all: CleanupEstimate[], best: CleanupEstimate | null, m: CleanupModelSpec | null): string {
  if (best && m) {
    const where = best.device === 'gpu' ? 'on your graphics card' : 'on your processor';
    return `${m.name} polishes a typical sentence ${formatLatency(best.latencySec)} ${where}, next to your dictation model.`;
  }
  if (!cleanupCpuSupported(hw) && !all.some((e) => e.device === 'gpu' && e.fits)) {
    return 'Cleanup needs a newer processor than this PC has. Dictation works just the same without it.';
  }
  const candidates = all.filter((e) => e.supported);
  if (!candidates.length) return `None of the cleanup models handle ${language === 'auto' ? 'every language' : 'this language'} well yet.`;
  if (!candidates.some((e) => e.fits)) return 'Cleanup needs more free memory than this PC has next to your dictation model.';
  const quickest = Math.min(...candidates.filter((e) => e.fits).map((e) => e.latencySec));
  return `Cleanup would add about ${Math.max(1, Math.round(quickest))} seconds to each dictation on this PC, so it’s off by default.`;
}
