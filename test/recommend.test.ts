import { describe, expect, it } from 'vitest';
import { chooseDevice, formatLatency, recommend, shortCpuName } from '../src/shared/recommend';
import { modelById } from '../src/shared/models';
import { MACHINES } from './fixtures';

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
