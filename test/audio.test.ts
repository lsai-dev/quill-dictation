import { describe, expect, it } from 'vitest';
import { analyzeSpeech, prepareForModel, SAMPLE_RATE } from '../src/shared/audio';

function noise(sec: number, level: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(sec * SAMPLE_RATE));
  let x = seed;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out[i] = ((x / 2147483648) * 2 - 1) * level;
  }
  return out;
}

/** Syllable-like bursts of a voiced tone. */
function speech(sec: number, level: number): Float32Array {
  const out = new Float32Array(Math.round(sec * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
    out[i] = level * env * (Math.sin(2 * Math.PI * 180 * t) * 0.6 + Math.sin(2 * Math.PI * 360 * t) * 0.3);
  }
  return out;
}

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const mix = (a: Float32Array, b: Float32Array) => a.map((x, i) => x + (b[i] ?? 0));

describe('analyzeSpeech', () => {
  it('finds no speech in silence or steady noise', () => {
    expect(analyzeSpeech(new Float32Array(SAMPLE_RATE)).hasSpeech).toBe(false);
    expect(analyzeSpeech(noise(2, 0.02)).hasSpeech).toBe(false);
  });

  it('detects quiet speech in a quiet room and trims around it', () => {
    const clip = mix(concat(new Float32Array(SAMPLE_RATE), speech(1.5, 0.05), new Float32Array(SAMPLE_RATE)), noise(3.5, 0.002));
    const a = analyzeSpeech(clip);
    expect(a.hasSpeech).toBe(true);
    expect(a.speechMs).toBeGreaterThan(700);
    expect(a.start).toBeGreaterThan(0.5 * SAMPLE_RATE);
    expect(a.start).toBeLessThan(1.0 * SAMPLE_RATE);
    expect(a.end).toBeLessThan(clip.length);
  });

  it('detects speech over café noise', () => {
    const clip = mix(concat(noise(1, 0), speech(2, 0.3), noise(1, 0)), noise(4, 0.03, 7));
    expect(analyzeSpeech(clip).hasSpeech).toBe(true);
  });

  it('normalizes quiet audio without clipping', () => {
    const { audio } = prepareForModel(concat(new Float32Array(8000), speech(1, 0.02), new Float32Array(8000)));
    const peak = audio.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeGreaterThan(0.15); // gain is capped at +21.6 dB
    expect(peak).toBeLessThanOrEqual(0.71);
  });
});
