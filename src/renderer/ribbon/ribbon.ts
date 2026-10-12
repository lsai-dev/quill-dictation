import { FrameParams, RendererOptions, RibbonRenderer } from './renderer';
import { clamp, follow, smoothstep, Spring } from './spring';

export type RibbonState = 'hidden' | 'activating' | 'listening' | 'processing' | 'refining' | 'inserted' | 'cancelled' | 'error';

export interface RibbonOptions extends RendererOptions {
  reducedMotion?: boolean;
  /** Keep a resting ribbon on screen (used in the app window) instead of folding away. */
  persistent?: boolean;
}

const HISTORY = 32;
const HISTORY_DT = 1 / 30;

/**
 * The living object. One continuous ribbon whose every state is a set of
 * spring targets — so transitions are never cuts, only the same thing
 * changing shape.
 */
export class Ribbon {
  readonly renderer: RibbonRenderer;
  state: RibbonState = 'hidden';
  onHidden?: () => void;
  onStateChange?: (s: RibbonState) => void;

  private reduced: boolean;
  private persistent: boolean;
  private raf = 0;
  private last = 0;
  private time = Math.random() * 100;
  private clock = 0;
  private queue: { at: number; fn: () => void }[] = [];
  /** When true, frames are only produced by advance() (deterministic captures). */
  manual = false;

  // Shape
  private extent = new Spring(0, 0.55, 0.62);
  private width = new Spring(0, 0.5, 0.75);
  private curl = new Spring(0, 0.8, 0.82);
  private breath = new Spring(0, 1.2, 1);
  private settle = new Spring(0, 0.42, 0.42);
  private shakeX = new Spring(0, 0.16, 0.18);
  private spinRate = new Spring(0, 1.0, 1);
  // Light
  private opacity = new Spring(0, 0.25, 1);
  private glow = new Spring(0.0, 0.6, 1);
  private edge = new Spring(0.0, 0.5, 1);
  private flow = new Spring(0, 0.6, 1);
  private core = new Spring(0, 0.18, 1);
  private brightness = new Spring(1, 0.4, 1);
  // Voice
  private voiceGate = new Spring(0, 0.35, 1);
  private ripple = new Spring(0, 0.28, 0.9);
  private bend = new Spring(0, 0.45, 0.85);
  private loud = new Spring(0, 1.1, 1);

  private rawEnergy = 0;
  private energy = 0;
  private energyHistory = new Float32Array(HISTORY);
  private historyAcc = 0;
  private phase = 0;
  private spin = 0;
  private flowPos = 0;
  private sweep = -1;
  private sweepActive = false;
  private noiseFloor = -60;
  private sinceRender = Infinity;

  constructor(canvas: HTMLCanvasElement, opts: RibbonOptions = {}) {
    this.renderer = new RibbonRenderer(canvas, opts);
    this.reduced = !!opts.reducedMotion;
    this.persistent = !!opts.persistent;
  }

  setDark(dark: boolean) {
    this.renderer.dark = dark ? 1 : 0;
  }

  setReducedMotion(on: boolean) {
    this.reduced = on;
    if (on) {
      // Same silhouette, no movement: states are carried by light alone.
      this.curl.to(0);
      if (this.state !== 'hidden' && this.state !== 'cancelled') {
        this.extent.snap(1);
        this.width.snap(1);
      }
    }
  }

  get reducedMotion() {
    return this.reduced;
  }

  /**
   * Feed a microphone level in dBFS (about -100 … 0). The ribbon adapts to the
   * room's noise floor so quiet voices still produce delicate ripples.
   */
  setLevel(db: number) {
    if (!Number.isFinite(db)) db = -100;
    // Noise floor: follows quickly downward, creeps slowly upward.
    if (db < this.noiseFloor) this.noiseFloor += (db - this.noiseFloor) * 0.25;
    else this.noiseFloor += Math.min(0.05, (db - this.noiseFloor) * 0.002);
    this.noiseFloor = clamp(this.noiseFloor, -90, -25);
    const rel = (db - this.noiseFloor - 4) / 34;
    this.rawEnergy = Math.pow(clamp(rel), 0.85);
  }

  /** Directly set normalized energy 0…1 (used by demos). */
  setEnergy(e: number) {
    this.rawEnergy = clamp(e);
  }

  // ── States ─────────────────────────────────────────────────────────────────

  show() {
    this.clearTimers();
    const fromHidden = this.state === 'hidden' || this.extent.value < 0.05;
    this.setState('activating');
    this.start();
    if (fromHidden) {
      this.extent.snap(0);
      this.width.snap(0);
      this.curl.snap(0);
      this.opacity.snap(0);
      this.core.snap(0);
    }
    this.opacity.to(1, 0.2, 1);
    this.sweep = -1;
    this.sweepActive = false;
    this.flow.to(0);

    if (this.reduced) {
      this.extent.snap(1);
      this.width.snap(1);
      this.opacity.to(1, 0.35, 1);
      this.core.to(0);
      this.glow.to(0.55, 0.5, 1);
      this.edge.to(0.6, 0.5, 1);
      this.later(260, () => this.setState('listening'));
      this.voiceGate.to(1);
      return;
    }

    // A point of light appears…
    this.core.to(1, 0.14, 1);
    this.glow.to(0.5, 0.6, 1);
    this.edge.to(0.55, 0.6, 1);
    // …and unfolds into the ribbon with a soft spring.
    this.later(70, () => {
      this.extent.to(1, 0.62, 0.66);
      this.core.to(0, 0.45, 1);
    });
    this.later(130, () => this.width.to(1, 0.55, 0.72));
    this.later(180, () => this.breath.to(1, 1.4, 1));
    this.later(480, () => {
      if (this.state === 'activating') this.setState('listening');
    });
    this.voiceGate.to(1, 0.6, 1);
  }

  /** Recording stopped; transcription running. */
  process() {
    this.clearTimers();
    this.setState('processing');
    this.start();
    this.core.to(0, 0.35, 1);
    if (!this.reduced) {
      // If we were interrupted mid-unfold, finish unfolding as we curl.
      this.breath.to(0.35, 1, 1);
    }
    this.voiceGate.to(0, 0.3, 1);
    if (this.reduced) {
      // No travelling light: a slow, stationary brightening says "working".
      this.flow.to(0, 0.3, 1);
      this.glow.to(0.9, 0.6, 1);
      return;
    }
    this.flow.to(1, 0.6, 1);
    this.extent.to(0.94, 0.7, 0.85);
    this.width.to(0.92, 0.7, 0.85);
    this.curl.to(1, 0.85, 0.8);
    this.breath.to(0.35, 1, 1);
    this.spinRate.to(0.55, 1.2, 1);
    this.glow.to(0.75, 0.6, 1);
    this.edge.to(0.8, 0.6, 1);
  }

  /**
   * The transcript is ready and Cleanup is polishing it. The same loop keeps turning,
   * but loosens toward the ribbon's resting form and its light softens and brightens —
   * the text is nearly done — so the settle that follows is a short last step.
   */
  refine() {
    this.clearTimers();
    this.setState('refining');
    this.start();
    this.core.to(0, 0.35, 1);
    this.voiceGate.to(0, 0.3, 1);
    if (this.reduced) {
      // Light alone: a warmer, steadier glow than transcribing.
      this.flow.to(0, 0.3, 1);
      this.glow.to(1.0, 0.8, 1);
      this.edge.to(0.95, 0.8, 1);
      return;
    }
    this.flow.to(0.75, 0.9, 1);
    this.curl.to(0.45, 1.15, 0.92);
    this.extent.to(0.98, 1.0, 0.9);
    this.width.to(0.97, 1.0, 0.9);
    this.breath.to(0.6, 1.2, 1);
    this.spinRate.to(0.32, 1.4, 1);
    this.glow.to(0.85, 0.9, 1);
    this.edge.to(0.92, 0.9, 1);
    this.brightness.to(1.05, 0.9, 1);
  }

  /** Text was inserted: one satisfying settle, then fold away. */
  success() {
    this.clearTimers();
    this.setState('inserted');
    this.start();
    this.core.to(0, 0.3, 1);
    this.voiceGate.to(0, 0.2, 1);
    this.flow.to(0, 0.35, 1);
    if (this.reduced) {
      this.brightness.to(1.25, 0.18, 1);
      this.later(180, () => this.brightness.to(1, 0.4, 1));
      this.later(520, () => this.foldAway(0.4));
      return;
    }
    this.brightness.to(1, 0.5, 1);
    this.curl.to(0, 0.48, 0.86);
    this.extent.to(1, 0.48, 0.8);
    this.width.to(1, 0.48, 0.8);
    this.spinRate.to(0, 0.5, 1);
    this.breath.to(0, 0.6, 1);
    // The settle: a gentle press and recovery, like setting something down.
    this.later(90, () => {
      this.settle.impulse(5.2);
      this.sweepActive = true;
      this.sweep = -0.15;
    });
    this.later(560, () => this.foldAway(0.42));
  }

  cancel() {
    this.clearTimers();
    this.setState('cancelled');
    this.start();
    this.voiceGate.to(0, 0.15, 1);
    this.flow.to(0, 0.3, 1);
    this.sweepActive = false;
    this.sweep = -1;
    if (this.reduced) {
      this.foldAway(0.3);
      return;
    }
    this.curl.to(0, 0.4, 1);
    this.foldAway(0.32);
  }

  /** Something went wrong: a small, unmistakable head-shake, then fold away. */
  error(holdMs = 1600) {
    this.clearTimers();
    this.setState('error');
    this.start();
    this.core.to(0, 0.35, 1);
    this.opacity.to(1, 0.2, 1);
    this.voiceGate.to(0, 0.2, 1);
    this.flow.to(0, 0.3, 1);
    this.curl.to(0, 0.5, 0.9);
    this.extent.to(1, 0.5, 0.9);
    this.width.to(1, 0.5, 0.9);
    if (this.reduced) {
      this.brightness.to(0.82, 0.3, 1);
    } else {
      this.shakeX.impulse(-3.4);
    }
    this.later(holdMs, () => this.foldAway(0.36));
  }

  /** A resting, breathing ribbon (app window hero). */
  rest() {
    this.clearTimers();
    this.setState('listening');
    this.start();
    this.opacity.to(1, 0.4, 1);
    this.extent.to(1, 0.8, 0.8);
    this.width.to(1, 0.8, 0.8);
    this.curl.to(0, 0.8, 1);
    this.breath.to(1, 1.4, 1);
    this.glow.to(0.5, 0.6, 1);
    this.edge.to(0.55, 0.6, 1);
    this.voiceGate.to(1, 0.6, 1);
  }

  private foldAway(response: number) {
    this.breath.to(0, 0.4, 1);
    this.voiceGate.to(0, 0.2, 1);
    if (this.reduced) {
      this.opacity.to(0, response, 1);
      this.later(response * 1000 + 250, () => this.finishHide());
      return;
    }
    this.width.to(0, response * 0.85, 1);
    this.extent.to(0, response, 1);
    // A last glint as it folds into a point, then gone.
    this.later(response * 520, () => this.core.to(0.55, 0.12, 1));
    this.later(response * 820, () => {
      this.core.to(0, 0.22, 1);
      this.opacity.to(0, 0.22, 1);
    });
    this.later(response * 820 + 320, () => this.finishHide());
  }

  private finishHide() {
    if (this.persistent) {
      this.rest();
      return;
    }
    this.setState('hidden');
    this.onHidden?.();
  }

  private setState(s: RibbonState) {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  // Choreography runs on the ribbon's own clock, so it is frame-accurate and
  // pauses with rendering instead of drifting against wall time.
  private later(ms: number, fn: () => void) {
    this.queue.push({ at: this.clock + ms / 1000, fn });
    this.queue.sort((a, b) => a.at - b.at);
  }

  private clearTimers() {
    this.queue = [];
  }

  /** Step the simulation by `ms` at a fixed rate and render the result. */
  advance(ms: number, fps = 120) {
    const dt = 1 / fps;
    for (let t = 0; t < ms / 1000 - 1e-9; t += dt) this.frame(dt, t + dt < ms / 1000 - 1e-9);
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  start() {
    if (this.raf || this.manual) return;
    this.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      if (this.state === 'hidden' && this.opacity.value < 0.001 && !this.persistent) {
        this.raf = 0;
        this.frame(0); // clear
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Pause rendering. Choreography runs on the ribbon's own clock, so it resumes exactly where it left off. */
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Advance and render one frame. Exposed for deterministic captures. */
  frame(dt: number, skipRender = false) {
    this.time += dt;
    this.clock += dt;
    while (this.queue.length && this.queue[0].at <= this.clock) this.queue.shift()!.fn();
    const springs = [
      this.extent, this.width, this.curl, this.breath, this.settle, this.shakeX, this.spinRate,
      this.opacity, this.glow, this.edge, this.flow, this.core, this.brightness, this.voiceGate,
    ];
    for (const s of springs) s.step(dt);

    // Voice energy: fast attack, slower release, gated by state — then weighted
    // by springs so movement feels fluid rather than jittery.
    const gate = clamp(this.voiceGate.value);
    this.energy = follow(this.energy, this.rawEnergy * gate, dt, 0.045, 0.2);
    this.historyAcc += dt;
    while (this.historyAcc >= HISTORY_DT) {
      this.historyAcc -= HISTORY_DT;
      this.energyHistory.copyWithin(1, 0, HISTORY - 1);
      this.energyHistory[0] = this.energy;
    }
    // Blend the newest sample continuously so the source never steps.
    this.energyHistory[0] = this.energy;

    const e = this.energy;
    // Quiet speech → delicate ripples. Loud speech → broad bends.
    this.ripple.to(this.reduced ? 0 : 0.55 + 0.45 * smoothstep(0.0, 0.35, e));
    this.bend.to(this.reduced ? 0 : smoothstep(0.3, 0.95, e) * 1.15);
    this.loud.to(smoothstep(0.2, 0.8, e));
    this.ripple.step(dt);
    this.bend.step(dt);
    this.loud.step(dt);

    // Waves travel faster when you speak up; phase is integrated, never jumps.
    this.phase += dt * (2.4 + 7.5 * e);
    this.spin += dt * this.spinRate.value * 2.2;

    // The glint circles while transcribing, and slows while polishing.
    if (this.flow.value > 0.001 || this.state === 'processing' || this.state === 'refining') {
      this.flowPos = (this.flowPos + dt * (this.state === 'refining' ? 0.4 : 0.62)) % 1;
    }
    if (this.sweepActive) {
      this.sweep += dt * 2.3;
      if (this.sweep > 1.2) {
        this.sweepActive = false;
        this.sweep = -1;
      }
    }

    // Reduced motion: speech is shown as a gentle brightening of the inner light.
    let glow = this.glow.value;
    let edge = this.edge.value;
    if (this.reduced) {
      glow += e * 0.6;
      edge += e * 0.5;
      if (this.state === 'processing') glow += 0.18 * (0.5 + 0.5 * Math.sin(this.time * 2.4));
    } else {
      glow += e * 0.35;
    }

    const params: FrameParams = {
      time: this.time,
      extent: Math.max(0, this.extent.value),
      width: Math.max(0, this.width.value),
      curl: clamp(this.curl.value, 0, 1.05),
      breath: this.reduced ? 0 : this.breath.value,
      ripple: this.ripple.value * clamp(this.voiceGate.value * 1.2),
      bend: this.bend.value,
      loud: this.loud.value,
      phase: this.phase,
      spin: this.spin,
      settle: this.settle.value,
      offset: [this.shakeX.value * 0.12, 0, 0],
      energy: this.energyHistory,
      opacity: clamp(this.opacity.value),
      glow,
      edge,
      flow: clamp(this.flow.value),
      flowPos: this.flowPos,
      sweep: this.sweep,
      core: clamp(this.core.value) * clamp(this.opacity.value * 1.5),
      shadow: clamp(this.opacity.value) * smoothstep(0.1, 0.8, this.extent.value),
      brightness: this.brightness.value,
    };
    // On software WebGL, draw fewer frames (motion stays correct; only the
    // frame rate drops) so the processor is free for transcription.
    this.sinceRender += dt;
    const minInterval = this.renderer.software ? (this.persistent ? 1 / 15 : 1 / 30) : 0;
    if (!skipRender && (this.sinceRender >= minInterval || dt === 0 || this.manual)) {
      this.sinceRender = 0;
      this.renderer.render(params);
    }
  }

  dispose() {
    this.stop();
    this.clearTimers();
    this.renderer.dispose();
  }
}
