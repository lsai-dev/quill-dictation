/**
 * Quill's sounds are synthesized, not sampled: soft glassy tones that match
 * the ribbon's material. Quiet by design — confirmation, not decoration.
 */

let ctx: AudioContext | null = null;

function audio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freqs: number[], start: number, dur: number, gain: number, glide = 1) {
  const a = audio();
  const t0 = a.currentTime + start;
  const out = a.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  // A gentle low-pass keeps the attack round.
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  out.connect(lp).connect(a.destination);
  freqs.forEach((f, i) => {
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t0);
    if (glide !== 1) o.frequency.exponentialRampToValueAtTime(f * glide, t0 + dur * 0.6);
    const g = a.createGain();
    g.gain.value = 1 / (i + 1.6);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  });
}

export const sounds = {
  /** Mic opens: a soft rising glass tone. */
  start() {
    tone([740, 1480, 2220], 0, 0.22, 0.05, 1.12);
  },
  /** Mic closes: the same tone, falling. */
  stop() {
    tone([830, 1660], 0, 0.18, 0.04, 0.89);
  },
  /** Text placed: a tiny, bright tick. */
  inserted() {
    tone([1318, 2637], 0, 0.12, 0.03);
  },
  /** Something went wrong: two low, muted taps. */
  error() {
    tone([330, 660], 0, 0.12, 0.05);
    tone([294, 588], 0.13, 0.16, 0.045);
  },
};
