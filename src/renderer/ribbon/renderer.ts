import { BLUR_FS, COMPOSITE_FS, QUAD_VS, RIBBON_FS, RIBBON_VS } from './shaders';
import { compile, createTarget, deleteTarget, lookAt, multiply, perspective, project, Target, Uniforms } from './gl';

/** Everything the choreography decides for one frame. */
export interface FrameParams {
  time: number;
  extent: number;
  width: number;
  curl: number;
  breath: number;
  ripple: number;
  bend: number;
  loud: number;
  phase: number;
  spin: number;
  settle: number;
  offset: [number, number, number];
  energy: Float32Array; // 32 samples
  opacity: number;
  glow: number;
  edge: number;
  flow: number;
  flowPos: number;
  sweep: number;
  core: number;
  shadow: number;
  brightness: number;
}

export interface RendererOptions {
  /** Supersampling factor for the glass layers (anti-aliasing). */
  supersample?: number;
  /** World units visible vertically (smaller = bigger ribbon). */
  viewHeight?: number;
  /** Where the ribbon's centre sits vertically, 0 = bottom, 1 = top. */
  anchorY?: number;
  accent?: [number, number, number];
  layers?: number;
  /** Ribbon width multiplier. */
  thickness?: number;
  /** Shadow strength multiplier. */
  shadow?: number;
}

const U_SEGMENTS = 180;
const V_SEGMENTS = 14;

export class RibbonRenderer {
  readonly gl: WebGL2RenderingContext;
  private ribbonProg!: WebGLProgram;
  private blurProg!: WebGLProgram;
  private compProg!: WebGLProgram;
  private ru!: Uniforms;
  private bu!: Uniforms;
  private cu!: Uniforms;
  private vao!: WebGLVertexArrayObject;
  private quadVao!: WebGLVertexArrayObject;
  private indexCount = 0;
  /** True while the GPU context is lost (driver reset, sleep/resume…). */
  lost = false;
  onLost?: () => void;
  onRestored?: () => void;
  private layers: Target[] = [];
  private shadowA: Target | null = null;
  private shadowB: Target | null = null;
  private glowA: Target | null = null;
  private glowB: Target | null = null;
  private width = 0;
  private height = 0;
  private opts: Required<RendererOptions>;
  dark = 0;

  constructor(private canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.opts = {
      supersample: options.supersample ?? 2,
      viewHeight: options.viewHeight ?? 2.3,
      anchorY: options.anchorY ?? 0.5,
      accent: options.accent ?? [0.49, 0.40, 1.0],
      layers: options.layers ?? 3,
      thickness: options.thickness ?? 1,
      shadow: options.shadow ?? 1,
    };
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    // Survive GPU resets: keep the canvas, rebuild every resource on restore.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.init();
        this.lost = false;
        this.onRestored?.();
      } catch {
        /* stays lost; the owner falls back */
      }
    });
    this.init();
  }

  private init() {
    const gl = this.gl;
    this.layers = [];
    this.shadowA = this.shadowB = this.glowA = this.glowB = null;
    this.width = this.height = 0;
    this.ribbonProg = compile(gl, RIBBON_VS, RIBBON_FS);
    this.blurProg = compile(gl, QUAD_VS, BLUR_FS);
    this.compProg = compile(gl, QUAD_VS, COMPOSITE_FS);
    this.ru = new Uniforms(gl, this.ribbonProg);
    this.bu = new Uniforms(gl, this.blurProg);
    this.cu = new Uniforms(gl, this.compProg);

    // Strip mesh: u along the length, v across the width.
    const verts = new Float32Array((U_SEGMENTS + 1) * (V_SEGMENTS + 1) * 2);
    let k = 0;
    for (let i = 0; i <= U_SEGMENTS; i++) {
      for (let j = 0; j <= V_SEGMENTS; j++) {
        verts[k++] = i / U_SEGMENTS;
        verts[k++] = (j / V_SEGMENTS) * 2 - 1;
      }
    }
    const idx = new Uint16Array(U_SEGMENTS * V_SEGMENTS * 6);
    k = 0;
    const row = V_SEGMENTS + 1;
    for (let i = 0; i < U_SEGMENTS; i++) {
      for (let j = 0; j < V_SEGMENTS; j++) {
        const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    this.indexCount = idx.length;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.quadVao = gl.createVertexArray()!;
    // Prove the whole pipeline works here and now, so a driver that can't do
    // it fails at construction (and gets the fallback) rather than mid-animation.
    for (const t of [createTarget(gl, 8, 8, true), createTarget(gl, 4, 4, false)]) deleteTarget(gl, t);
    if (gl.isContextLost()) throw new Error('WebGL context lost');
  }

  setOptions(o: RendererOptions) {
    Object.assign(this.opts, Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    this.width = 0; // force target rebuild
  }

  /** Resize drawing buffers to match the canvas's CSS size and the display density. */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;
    for (const t of this.layers) deleteTarget(gl, t);
    [this.shadowA, this.shadowB, this.glowA, this.glowB].forEach((t) => deleteTarget(gl, t));
    const ss = dpr >= 2 ? Math.min(this.opts.supersample, 1.5) : this.opts.supersample;
    const lw = Math.round(w * ss), lh = Math.round(h * ss);
    this.layers = [];
    for (let i = 0; i < this.opts.layers; i++) this.layers.push(createTarget(gl, lw, lh, true));
    const qw = Math.max(1, Math.round(w / 3)), qh = Math.max(1, Math.round(h / 3));
    this.shadowA = createTarget(gl, qw, qh, false);
    this.shadowB = createTarget(gl, qw, qh, false);
    this.glowA = createTarget(gl, qw, qh, true);
    this.glowB = createTarget(gl, qw, qh, false);
    return true;
  }

  private camera() {
    const aspect = this.width / this.height;
    const eye = [0, 0.95, 5.4];
    const center = [0, -0.02, 0];
    const fov = 2 * Math.atan(this.opts.viewHeight / 2 / 5.4);
    // Lens shift places the ribbon at anchorY without tilting perspective.
    const shift = -(this.opts.anchorY - 0.5) * 2;
    const proj = perspective(fov, aspect, 0.5, 30, shift);
    const view = lookAt(eye, center, [0, 1, 0]);
    return { viewProj: multiply(proj, view), eye };
  }

  /** Screen-space (CSS px) position of a world point; used to place DOM controls. */
  toScreen(p: number[]): [number, number] {
    const { viewProj } = this.camera();
    const [x, y] = project(viewProj, p);
    return [((x + 1) / 2) * this.canvas.clientWidth, ((1 - y) / 2) * this.canvas.clientHeight];
  }

  render(f: FrameParams) {
    if (this.lost || this.gl.isContextLost()) return;
    try {
      this.resize();
    } catch (e) {
      if (this.gl.isContextLost()) return; // a restore event will follow
      throw e;
    }
    const gl = this.gl;
    const { viewProj, eye } = this.camera();
    const ru = this.ru;

    gl.useProgram(this.ribbonProg);
    gl.bindVertexArray(this.vao);
    ru.m4('uViewProj', viewProj);
    ru.v3('uCam', eye);
    ru.f('uTime', f.time);
    ru.f('uExtent', f.extent);
    ru.f('uWidth', f.width);
    ru.f('uCurl', f.curl);
    ru.f('uBreath', f.breath);
    ru.f('uRipple', f.ripple);
    ru.f('uBend', f.bend);
    ru.f('uLoud', f.loud);
    ru.f('uThick', this.opts.thickness);
    ru.f('uPhase', f.phase);
    ru.f('uSpin', f.spin);
    ru.f('uSettle', f.settle);
    ru.v3('uOffset', f.offset);
    ru.fv('uEnergy[0]', f.energy);
    ru.f('uOpacity', f.opacity);
    ru.f('uGlow', f.glow);
    ru.f('uEdge', f.edge);
    ru.f('uFlow', f.flow);
    ru.f('uFlowPos', f.flowPos);
    ru.f('uSweep', f.sweep);
    ru.f('uDark', this.dark);
    ru.v3('uAccent', this.opts.accent);
    ru.f('uFloorY', -0.62);
    ru.i('uPrevDepth', 0);

    const visible = f.opacity > 0.001 && (f.extent > 0.002 || f.core > 0.001);
    const drawRibbon = f.opacity > 0.001 && f.extent > 0.002 && f.width > 0.002;

    // 1 · Shadow silhouette (low resolution, then blurred).
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.bind(this.shadowA!);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (drawRibbon && f.shadow > 0.001) {
      gl.blendFunc(gl.ONE, gl.ONE); // overlapping folds shouldn't darken twice
      gl.blendEquation(gl.MAX);
      ru.f('uFlatten', 1);
      ru.f('uMode', 2);
      ru.f('uLayer', 0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.blendEquation(gl.FUNC_ADD);
    }
    ru.f('uFlatten', 0);

    // 2 · Emission (low resolution, nearest surface) → bloom-lite.
    this.bind(this.glowA!);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (drawRibbon) {
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      ru.f('uMode', 1);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.DEPTH_TEST);
    }

    // 3 · Depth-peeled glass layers: exact ordering for a surface that folds over itself.
    gl.disable(gl.BLEND);
    ru.f('uMode', 0);
    for (let i = 0; i < this.layers.length; i++) {
      const t = this.layers[i];
      this.bind(t);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!drawRibbon) continue;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      ru.f('uLayer', i);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, i > 0 ? this.layers[i - 1].depth : null);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // 4 · Blur shadow and glow.
    gl.bindVertexArray(this.quadVao);
    gl.useProgram(this.blurProg);
    this.bu.i('uTex', 0);
    gl.disable(gl.BLEND);
    const blur = (a: Target, b: Target, radius: number) => {
      for (let pass = 0; pass < 2; pass++) {
        this.bind(b);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, a.color);
        this.bu.v2('uDir', radius / a.w, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.bind(a);
        gl.bindTexture(gl.TEXTURE_2D, b.color);
        this.bu.v2('uDir', 0, radius / a.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    };
    if (drawRibbon) {
      blur(this.shadowA!, this.shadowB!, 1.0);
      blur(this.glowA!, this.glowB!, 0.8);
    }

    // 5 · Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!visible) return;
    gl.useProgram(this.compProg);
    const cu = this.cu;
    const tex = [this.layers[0], this.layers[1] ?? this.layers[0], this.layers[2] ?? this.layers[0]];
    tex.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t.color);
    });
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowA!.color);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.glowA!.color);
    cu.i('uL0', 0);
    cu.i('uL1', 1);
    cu.i('uL2', 2);
    cu.i('uShadow', 3);
    cu.i('uGlowTex', 4);
    cu.f('uLayers', this.layers.length);
    cu.f('uShadowAlpha', f.shadow * this.opts.shadow * (this.dark ? 0.55 : 0.32));
    cu.f('uGlowAmt', this.dark ? 0.85 : 0.5);
    cu.f('uHalo', (this.dark ? 0.22 : 0.09) * f.opacity);
    cu.f('uBrightness', f.brightness);
    const [cx, cy] = project(viewProj, [f.offset[0], f.offset[1] + 0.03, f.offset[2] + 0.14]);
    cu.v2('uCore', (cx + 1) / 2, (cy + 1) / 2);
    cu.f('uCoreAmt', f.core);
    cu.f('uCoreSize', 0.035 * (2.3 / this.opts.viewHeight));
    cu.f('uAspect', this.width / this.height);
    cu.v3('uAccent', this.opts.accent);
    drawArraysPremultiplied(gl);
    gl.activeTexture(gl.TEXTURE0);
  }

  private bind(t: Target) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fb);
    this.gl.viewport(0, 0, t.w, t.h);
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.layers) deleteTarget(gl, t);
    [this.shadowA, this.shadowB, this.glowA, this.glowB].forEach((t) => deleteTarget(gl, t));
    gl.deleteProgram(this.ribbonProg);
    gl.deleteProgram(this.blurProg);
    gl.deleteProgram(this.compProg);
  }
}

function drawArraysPremultiplied(gl: WebGL2RenderingContext) {
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
