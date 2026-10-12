/**
 * A damped harmonic spring parameterised the way SwiftUI describes springs:
 * `response` is the period of the undamped oscillation in seconds and
 * `damping` is the damping fraction (1 = critically damped, <1 = bouncy).
 *
 * Integration uses fixed sub-steps so motion is identical at 60, 120 or 144 Hz
 * and never explodes after a long frame.
 */
export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private k = 0;
  private c = 0;

  constructor(value = 0, response = 0.5, damping = 1) {
    this.value = value;
    this.target = value;
    this.configure(response, damping);
  }

  configure(response: number, damping: number): this {
    const r = Math.max(0.016, response);
    this.k = (2 * Math.PI / r) ** 2;
    this.c = (4 * Math.PI * damping) / r;
    return this;
  }

  /** Move toward a new target, optionally re-tuning the spring for this move. */
  to(target: number, response?: number, damping?: number): this {
    this.target = target;
    if (response !== undefined) this.configure(response, damping ?? 1);
    return this;
  }

  /** Jump without animation. */
  snap(value: number): this {
    this.value = this.target = value;
    this.velocity = 0;
    return this;
  }

  /** Add instantaneous velocity — used for "kicks" like the settle and the shake. */
  impulse(v: number): this {
    this.velocity += v;
    return this;
  }

  step(dt: number): number {
    const h = 1 / 480;
    let t = Math.min(dt, 0.1);
    while (t > 1e-6) {
      const s = Math.min(h, t);
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * s;
      this.value += this.velocity * s;
      t -= s;
    }
    return this.value;
  }

  get atRest(): boolean {
    return Math.abs(this.value - this.target) < 1e-3 && Math.abs(this.velocity) < 1e-3;
  }
}

/** Frame-rate independent exponential smoothing with separate attack/release. */
export function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
}

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
