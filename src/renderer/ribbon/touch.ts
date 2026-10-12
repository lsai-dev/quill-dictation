import { clamp } from './spring';

/** Control points along the ribbon. The shader interpolates between them. */
export const TOUCH_NODES = 24;

const LEN = 2.55; // keep in step with shaders.ts
const TAU = Math.PI * 2;

/** The resting centreline, mirrored from shaders.ts, so the pointer can find the ribbon. */
export function restCurve(s: number): [number, number, number] {
  return [s * LEN, 0.14 * Math.sin(TAU * s * 0.85 + 0.25), 0.3 * Math.tanh(5.5 * s) + 0.35 * (0.25 - s * s)];
}

// Each node is held to its resting place by a soft spring and to its
// neighbours by tension, so a push travels along the band and rings out the
// way a real ribbon does instead of moving as one stiff piece.
const K_REST = (TAU / 0.85) ** 2;
const C_REST = (4 * Math.PI * 0.22) / 0.85;
const TENSION = 1400;
const TENSION_TWIST = 650;
const K_TWIST = (TAU / 0.6) ** 2;
const C_TWIST = (4 * Math.PI * 0.18) / 0.6;
const FRICTION = 25; // internal friction: damps the short, buzzy wavelengths
const K_GRAB = 900;
const C_GRAB = 2 * Math.sqrt(K_GRAB) * 0.7;
const AIR = 14;
const SUBSTEP = 1 / 240;
// How far the band will follow a pull before it resists (world units).
const REACH_X = 0.5;
const REACH_Y = 0.55;

const softLimit = (x: number, m: number) => m * Math.tanh(x / m);

export interface TouchProjector {
  /** CSS-pixel position of a world point within the canvas. */
  (p: number[]): [number, number];
}

/**
 * The ribbon under your hand. Tracks the pointer over the canvas and simulates
 * how the band answers it: a passing cursor stirs it like a breath of air,
 * resting near it makes it lean away, and you can catch it and pull — let go
 * and it swings back and settles.
 */
export class RibbonTouch {
  /** Per node: x, y, z displacement and extra twist — uploaded as `uTouch[]`. */
  readonly out = new Float32Array(TOUCH_NODES * 4);
  /** 0…1: how close the pointer is to the band (for light, cursor). */
  hover = 0;
  grabbing = false;
  enabled = true;

  private d = [0, 1, 2, 3].map(() => new Float32Array(TOUCH_NODES));
  private v = [0, 1, 2, 3].map(() => new Float32Array(TOUCH_NODES));
  private sx = new Float32Array(TOUCH_NODES);
  private sy = new Float32Array(TOUCH_NODES);
  private ppw = new Float32Array(TOUCH_NODES);
  private w = new Float32Array(TOUCH_NODES);

  private inside = false;
  private px = 0;
  private py = 0;
  private pvx = 0;
  private pvy = 0;
  private lastMove = 0;
  private grabNode = -1;
  private grabId = -1;
  private grabOff: [number, number] = [0, 0];
  private grabTarget: [number, number, number] = [0, 0, 0];
  private pendingGrab = false;
  private acc = 0;
  private detach: () => void;

  constructor(private el: HTMLElement) {
    const pos = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const move = (e: PointerEvent) => {
      const [x, y] = pos(e);
      const now = e.timeStamp / 1000;
      const dt = now - this.lastMove;
      if (this.inside && dt > 0 && dt < 0.1) {
        // Smoothed pointer velocity, px/s.
        const a = 1 - Math.exp(-dt / 0.035);
        this.pvx += ((x - this.px) / dt - this.pvx) * a;
        this.pvy += ((y - this.py) / dt - this.pvy) * a;
      }
      this.px = x;
      this.py = y;
      this.lastMove = now;
      this.inside = true;
    };
    const leave = (e: PointerEvent) => {
      if (this.grabId === e.pointerId) return;
      this.inside = false;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      move(e);
      this.pendingGrab = true;
      this.grabId = e.pointerId;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.grabId) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      this.release();
      if (e.type === 'pointercancel') this.inside = false;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.detach = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.style.cursor = '';
    };
  }

  private release() {
    this.grabbing = false;
    this.grabNode = -1;
    this.grabId = -1;
    this.pendingGrab = false;
  }

  /**
   * Advance the simulation. `extent` is how unfurled the ribbon is; `project`
   * maps world points to canvas pixels (null before the first render).
   */
  step(dt: number, extent: number, project: TouchProjector | null) {
    const N = TOUCH_NODES;
    const active = this.enabled && !!project && extent > 0.5;
    if (!active && this.grabbing) this.release();
    if (!active) this.pendingGrab = false;

    // Where the band is on screen now, and how near the pointer is to each part of it.
    let best = -1;
    let bestW = 0;
    let hover = 0;
    for (let i = 0; i < N; i++) {
      this.w[i] = 0;
      if (!active) continue;
      const s = (i / (N - 1) - 0.5) * extent;
      const r = restCurve(s);
      const p = [r[0] + this.d[0][i], r[1] + this.d[1][i], r[2] + this.d[2][i]];
      const [x, y] = project!(p);
      const [, y2] = project!([p[0], p[1] + 0.1, p[2]]);
      this.sx[i] = x;
      this.sy[i] = y;
      this.ppw[i] = Math.max(1, Math.abs(y - y2) / 0.1);
      if (!this.inside) continue;
      const wx = (this.px - x) / this.ppw[i];
      const wy = (y - this.py) / this.ppw[i];
      const w = Math.exp(-((wx * wx) / 0.09 + (wy * wy) / 0.055));
      this.w[i] = w;
      if (w > bestW) { bestW = w; best = i; }
      hover = Math.max(hover, w);
    }
    this.hover = hover;

    if (this.pendingGrab) {
      this.pendingGrab = false;
      if (best >= 0 && bestW > 0.3) {
        this.grabbing = true;
        this.grabNode = best;
        this.grabOff = [(this.px - this.sx[best]) / this.ppw[best], (this.sy[best] - this.py) / this.ppw[best]];
        try { this.el.setPointerCapture(this.grabId); } catch { /* pointer already gone */ }
      } else {
        this.grabId = -1;
      }
    }
    if (this.grabbing) {
      // Rest position of the held point, plus wherever the pointer has taken it.
      const g = this.grabNode;
      const s = (g / (N - 1) - 0.5) * extent;
      const r = restCurve(s);
      const [rx, ry] = project!(r);
      const k = this.ppw[g];
      const tx = softLimit((this.px - rx) / k - this.grabOff[0], REACH_X);
      const ty = softLimit((ry - this.py) / k - this.grabOff[1], REACH_Y);
      // A pulled band lifts toward you a little, as fabric does.
      this.grabTarget = [tx, ty, 0.3 * Math.hypot(tx, ty)];
    }
    this.el.style.cursor = !active ? '' : this.grabbing ? 'grabbing' : hover > 0.3 ? 'grab' : '';

    // Pointer velocity in world units (screen y points down).
    const ppwMid = this.ppw[N >> 1] || 1;
    const vx = this.pvx / ppwMid;
    const vy = -this.pvy / ppwMid;

    this.acc += Math.min(dt, 0.1);
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      this.integrate(SUBSTEP, vx, vy);
    }
    // The cursor's breath fades once it stops moving.
    const fade = Math.exp(-dt / 0.08);
    this.pvx *= fade;
    this.pvy *= fade;

    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 4; c++) this.out[i * 4 + c] = this.d[c][i];
    }
  }

  private integrate(h: number, vx: number, vy: number) {
    const N = TOUCH_NODES;
    const [dx, dy, dz, tw] = this.d;
    const [ux, uy, uz, ut] = this.v;
    const g = this.grabNode;
    for (let i = 0; i < N; i++) {
      const a = i > 0 ? i - 1 : i;
      const b = i < N - 1 ? i + 1 : i;
      const w = this.w[i];
      // Resting near the band makes it lean away from the cursor and lift a touch.
      const wy = this.inside ? (this.sy[i] - this.py) / this.ppw[i] : 0;
      const lean = this.grabbing ? 0 : -0.07 * w * clamp(wy / 0.12, -1, 1);
      const lift = this.grabbing ? 0 : 0.04 * w;
      let fx = -K_REST * dx[i] - C_REST * ux[i];
      let fy = -K_REST * (dy[i] - lean) - C_REST * uy[i];
      let fz = -K_REST * (dz[i] - lift) - C_REST * uz[i];
      let ft = -K_TWIST * tw[i] - C_TWIST * ut[i];
      fx += TENSION * 0.6 * (dx[a] - 2 * dx[i] + dx[b]) + FRICTION * (ux[a] - 2 * ux[i] + ux[b]);
      fy += TENSION * (dy[a] - 2 * dy[i] + dy[b]) + FRICTION * (uy[a] - 2 * uy[i] + uy[b]);
      fz += TENSION * (dz[a] - 2 * dz[i] + dz[b]) + FRICTION * (uz[a] - 2 * uz[i] + uz[b]);
      ft += TENSION_TWIST * (tw[a] - 2 * tw[i] + tw[b]) + FRICTION * (ut[a] - 2 * ut[i] + ut[b]);
      if (this.grabbing) {
        const k = Math.exp(-(((i - g) / 2.4) ** 2));
        fx += k * (K_GRAB * (this.grabTarget[0] - dx[i]) - C_GRAB * ux[i]);
        fy += k * (K_GRAB * (this.grabTarget[1] - dy[i]) - C_GRAB * uy[i]);
        fz += k * (K_GRAB * (this.grabTarget[2] - dz[i]) - C_GRAB * uz[i]);
      } else if (w > 1e-3) {
        // A moving cursor drags the air with it: the band is carried along with
        // the stroke, and a stroke past one edge rolls it over a little.
        fx += w * AIR * (vx * 0.45 - ux[i]);
        fy += w * AIR * (vy * 0.9 - uy[i]);
        fz += w * AIR * (Math.abs(vx) * 0.12 - uz[i]);
        const side = clamp(wy / 0.15, -1, 1);
        ft += w * AIR * 1.6 * (-vx * side * 1.4 + vy * (i < N / 2 ? -0.5 : 0.5) - ut[i]);
      }
      ux[i] += fx * h;
      uy[i] += fy * h;
      uz[i] += fz * h;
      ut[i] += ft * h;
    }
    for (let i = 0; i < N; i++) {
      dx[i] += ux[i] * h;
      dy[i] += uy[i] * h;
      dz[i] += uz[i] * h;
      tw[i] = clamp(tw[i] + ut[i] * h, -1.4, 1.4);
    }
  }

  dispose() {
    this.detach();
  }
}
