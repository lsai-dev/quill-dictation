import type { RibbonState } from './ribbon';
import { clamp, follow, Spring } from './spring';

/**
 * The ribbon for machines without WebGL2: the same silhouette as an SVG,
 * driven by the same springs and the same state API. Less depth, identical
 * choreography — dictation never loses its indicator.
 */
export class FallbackRibbon {
  state: RibbonState = 'hidden';
  private angle = 0;
  onHidden?: () => void;
  onStateChange?: (s: RibbonState) => void;
  manual = false;
  readonly renderer: { toScreen: (p: number[]) => [number, number]; dark: number };

  private root: SVGSVGElement;
  private group: SVGGElement;
  private glow: SVGEllipseElement;
  private raf = 0;
  private last = 0;
  private t = 0;
  private reduced = false;
  private persistent: boolean;
  private cy: number;
  private energy = 0;
  private raw = 0;
  private noiseFloor = -60;
  private queue: { at: number; fn: () => void }[] = [];
  private clock = 0;
  private scale = new Spring(0, 0.55, 0.62);
  private opacity = new Spring(0, 0.25, 1);
  private curl = new Spring(0, 0.8, 0.85);
  private shake = new Spring(0, 0.16, 0.18);
  private light = new Spring(0.5, 0.5, 1);
  // Pointer play: a passing cursor rocks and nudges the ribbon.
  private tilt = new Spring(0, 0.7, 0.3);
  private nudge = new Spring(0, 0.6, 0.35);
  private untouch: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, opts: { persistent?: boolean; anchorY?: number; interactive?: boolean } = {}) {
    this.persistent = !!opts.persistent;
    const anchorY = opts.anchorY ?? 0.5;
    const ns = 'http://www.w3.org/2000/svg';
    this.root = document.createElementNS(ns, 'svg');
    this.root.setAttribute('viewBox', '0 0 300 136');
    this.root.setAttribute('aria-hidden', 'true');
    Object.assign(this.root.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' });
    const cy = 136 * (1 - anchorY);
    this.cy = cy;
    this.root.innerHTML = `
      <defs>
        <linearGradient id="fr-l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfaff"/><stop offset="1" stop-color="#cfc8ea"/></linearGradient>
        <linearGradient id="fr-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c3b5ff"/><stop offset="1" stop-color="#7d66ff"/></linearGradient>
        <filter id="fr-blur"><feGaussianBlur stdDeviation="6"/></filter>
      </defs>
      <ellipse class="fr-shadow" cx="150" cy="${cy + 26}" rx="62" ry="5" fill="rgba(20,16,40,.22)" filter="url(#fr-blur)"/>
      <ellipse class="fr-glow" cx="150" cy="${cy}" rx="40" ry="14" fill="#7d66ff" opacity=".0" filter="url(#fr-blur)"/>
      <g class="fr-ribbon" transform="translate(150 ${cy})">
        <path d="M-76 6C-50 -16 -18 -17 0 -2 -18 6 -50 14 -76 6Z" fill="url(#fr-l)" stroke="rgba(70,50,160,.28)" stroke-width=".8"/>
        <path d="M0 -2C18 -22 50 -26 76 -14 50 -2 18 12 0 -2Z" fill="url(#fr-r)" stroke="rgba(70,50,160,.28)" stroke-width=".8"/>
      </g>`;
    canvas.style.display = 'none';
    canvas.parentElement?.insertBefore(this.root, canvas);
    this.group = this.root.querySelector('.fr-ribbon')!;
    this.glow = this.root.querySelector('.fr-glow')!;
    if (opts.interactive && canvas.parentElement) this.listen(canvas.parentElement);
    const base = cy;
    this.renderer = {
      dark: 0,
      toScreen: (p: number[]) => [canvas.parentElement!.clientWidth / 2 + p[0] * 50, (base / 136) * canvas.parentElement!.clientHeight],
    };
  }

  private listen(stage: HTMLElement) {
    let last: { x: number; y: number; t: number } | null = null;
    const move = (e: PointerEvent) => {
      const r = this.root.getBoundingClientRect();
      const k = 300 / Math.max(1, Math.min(r.width, (r.height * 300) / 136)); // px → viewBox units
      const x = (e.clientX - r.left - r.width / 2) * k;
      const y = (e.clientY - r.top - r.height / 2) * k + 68 - this.cy;
      const t = e.timeStamp / 1000;
      if (last && t > last.t && t - last.t < 0.1 && !this.reduced && Math.abs(x) < 95 && Math.abs(y) < 40) {
        const vy = (y - last.y) / (t - last.t);
        const vx = (x - last.x) / (t - last.t);
        const near = 1 - Math.abs(y) / 40;
        // Push one end and the ribbon rocks about its middle; push it bodily and it bobs.
        this.tilt.impulse(clamp(vy * x * 0.004 * near, -120, 120) - clamp(vx * y * 0.003 * near, -60, 60));
        this.nudge.impulse(clamp(vy * 0.06 * near, -60, 60));
        this.start();
      }
      last = { x, y, t };
    };
    const leave = () => (last = null);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', leave);
    this.untouch = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerleave', leave);
    };
  }

  setDark(d: boolean) { this.renderer.dark = d ? 1 : 0; }
  setReducedMotion(r: boolean) { this.reduced = r; }
  get reducedMotion() { return this.reduced; }
  setEnergy(e: number) { this.raw = clamp(e); }
  setLevel(db: number) {
    if (db < this.noiseFloor) this.noiseFloor += (db - this.noiseFloor) * 0.25;
    else this.noiseFloor += Math.min(0.05, (db - this.noiseFloor) * 0.002);
    this.raw = Math.pow(clamp((db - this.noiseFloor - 4) / 34), 0.85);
  }

  private set(s: RibbonState) {
    if (this.state !== s) { this.state = s; this.onStateChange?.(s); }
  }
  private later(ms: number, fn: () => void) { this.queue.push({ at: this.clock + ms / 1000, fn }); this.queue.sort((a, b) => a.at - b.at); }

  show() { this.queue = []; this.set('activating'); this.opacity.to(1); this.scale.to(1, this.reduced ? 0.3 : 0.6, this.reduced ? 1 : 0.62); this.curl.to(0); this.light.to(0.5); this.later(450, () => this.set('listening')); this.start(); }
  rest() { this.show(); }
  process() { this.queue = []; this.set('processing'); this.curl.to(this.reduced ? 0 : 1); this.light.to(0.9); this.start(); }
  refine() { this.queue = []; this.set('refining'); this.curl.to(this.reduced ? 0 : 0.45, 1.1, 0.92); this.light.to(1); this.start(); }
  success() { this.queue = []; this.set('inserted'); this.curl.to(0, 0.45, 0.9); this.light.to(1, 0.2); if (!this.reduced) this.scale.impulse(-2.2); this.later(520, () => this.fold()); this.start(); }
  cancel() { this.queue = []; this.set('cancelled'); this.curl.to(0); this.fold(); this.start(); }
  error(hold = 1600) { this.queue = []; this.set('error'); this.curl.to(0); if (!this.reduced) this.shake.impulse(-3.4); this.later(hold, () => this.fold()); this.start(); }
  private fold() {
    this.scale.to(this.reduced ? 1 : 0, 0.4, 1);
    this.opacity.to(0, 0.4, 1);
    this.later(520, () => { if (this.persistent) this.show(); else { this.set('hidden'); this.onHidden?.(); } });
  }

  start() {
    if (this.raf || this.manual) return;
    this.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      if (this.state === 'hidden' && this.opacity.value < 0.002) { this.raf = 0; return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  advance(ms: number) { for (let t = 0; t < ms; t += 8.33) this.frame(1 / 120); }

  frame(dt: number) {
    this.t += dt;
    this.clock += dt;
    while (this.queue.length && this.queue[0].at <= this.clock) this.queue.shift()!.fn();
    [this.scale, this.opacity, this.curl, this.shake, this.light, this.tilt, this.nudge].forEach((s) => s.step(dt));
    const listening = this.state === 'listening' || this.state === 'activating';
    this.energy = follow(this.energy, listening ? this.raw : 0, dt, 0.05, 0.22);
    const e = this.energy;
    const s = Math.max(0, this.scale.value);
    const breathe = this.reduced ? 0 : Math.sin(this.t * 1.37) * 0.015;
    const sy = s * (1 + breathe + (this.reduced ? 0 : e * 0.35 * Math.sin(this.t * 9)));
    // Integrated, so the spin slows smoothly as the curl relaxes instead of jumping.
    this.angle = (this.angle + dt * this.curl.value * 220) % 360;
    const rot = this.reduced ? 0 : this.angle + clamp(this.tilt.value, -14, 14);
    const bob = this.reduced ? 0 : clamp(this.nudge.value, -12, 12);
    const squash = 1 - this.curl.value * 0.55;
    this.group.setAttribute('transform', `translate(${150 + this.shake.value * 18} ${this.cy + bob}) rotate(${rot}) scale(${s * squash} ${sy})`);
    this.root.style.opacity = String(clamp(this.opacity.value));
    this.glow.setAttribute('opacity', String(clamp((this.light.value - 0.4) * 0.5 + e * (this.reduced ? 0.6 : 0.3))));
  }

  dispose() { this.stop(); this.untouch?.(); this.root.remove(); this.canvas.style.display = ''; }
}
