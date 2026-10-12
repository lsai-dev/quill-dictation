import { describe, expect, it } from 'vitest';
import { chooseDevice, CLEANUP_MAX_LATENCY_SEC, cleanupThroughput, ENGINE_RUNTIME_BYTES, formatLatency, recommend, recommendSetup, shortCpuName, systemBudget } from '../src/shared/recommend';
import { modelById } from '../src/shared/models';
import { cleanupModelById, cleanupSupports } from '../src/shared/cleanupModels';
import { machine, MACHINES } from './fixtures';

const pick = (set: ReturnType<typeof recommend>, goal: string) => set.picks.find((p) => p.goal === goal)!;

describe('recommendations', () => {
  it('prints a table for review', () => {
    for (const [name, hw] of Object.entries(MACHINES)) {
      const r = recommend(hw, 'en');
      const line = r.picks.map((p) => `${p.goal}=${p.modelId}(${p.estimate.latencySec}s)`).join('  ');
      console.log(`${name.padEnd(16)} ${r.device}  ${line}`);
    }
  });

  it('uses a discrete GPU automatically and recommends a large model', () => {
    const r = recommend(MACHINES.gamingDesktop, 'en');
    expect(r.device).toBe('gpu');
    expect(modelById(r.recommended.modelId)!.family).toMatch(/large/);
    expect(r.recommended.estimate.latencySec).toBeLessThan(1.2);
    expect(r.deviceLabel).toContain('RTX 3060');
  });

  it('keeps integrated graphics on the CPU path and stays responsive', () => {
    const r = recommend(MACHINES.ultrabook, 'en');
    expect(r.device).toBe('cpu');
    expect(r.recommended.estimate.latencySec).toBeLessThan(2.5);
    expect(['small.en', 'small.en-q5_1', 'base.en']).toContain(r.recommended.modelId);
  });

  it('chooses something light that fits on a low-memory laptop', () => {
    const r = recommend(MACHINES.budgetLaptop, 'en');
    for (const p of r.picks) expect(p.estimate.fits).toBe(true);
    expect(modelById(r.recommended.modelId)!.memoryBytes).toBeLessThan(600 * 1024 ** 2);
    expect(pick(r, 'memory').modelId).toBe('base.en-q5_1');
  });

  it('never recommends something far slower than the machine can manage', () => {
    for (const hw of Object.values(MACHINES)) {
      const r = recommend(hw, 'en');
      const quickest = Math.min(...r.estimates.filter((e) => e.fits).map((e) => e.latencySec));
      for (const p of r.picks) expect(p.estimate.latencySec).toBeLessThanOrEqual(Math.max(4, quickest * 1.8) + 1e-9);
    }
  });

  it('gives the workstation the most accurate model', () => {
    const r = recommend(MACHINES.workstation, 'en');
    expect(pick(r, 'accuracy').modelId).toBe('large-v3');
  });

  it('respects small VRAM by picking compressed large models', () => {
    const r = recommend(MACHINES.smallGpu, 'en');
    expect(r.device).toBe('gpu');
    const acc = modelById(pick(r, 'accuracy').modelId)!;
    expect(acc.memoryBytes).toBeLessThanOrEqual(4 * 1024 ** 3 * 0.85);
  });

  it('falls back to CPU when no Vulkan loader exists and says how to fix it', () => {
    const r = recommend(MACHINES.gpuNoVulkan, 'en');
    expect(r.device).toBe('cpu');
    expect(r.summary).toMatch(/graphics driver/);
  });

  it('honours an explicit CPU preference', () => {
    expect(chooseDevice(MACHINES.gamingDesktop, 'cpu').device).toBe('cpu');
    expect(chooseDevice(MACHINES.ultrabook, 'gpu').device).toBe('gpu');
  });

  it('only offers multilingual models for other languages', () => {
    const r = recommend(MACHINES.midDesktopNoGpu, 'de');
    for (const p of r.picks) expect(modelById(p.modelId)!.englishOnly).toBe(false);
  });

  it('lightest is never heavier than recommended; fastest never slower', () => {
    for (const hw of Object.values(MACHINES)) {
      const r = recommend(hw, 'en');
      const rec = r.recommended;
      expect(modelById(pick(r, 'memory').modelId)!.memoryBytes).toBeLessThanOrEqual(modelById(rec.modelId)!.memoryBytes);
      expect(pick(r, 'speed').estimate.latencySec).toBeLessThanOrEqual(rec.estimate.latencySec + 0.16);
    }
  });

  it('formats friendly names', () => {
    expect(shortCpuName('AMD Ryzen 7 5800X 8-Core Processor')).toBe('Ryzen 7 5800X');
    expect(shortCpuName('11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz')).toBe('Core i7-1165G7');
    expect(formatLatency(0.2)).toBe('instantly');
    expect(formatLatency(2.4)).toBe('in about 2 seconds');
  });
});

describe('dictation + cleanup setup', () => {
  const GiB = 1024 ** 3;
  const setup = (hw: (typeof MACHINES)[keyof typeof MACHINES], lang = 'en', dictationId?: string) =>
    recommendSetup(hw, lang, 'auto', { dictationId });

  it('prints a table for review', () => {
    for (const lang of ['en', 'es']) {
      for (const [name, hw] of Object.entries(MACHINES)) {
        const s = setup(hw, lang);
        const all = s.cleanupEstimates.filter((e) => e.supported).map((e) => `${e.modelId}:${e.device}:${e.fits ? e.latencySec : '×'}`).join(' ');
        console.log(`${lang} ${name.padEnd(16)} ${s.dictationId.padEnd(20)} + ${(s.cleanupId ?? '—').padEnd(18)} total ${s.totalLatencySec}s  [${all}]`);
      }
    }
  });

  it('puts the best cleanup model on a big graphics card, next to dictation', () => {
    const s = setup(MACHINES.gamingDesktop);
    expect(s.cleanupId).toBe('qwen3.5-4b');
    expect(s.cleanup!.device).toBe('gpu');
    expect(s.cleanup!.latencySec).toBeLessThan(1);
    expect(s.totalLatencySec).toBeLessThan(2);
  });

  it('prefers the English specialist on a processor, and a multilingual model for Spanish', () => {
    expect(setup(MACHINES.midDesktopNoGpu, 'en').cleanupId).toBe('s1-mini');
    const es = setup(MACHINES.midDesktopNoGpu, 'es');
    expect(es.cleanupId).not.toBeNull();
    expect(cleanupModelById(es.cleanupId)!.languages).not.toEqual(['en']);
  });

  it('never recommends a model that does not handle the language', () => {
    for (const lang of ['en', 'es', 'de', 'ru', 'auto']) {
      for (const hw of Object.values(MACHINES)) {
        const s = setup(hw, lang);
        if (s.cleanupId) expect(cleanupSupports(cleanupModelById(s.cleanupId)!, lang)).toBe(true);
      }
    }
  });

  it('keeps both models, their runtimes and system headroom within memory', () => {
    for (const hw of Object.values(MACHINES)) {
      const s = setup(hw);
      if (!s.cleanup) continue;
      const dict = modelById(s.dictationId)!;
      const onGpu = s.cleanup.device === 'gpu';
      const ramUsed = (chooseDevice(hw, 'auto').device === 'cpu' ? dict.memoryBytes : 0) + (onGpu ? 0 : s.cleanup.memoryBytes) + 2 * ENGINE_RUNTIME_BYTES;
      expect(ramUsed).toBeLessThanOrEqual(systemBudget(hw));
      expect(hw.totalMemory - ramUsed).toBeGreaterThanOrEqual(2.5 * GiB);
    }
  });

  it('accounts for the dictation model you chose', () => {
    // A heavier dictation model on a 4 GB card leaves no room for cleanup there.
    const light = setup(MACHINES.smallGpu, 'en', 'base.en');
    const heavy = setup(MACHINES.smallGpu, 'en', 'large-v3-q5_0');
    expect(light.dictationId).toBe('base.en');
    const lightGpu = light.cleanupEstimates.filter((e) => e.device === 'gpu').length;
    const heavyGpu = heavy.cleanupEstimates.filter((e) => e.device === 'gpu').length;
    expect(lightGpu).toBeGreaterThan(heavyGpu);
  });

  it('declines cleanup where it cannot run or would be slow, and says why', () => {
    const budget = setup(MACHINES.budgetLaptop);
    expect(budget.cleanupId).toBeNull();
    expect(budget.reason).toMatch(/newer processor|memory/);
    const slow = setup(MACHINES.ultrabook, 'es');
    if (!slow.cleanupId) expect(slow.reason).toMatch(/seconds/);
  });

  it('keeps every recommended cleanup within the latency limit', () => {
    for (const lang of ['en', 'es']) {
      for (const hw of Object.values(MACHINES)) {
        const s = setup(hw, lang);
        if (s.cleanup) expect(s.cleanup.latencySec).toBeLessThanOrEqual(CLEANUP_MAX_LATENCY_SEC);
      }
    }
  });

  it('memory budget leaves room for the system', () => {
    expect(systemBudget(MACHINES.budgetLaptop)).toBeLessThan(1.6 * GiB);
    expect(systemBudget(MACHINES.ultrabook)).toBeGreaterThan(5 * GiB);
    expect(systemBudget(MACHINES.ultrabook)).toBeLessThan(11.3 * GiB);
  });
});

describe('cleanup speed model', () => {
  // Measured by `npm run eval:cleanup` in CI (run 27): Intel Xeon Platinum 8573C,
  // 2 cores / 4 threads, 4 inference threads, generation speed including drafting.
  const ciRunner = machine({ cores: 2, threads: 4, ramGb: 16, avx512: true, brand: 'INTEL(R) XEON(R) PLATINUM 8573C' });
  const measured: Record<string, number> = { 's1-mini': 65.4, 'qwen3.5-2b': 21.5, 'granite-4.0-micro': 12.4, 'qwen3.5-4b': 10.1 };

  it('predicts measured generation speed within 35%, erring slow', () => {
    for (const [id, tokPerSec] of Object.entries(measured)) {
      const est = cleanupThroughput(cleanupModelById(id)!, ciRunner, 'cpu').decode;
      console.log(`${id.padEnd(18)} measured ${tokPerSec} tok/s · estimated ${est.toFixed(1)} tok/s`);
      expect(est / tokPerSec).toBeGreaterThan(0.65);
      expect(est / tokPerSec).toBeLessThan(1.2);
    }
  });

  it('ranks the models by speed the way the measurements do', () => {
    const order = Object.keys(measured).sort((a, b) => cleanupThroughput(cleanupModelById(b)!, ciRunner, 'cpu').decode - cleanupThroughput(cleanupModelById(a)!, ciRunner, 'cpu').decode);
    expect(order).toEqual(Object.keys(measured).sort((a, b) => measured[b] - measured[a]));
  });
});
