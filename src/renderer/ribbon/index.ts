import { FallbackRibbon } from './fallback';
import { Ribbon, RibbonOptions, RibbonState } from './ribbon';

export type { RibbonState } from './ribbon';
type Impl = Ribbon | FallbackRibbon;

/**
 * The ribbon as the rest of the app sees it. Uses the WebGL ribbon when the GPU
 * allows; if WebGL is unavailable — or the GPU context is lost and doesn't come
 * back — it swaps to the SVG ribbon mid-flight, replaying the current state, so
 * the indicator never disappears.
 */
export class AnyRibbon {
  private impl: Impl;
  private dark = false;
  private reduced = false;
  private lostTimer = 0;
  onHidden?: () => void;
  onStateChange?: (s: RibbonState) => void;

  constructor(private canvas: HTMLCanvasElement, private opts: RibbonOptions = {}) {
    this.impl = this.make();
  }

  private make(): Impl {
    let impl: Impl;
    try {
      const r = new Ribbon(this.canvas, this.opts);
      r.renderer.onLost = () => {
        clearTimeout(this.lostTimer);
        this.lostTimer = window.setTimeout(() => this.swapToFallback(), 1500);
      };
      r.renderer.onRestored = () => clearTimeout(this.lostTimer);
      impl = r;
    } catch (e) {
      console.warn('Ribbon: WebGL2 unavailable, using fallback', e);
      impl = new FallbackRibbon(this.canvas, this.opts);
    }
    this.wire(impl);
    return impl;
  }

  private wire(impl: Impl) {
    impl.onHidden = () => this.onHidden?.();
    impl.onStateChange = (s) => this.onStateChange?.(s);
  }

  private swapToFallback() {
    if (this.impl instanceof FallbackRibbon) return;
    const state = this.impl.state;
    this.impl.stop();
    // A fresh canvas: the old one's context is gone for good.
    const fresh = this.canvas.cloneNode() as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    const fb = new FallbackRibbon(fresh, this.opts);
    this.wire(fb);
    fb.setDark(this.dark);
    fb.setReducedMotion(this.reduced);
    this.impl = fb;
    if (state === 'activating' || state === 'listening') fb.show();
    else if (state === 'processing') { fb.show(); fb.process(); }
    else if (state === 'refining') { fb.show(); fb.refine(); }
    else if (state === 'error') { fb.show(); fb.error(); }
    else if (this.opts.persistent) fb.rest();
  }

  get state() { return this.impl.state; }
  get renderer() { return this.impl.renderer; }
  get reducedMotion() { return this.impl.reducedMotion; }
  get usingFallback() { return this.impl instanceof FallbackRibbon; }
  /** True when drawing costs CPU time (software WebGL or the SVG fallback). */
  get software() { return this.impl instanceof FallbackRibbon || this.impl.renderer.software; }
  set manual(v: boolean) { this.impl.manual = v; }

  setDark(d: boolean) { this.dark = d; this.impl.setDark(d); }
  setReducedMotion(r: boolean) { this.reduced = r; this.impl.setReducedMotion(r); }
  setLevel(db: number) { this.impl.setLevel(db); }
  setEnergy(e: number) { this.impl.setEnergy(e); }
  show() { this.impl.show(); }
  rest() { this.impl.rest(); }
  process() { this.impl.process(); }
  refine() { this.impl.refine(); }
  success() { this.impl.success(); }
  cancel() { this.impl.cancel(); }
  error(holdMs?: number) { this.impl.error(holdMs); }
  start() { this.impl.start(); }
  stop() { this.impl.stop(); }
  frame(dt: number) { this.impl.frame(dt); }
  advance(ms: number) { this.impl.advance(ms); }
  dispose() { clearTimeout(this.lostTimer); this.impl.dispose(); }
}

export function createRibbon(canvas: HTMLCanvasElement, opts: RibbonOptions = {}): AnyRibbon {
  return new AnyRibbon(canvas, opts);
}
