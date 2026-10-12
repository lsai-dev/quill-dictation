/**
 * GLSL for the Quill ribbon.
 *
 * The ribbon is a real surface: a strip parameterised by (u, v) whose
 * centreline, twist and width are evaluated in the vertex shader. Normals are
 * derived from the deformed surface itself, so every ripple catches the light.
 *
 * Material: pearlescent glass. The outer face is a milky pearl with thin-film
 * iridescence; the inner face carries a soft violet light. That light leaks
 * out wherever the glass bends or twists — so the accent colour appears in the
 * folds, and voice-driven bends make it shimmer with your words.
 */

const SURFACE = /* glsl */ `
uniform float uTime;
uniform float uExtent;    // 0 = a point, 1 = fully unfurled
uniform float uWidth;     // width scale
uniform float uCurl;      // 0 = resting fold, 1 = loose loop
uniform float uBreath;    // breathing amplitude
uniform float uRipple;    // fine voice ripples
uniform float uBend;      // broad voice bends
uniform float uPhase;     // integrated travelling-wave phase
uniform float uSpin;      // slow drift of the loop
uniform float uSettle;    // settle deformation (signed)
uniform vec3  uOffset;    // whole-object offset (shake)
uniform float uLoud;      // slow-smoothed loudness: shifts ripples toward longer waves
uniform float uThick;     // width multiplier (1 = normal; the app icon uses more)
uniform float uEnergy[32];// voice energy history, [0] = now, ~33 ms apart

const float PI = 3.14159265;
const float TAU = 6.28318531;
const float LEN = 2.55;    // resting length in world units
const float HALF_W = 0.175;

float ease(float x) { return x * x * (3.0 - 2.0 * x); }

// Voice energy that arrived at the centre 'lag' seconds ago.
float history(float lag) {
  float f = clamp(lag * 30.0, 0.0, 30.99);
  int i = int(f);
  return mix(uEnergy[i], uEnergy[i + 1], fract(f));
}

// Resting silhouette: a gentle S that rises toward the camera in the middle.
vec3 restCurve(float s) {
  // The right half crosses in front of the left: the half-twist happens while
  // the ribbon travels toward the viewer, so it reads as a fold, not a pinch.
  float x = s * LEN;
  float y = 0.14 * sin(TAU * s * 0.85 + 0.25);
  float z = 0.30 * tanh(5.5 * s) + 0.35 * (0.25 - s * s);
  return vec3(x, y, z);
}

// A loose loop, slightly more than one turn, its axis tipped toward the
// viewer so the violet inside of the band is visible.
vec3 loopAxis() {
  return normalize(vec3(0.16, 0.86, 0.48));
}
vec3 loopCurve(float s) {
  float turns = 1.12;
  float a = s * TAU * turns + uSpin + PI;
  float r = 0.43 * (1.0 + 0.05 * sin(a * 2.0 + uTime * 0.7));
  vec3 ax = loopAxis();
  vec3 e1 = normalize(cross(ax, vec3(0.0, 0.0, 1.0)));
  vec3 e2 = cross(ax, e1);
  return (e1 * sin(a) + e2 * cos(a)) * r + ax * (s * 0.36) + vec3(0.0, 0.02, 0.0);
}

// Signed distance (0 at centre, 1 at tips) used for the travelling waves.
float travel(float s) { return abs(s) * 2.0; }

vec3 centreline(float s) {
  float c = ease(clamp(uCurl, 0.0, 1.0));
  vec3 p = mix(restCurve(s), loopCurve(s), c);

  // Voice: broad bends travel outward from the centre. Louder = broader.
  float d = travel(s);
  float e = history(d * 0.55);
  float bend = uBend * e * sin(TAU * (0.85 * d) - uPhase * 0.55) * (0.3 + 0.7 * d);
  p.y += bend * 0.24;
  p.z += bend * 0.10;

  // Breathing: an almost imperceptible swell.
  float br = sin(uTime * TAU / 4.6);
  p.y += uBreath * 0.012 * br * (1.0 - d * 0.5);

  // Settle: the whole ribbon sinks and recovers like something set down.
  p.y -= uSettle * 0.10 * (1.0 - 0.6 * d * d);
  return p;
}

float twistAt(float s) {
  // A soft half-twist through the middle reveals the violet inner face.
  float rest = -0.30 + PI * 0.92 * ease(clamp(s * 2.0 + 0.5, 0.0, 1.0));
  float d = travel(s);
  float flutter = uRipple * history(d * 0.45) * 0.22 * sin(TAU * 1.8 * d - uPhase);
  float breath = uBreath * 0.05 * sin(uTime * TAU / 4.6 + s * 2.0);
  return mix(rest, 0.12, ease(clamp(uCurl, 0.0, 1.0))) + flutter + breath;
}

float halfWidth(float s) {
  // A calligraphic taper — the stroke of a quill, drawn in glass.
  float t = clamp(abs(s) * 2.0, 0.0, 1.0);
  float taper = pow(max(0.0, 1.0 - pow(t, 2.6)), 0.62);
  float belly = 0.80 + 0.20 * cos(PI * s * 1.1);
  float br = 1.0 + uBreath * 0.02 * sin(uTime * TAU / 4.6 + 1.2);
  return HALF_W * uThick * taper * belly * br * uWidth;
}

// Full surface evaluation. Returns position; outputs frame for shading.
vec3 surface(float u, float v, out vec3 T, out vec3 W) {
  float s = (u - 0.5) * max(uExtent, 1e-4);
  float h = 0.004;
  vec3 c0 = centreline(s - h);
  vec3 c = centreline(s);
  vec3 c1 = centreline(s + h);
  T = normalize(c1 - c0 + vec3(1e-6, 0.0, 0.0));

  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.18), loopAxis(), ease(clamp(uCurl, 0.0, 1.0))));
  W = normalize(up - dot(up, T) * T);
  float th = twistAt(s);
  vec3 B = cross(T, W);
  W = W * cos(th) + B * sin(th);
  vec3 N = cross(T, W);

  float d = travel(s);
  // Voice: fine ripples ride across the surface, strongest toward the free tips.
  float k = mix(3.6, 2.2, uLoud);
  float rip = uRipple * history(d * 0.4) *
              sin(TAU * (k * d) - uPhase * 1.35 + v * 0.9) * (0.25 + 0.75 * d);
  float hw = halfWidth(s);
  return c + W * (v * hw) + N * (rip * 0.07 * (0.6 + 0.4 * v * v)) + uOffset;
}
`;

export const RIBBON_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aUV;
uniform mat4 uViewProj;
uniform float uFlatten;   // 1 = project onto the floor (shadow pass)
uniform float uFloorY;
${SURFACE}
out vec3 vPos;
out vec3 vNormal;
out vec2 vUV;
out float vFold;

void main() {
  vec3 T, W;
  vec3 p = surface(aUV.x, aUV.y, T, W);

  // Normal from the deformed surface (finite differences on u and v).
  vec3 Ta, Wa;
  float du = 0.0035, dv = 0.04;
  vec3 pu = surface(aUV.x + du, aUV.y, Ta, Wa);
  vec3 pv = surface(aUV.x, aUV.y + dv, Ta, Wa);
  vec3 n = normalize(cross(pu - p, pv - p) + vec3(0.0, 0.0, 1e-6));

  // How strongly the glass bends or twists here — where the inner light leaks.
  float s = (aUV.x - 0.5) * max(uExtent, 1e-4);
  float h = 0.03;
  vec3 a = centreline(s - h), b = centreline(s), c = centreline(s + h);
  float curv = length(a - 2.0 * b + c) / (h * h);
  float twist = abs(twistAt(s + h) - twistAt(s - h)) / (2.0 * h);
  vFold = clamp(curv * 0.10 + twist * 0.16, 0.0, 1.5);

  if (uFlatten > 0.5) {
    // Shadow: drop the shape straight down onto the floor.
    p = vec3(p.x * 1.02, uFloorY, p.z * 0.9 + 0.08);
  }
  vPos = p;
  vNormal = n;
  vUV = aUV;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const RIBBON_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
in float vFold;

uniform vec3 uCam;
uniform float uTime;
uniform float uLayer;        // depth-peel index (0 = nearest)
uniform sampler2D uPrevDepth;
uniform float uMode;         // 0 = colour, 1 = emission only, 2 = shadow silhouette
uniform float uOpacity;
uniform float uGlow;         // inner light intensity
uniform float uEdge;         // luminous edge intensity
uniform float uFlow;         // light travelling around the fold (processing)
uniform float uFlowPos;
uniform float uSweep;        // one-shot confirmation sweep position (-1 = off)
uniform float uDark;         // 1 when the system is in dark mode
uniform vec3 uAccent;

layout(location = 0) out vec4 outColor;

const float PI = 3.14159265;

// A quiet photographic studio: bright overhead softbox, a cool fill,
// and a dark horizon flag that gives glass its defining edges.
vec3 env(vec3 d) {
  float y = d.y;
  vec3 sky = mix(vec3(0.80, 0.81, 0.86), vec3(1.0), smoothstep(-0.15, 0.9, y));
  float flag = exp(-pow(y * 4.2 + 0.55, 2.0)) * 0.55;
  vec3 col = sky * (1.0 - flag);
  float key = pow(max(dot(d, normalize(vec3(-0.45, 0.82, 0.55))), 0.0), 28.0) * 1.6;
  float fill = pow(max(dot(d, normalize(vec3(0.85, 0.25, 0.35))), 0.0), 10.0) * 0.55;
  float under = smoothstep(0.0, -0.8, y) * 0.18;
  col += vec3(1.0) * key + vec3(0.95, 0.96, 1.0) * fill;
  col -= under;
  return col;
}

// Thin-film interference: the pastel sheen of pearl and soap film.
vec3 thinFilm(float cosI, float thickness) {
  float n = 1.36;
  float cosT = sqrt(max(0.0, 1.0 - (1.0 - cosI * cosI) / (n * n)));
  vec3 lambda = vec3(640.0, 535.0, 460.0);
  vec3 phase = 2.0 * PI * 2.0 * n * thickness * cosT / lambda;
  return 0.5 + 0.5 * cos(phase);
}

float head(float b) { return clamp(b - 0.38, 0.0, 1.0); }

float ggx(float NdH, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main() {
  if (uLayer > 0.5) {
    float prev = texelFetch(uPrevDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (gl_FragCoord.z <= prev + 2.0e-6) discard;
  }

  float u = vUV.x;
  float v = vUV.y;
  float av = abs(v);
  // Analytic anti-aliasing of the long edges.
  float fw = max(fwidth(v), 1e-4);
  float edgeAA = 1.0 - smoothstep(1.0 - 1.6 * fw, 1.0, av);

  if (uMode > 1.5) {
    outColor = vec4(0.0, 0.0, 0.0, edgeAA * uOpacity);
    return;
  }

  vec3 N = normalize(vNormal);
  bool front = gl_FrontFacing;
  if (!front) N = -N;
  vec3 V = normalize(uCam - vPos);
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float grazing = 1.0 - NdV;
  float F = 0.04 + 0.96 * pow(grazing, 5.0);

  // Light carried inside the glass.
  float fold = clamp(vFold, 0.0, 1.0);
  float edge = smoothstep(0.70, 1.0, av);
  float innerEdge = edge * (v > 0.0 ? 1.0 : 0.5);
  float flowBand = 0.0;
  if (uFlow > 0.001) {
    // A glint circling the loop with a soft comet tail behind it.
    float x = fract(u - uFlowPos + 0.5) - 0.5;
    float head = exp(-x * x / 0.0022);
    float tail = x < 0.0 ? exp(x * 9.0) * 0.38 : 0.0;
    flowBand = head + tail;
  }
  float sweep = 0.0;
  if (uSweep > -0.5) {
    float x = u - uSweep;
    sweep = exp(-x * x / 0.0035) * smoothstep(0.0, 0.15, uSweep) * (1.0 - smoothstep(0.85, 1.1, uSweep));
  }
  vec3 accent = uAccent;
  vec3 hot = mix(vec3(1.0), accent, 0.35);
  vec3 emission =
      accent * uGlow * (0.10 + 0.55 * fold) * (0.45 + 0.55 * grazing) +
      hot * uEdge * innerEdge * (0.30 + 0.45 * fold) +
      mix(accent, vec3(1.0), 0.35 + 0.4 * head(flowBand)) * uFlow * flowBand * 0.62 +
      hot * sweep * 0.55;
  if (!front) emission += accent * uGlow * (0.05 + 0.12 * grazing + 0.3 * fold);

  if (uMode > 0.5) {
    // Alpha carries coverage: blurred, it becomes a soft halo that lets pale
    // glass separate from pale windows.
    outColor = vec4(emission * edgeAA * uOpacity, edgeAA * uOpacity);
    return;
  }

  // Surface reflection with a restrained pearl sheen: neutral face-on,
  // a whisper of interference colour only toward grazing angles.
  vec3 R = reflect(-V, N);
  float thickness = 430.0 + 110.0 * sin(u * 3.1 + v * 0.7 + uTime * 0.12) + 40.0 * sin(u * 7.3 - uTime * 0.2);
  vec3 film = thinFilm(NdV, thickness);
  float filmLum = max(1e-3, dot(film, vec3(0.299, 0.587, 0.114)));
  vec3 filmTint = clamp(film / filmLum, 0.0, 1.6);
  float sheenAmt = 0.06 + 0.22 * grazing * grazing;
  vec3 sheen = mix(vec3(1.0), filmTint, sheenAmt);
  vec3 refl = env(R) * sheen;

  vec3 L = normalize(vec3(-0.45, 0.82, 0.55));
  vec3 H = normalize(L + V);
  float spec = ggx(max(dot(N, H), 0.0), 0.16) * max(dot(N, L), 0.0) * 0.06;
  float spec2 = ggx(max(dot(N, normalize(normalize(vec3(0.85, 0.25, 0.35)) + V)), 0.0), 0.3) * 0.02;

  vec3 col;
  float alpha;
  float lambert = max(dot(N, L), 0.0);
  if (front) {
    // Outer face: milky pearl glass, mostly neutral.
    vec3 pearl = mix(vec3(0.915, 0.912, 0.935), vec3(0.972, 0.970, 0.982), uDark);
    vec3 body = pearl * (0.90 + 0.10 * lambert) * mix(vec3(1.0), sheen, 0.5);
    col = mix(body, refl, 0.22 + 0.6 * F);
    // Violet light from inside the glass, glimpsed where it thins out toward the edge.
    col = mix(col, mix(col, uAccent, 0.55), uGlow * (0.10 * grazing + 0.35 * fold * grazing));
    alpha = mix(mix(0.66, 0.58, uDark), 0.95, pow(grazing, 1.5));
    alpha = max(alpha, 0.66 * edge);
  } else {
    // Inner face: lit from within, a soft violet.
    vec3 inner = mix(vec3(0.935, 0.93, 0.975), uAccent, clamp(0.05 + 0.10 * uGlow + 0.6 * fold + 0.25 * edge, 0.0, 0.85));
    col = mix(inner, refl * mix(vec3(1.0), uAccent, 0.25), 0.18 + 0.45 * F);
    alpha = mix(0.60, 0.95, pow(grazing, 1.4));
  }
  col += vec3(1.0) * (spec + spec2);

  alpha *= edgeAA * uOpacity;
  // Premultiplied output; emission adds light (and a little coverage so it
  // still reads over bright windows).
  vec3 em = emission * edgeAA * uOpacity;
  outColor = vec4(col * alpha + em, min(1.0, alpha + dot(em, vec3(0.2))));
}
`;

export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUV;
void main() {
  vec2 p = P[gl_VertexID];
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;   // texel step * direction
out vec4 o;
void main() {
  // 9-tap gaussian using linear filtering (17 effective taps).
  vec4 c = texture(uTex, vUV) * 0.1964825501511404;
  vec2 o1 = uDir * 1.411764705882353;
  vec2 o2 = uDir * 3.2941176470588234;
  vec2 o3 = uDir * 5.176470588235294;
  c += (texture(uTex, vUV + o1) + texture(uTex, vUV - o1)) * 0.2969069646728344;
  c += (texture(uTex, vUV + o2) + texture(uTex, vUV - o2)) * 0.09447039785044732;
  c += (texture(uTex, vUV + o3) + texture(uTex, vUV - o3)) * 0.010381362401148057;
  o = c;
}
`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uShadow;
uniform sampler2D uGlowTex;
uniform float uShadowAlpha;
uniform float uGlowAmt;
uniform float uHalo;
uniform vec2 uCore;          // core light position, in UV
uniform float uCoreAmt;
uniform float uCoreSize;     // radius in UV-y units
uniform float uAspect;
uniform vec3 uAccent;
uniform float uLayers;
uniform float uBrightness;
out vec4 o;

void main() {
  vec4 l0 = texture(uL0, vUV);
  vec4 l1 = uLayers > 1.5 ? texture(uL1, vUV) : vec4(0.0);
  vec4 l2 = uLayers > 2.5 ? texture(uL2, vUV) : vec4(0.0);
  float sh = texture(uShadow, vUV).a * uShadowAlpha;
  vec4 gl = texture(uGlowTex, vUV);
  float halo = gl.a * uHalo;
  vec4 back = vec4(0.0, 0.0, 0.0, 1.0 - (1.0 - sh) * (1.0 - halo));

  vec4 c = l2 + (1.0 - l2.a) * back;
  c = l1 + (1.0 - l1.a) * c;
  c = l0 + (1.0 - l0.a) * c;
  c.rgb *= uBrightness;

  vec3 glow = gl.rgb * uGlowAmt;
  c.rgb += glow;
  c.a = min(1.0, c.a + dot(glow, vec3(0.25)));

  if (uCoreAmt > 0.001) {
    vec2 d = (vUV - uCore) * vec2(uAspect, 1.0);
    float r2 = dot(d, d);
    float s = uCoreSize;
    // A tiny white-hot point inside a violet bloom. The bloom carries real
    // coverage so the point is visible over white documents too.
    float core = exp(-r2 / (s * s * 0.30));
    float halo = exp(-r2 / (s * s * 4.0));
    vec3 bloom = mix(uAccent, vec3(1.0), 0.25);
    vec4 light = vec4(bloom * halo * 0.85, halo * 0.75);
    light = vec4(vec3(1.0) * core, core) + (1.0 - core) * light;
    light *= uCoreAmt;
    c = light + (1.0 - light.a) * c;
  }
  o = c;
}
`;
