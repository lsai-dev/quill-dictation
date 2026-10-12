/**
 * Speech detection and conditioning for captured audio (16 kHz mono f32).
 *
 * The detector adapts to the room: it estimates the noise floor from the
 * quietest frames of the recording itself, so it works for a whisper in a
 * library and a normal voice in a café.
 */

export const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms

export interface SpeechAnalysis {
  speechMs: number;
  /** Trimmed range (sample indices), padded so word edges are never clipped. */
  start: number;
  end: number;
  peak: number;
  rmsDb: number;
  noiseDb: number;
  hasSpeech: boolean;
}

export function frameDb(samples: Float32Array): Float32Array {
  const n = Math.floor(samples.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    const o = f * FRAME;
    for (let i = 0; i < FRAME; i++) s += samples[o + i] * samples[o + i];
    out[f] = 10 * Math.log10(s / FRAME + 1e-12);
  }
  return out;
}

export function analyzeSpeech(samples: Float32Array): SpeechAnalysis {
  const db = frameDb(samples);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sum += samples[i] * samples[i];
  }
  const rmsDb = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
  if (db.length === 0) {
    return { speechMs: 0, start: 0, end: samples.length, peak, rmsDb, noiseDb: -100, hasSpeech: false };
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const noiseDb = sorted[Math.floor(sorted.length * 0.15)];
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  // Threshold sits between the room and the voice, but never below -55 dBFS.
  const threshold = Math.max(-55, noiseDb + Math.max(8, (loud - noiseDb) * 0.35));

  // Speech frames with a short hangover so consonants between vowels count.
  let speechFrames = 0;
  let first = -1;
  let last = -1;
  let hang = 0;
  for (let f = 0; f < db.length; f++) {
    if (db[f] > threshold) {
      hang = 8; // 160 ms
      if (first < 0) first = f;
      last = f;
    }
    if (hang > 0) {
      speechFrames++;
      hang--;
    }
  }
  // Require a meaningful dynamic range too — steady fan noise is not speech.
  const dynamic = loud - noiseDb;
  const speechMs = speechFrames * 20;
  const hasSpeech = first >= 0 && dynamic > 9 && speechMs >= 200;
  const pad0 = Math.round(0.3 * SAMPLE_RATE);
  const pad1 = Math.round(0.45 * SAMPLE_RATE);
  const start = hasSpeech ? Math.max(0, first * FRAME - pad0) : 0;
  const end = hasSpeech ? Math.min(samples.length, (last + 1) * FRAME + pad1) : samples.length;
  return { speechMs: hasSpeech ? speechMs : 0, start, end, peak, rmsDb, noiseDb, hasSpeech };
}

/**
 * Bring quiet recordings up to a healthy level (whisper is noticeably less
 * accurate on very quiet input) without ever clipping.
 */
export function normalize(samples: Float32Array, peak: number): Float32Array {
  if (peak <= 1e-6) return samples;
  const target = 0.7;
  const gain = Math.min(target / peak, 12); // at most +21.6 dB
  if (gain <= 1.05 && gain >= 0.95) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

/** Trim to the speech range and normalize — what we send to the model. */
export function prepareForModel(samples: Float32Array): { audio: Float32Array; analysis: SpeechAnalysis } {
  const analysis = analyzeSpeech(samples);
  const trimmed = samples.subarray(analysis.start, analysis.end);
  let peak = 0;
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]));
  return { audio: normalize(trimmed, peak), analysis };
}
