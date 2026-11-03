/**
 * A small WebGL2 volume renderer for the fourth panel of the three-plane view: it marches rays through a 3D texture of the grey
 * values (and one of the mask) and composites front to back, with a simple headlight. Nothing is drawn until the first frame is
 * asked for, and frames are only drawn when something changed.
 *
 * World axes: x to the right (columns of the mask grid), y up (slices), z towards the viewer (rows run the other way, so that the
 * volume is not mirrored). One unit is one millimetre.
 */

export interface RenderParams {
  /** grey values (0..1) below `low` are transparent, above `high` fully opaque (times `density`) */
  low: number;
  high: number;
  density: number;
  /** maximum intensity projection instead of compositing */
  mip: boolean;
  showImage: boolean;
  showMask: boolean;
  maskColor: [number, number, number];
  maskOpacity: number;
  /** the labels of a linked segmentation file, each segment in its own colour */
  showLabels: boolean;
  labelOpacity: number;
}

export const DEFAULT_RENDER: RenderParams = { low: 0.45, high: 0.75, density: 0.9, mip: false, showImage: true, showMask: true, maskColor: [1, 0.2, 0.2], maskOpacity: 0.85, showLabels: true, labelOpacity: 0.85 };

export interface Presets {
  [name: string]: Pick<RenderParams, "low" | "high" | "density" | "mip">;
}

export const PRESETS: Presets = {
  Bone: { low: 0.45, high: 0.75, density: 0.9, mip: false },
  "Soft tissue": { low: 0.22, high: 0.5, density: 0.35, mip: false },
  "Maximum intensity": { low: 0.3, high: 1, density: 1, mip: true },
};

const VERT = `#version 300 es
in vec2 pos;
out vec2 ndc;
void main() { ndc = pos; gl_Position = vec4(pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 ndc;
out vec4 outColor;
uniform sampler3D vol;
uniform sampler3D msk;
uniform sampler3D lbl;   // RG8: how much of the cell is labelled, which segment
uniform sampler2D pal;   // 256 x 1 segment colours
uniform vec3 size3;      // cells
uniform vec3 ext;        // mm
uniform vec3 camPos;
uniform vec3 camRight;
uniform vec3 camUp;
uniform vec3 camFwd;
uniform float aspect;
uniform float tanHalfFov;
uniform int steps;
uniform vec2 win;        // low, high
uniform float density;
uniform bool mip;
uniform bool showImage;
uniform bool showMask;
uniform vec3 maskColor;
uniform float maskOpacity;
uniform bool showLabels;
uniform float labelOpacity;
uniform vec3 texel;      // 1 / texture size

vec3 toTex(vec3 p) { return vec3(p.x / ext.x + 0.5, 0.5 - p.z / ext.y, p.y / ext.z + 0.5); }

float gv(vec3 t) { return texture(vol, t).r; }
float gm(vec3 t) { return texture(msk, t).r; }

vec3 gradV(vec3 t) {
  return vec3(gv(t + vec3(texel.x, 0, 0)) - gv(t - vec3(texel.x, 0, 0)),
              gv(t + vec3(0, texel.y, 0)) - gv(t - vec3(0, texel.y, 0)),
              gv(t + vec3(0, 0, texel.z)) - gv(t - vec3(0, 0, texel.z)));
}
float labCover(vec3 t) { return texture(lbl, t).r; }
vec3 gradL(vec3 t) {
  return vec3(labCover(t + vec3(texel.x, 0, 0)) - labCover(t - vec3(texel.x, 0, 0)),
              labCover(t + vec3(0, texel.y, 0)) - labCover(t - vec3(0, texel.y, 0)),
              labCover(t + vec3(0, 0, texel.z)) - labCover(t - vec3(0, 0, texel.z)));
}
vec3 gradM(vec3 t) {
  return vec3(gm(t + vec3(texel.x, 0, 0)) - gm(t - vec3(texel.x, 0, 0)),
              gm(t + vec3(0, texel.y, 0)) - gm(t - vec3(0, texel.y, 0)),
              gm(t + vec3(0, 0, texel.z)) - gm(t - vec3(0, 0, texel.z)));
}
// a gradient in texture space as a direction in the world (texture axes: x, -z, y)
vec3 world(vec3 g) { return vec3(g.x / ext.x, g.z / ext.z, -g.y / ext.y); }

float shade(vec3 g, vec3 viewDir) {
  vec3 n = world(g);
  float l = length(n);
  if (l < 1e-6) return 0.55;
  n /= l;
  return 0.35 + 0.65 * abs(dot(n, -viewDir));
}

void main() {
  vec3 dir = normalize(camFwd + camRight * (ndc.x * aspect * tanHalfFov) + camUp * (ndc.y * tanHalfFov));
  vec3 half_ = ext * 0.5;
  vec3 inv = 1.0 / dir;
  vec3 t0 = (-half_ - camPos) * inv;
  vec3 t1 = (half_ - camPos) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  vec3 bg = vec3(0.07, 0.07, 0.09);
  if (tf <= tn) { outColor = vec4(bg, 1.0); return; }
  float len = tf - tn;
  float dt = len / float(steps);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float best = 0.0;
  float stepScale = dt / (max(max(ext.x, ext.y), ext.z) / 128.0);
  for (int i = 0; i < 1024; i++) {
    if (i >= steps) break;
    vec3 p = camPos + dir * (tn + (float(i) + jitter) * dt);
    vec3 t = toTex(p);
    if (showImage) {
      float s = gv(t);
      if (mip) {
        best = max(best, s);
      } else {
        float a = smoothstep(win.x, win.y, s) * density;
        if (a > 0.002) {
          a = 1.0 - pow(1.0 - min(a, 0.999), stepScale);
          float lit = shade(gradV(t), dir);
          vec3 c = mix(vec3(0.75, 0.62, 0.5), vec3(1.0, 0.97, 0.9), s) * lit;
          col += (1.0 - alpha) * a * c;
          alpha += (1.0 - alpha) * a;
        }
      }
    }
    if (showMask) {
      float m = gm(t);
      if (m > 0.2) {
        float a = clamp((m - 0.2) * 3.0, 0.0, 1.0) * maskOpacity;
        a = 1.0 - pow(1.0 - min(a, 0.999), stepScale);
        float lit = shade(gradM(t), dir);
        col += (1.0 - alpha) * a * maskColor * lit;
        alpha += (1.0 - alpha) * a;
      }
    }
    if (showLabels) {
      float m = labCover(t);
      if (m > 0.2) {
        float a = clamp((m - 0.2) * 3.0, 0.0, 1.0) * labelOpacity;
        a = 1.0 - pow(1.0 - min(a, 0.999), stepScale);
        float lit = shade(gradL(t), dir);
        float idx = texelFetch(lbl, ivec3(clamp(floor(t * size3), vec3(0.0), size3 - 1.0)), 0).g * 255.0;
        vec3 c = texelFetch(pal, ivec2(int(idx + 0.5), 0), 0).rgb;
        col += (1.0 - alpha) * a * c * lit;
        alpha += (1.0 - alpha) * a;
      }
    }
    if (alpha > 0.97) break;
  }
  if (mip && showImage) {
    float v = smoothstep(win.x, win.y, best);
    col += (1.0 - alpha) * vec3(v);
    alpha = 1.0;
  }
  outColor = vec4(col + (1.0 - alpha) * bg, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export class VolumeRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vtex: WebGLTexture;
  private mtex: WebGLTexture;
  private ltex: WebGLTexture;
  private ptex: WebGLTexture;
  private loc = new Map<string, WebGLUniformLocation | null>();
  private ext: [number, number, number] = [1, 1, 1];
  private dims: [number, number, number] = [1, 1, 1];
  private params: RenderParams = { ...DEFAULT_RENDER };
  private haveVolume = false;
  private haveMask = false;
  private haveLabels = false;
  private yaw = 0.5;
  private pitch = 0.25;
  private dist = 1.1;
  private queued = false;
  private idle = 0;
  private disposed = false;
  /** the image is only calm for a moment after a change: a coarse frame at once, the fine one when nothing moves */
  private coarse = true;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This browser has no WebGL2.");
    this.gl = gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "program");
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, "pos");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    this.vtex = this.texture();
    this.mtex = this.texture();
    this.ltex = this.texture();
    const pt = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, pt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.ptex = pt;
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    return t;
  }

  private upload(tex: WebGLTexture, unit: number, data: Uint8Array, dims: [number, number, number]) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, dims[0], dims[1], dims[2], 0, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  setVolume(data: Uint8Array, dims: [number, number, number], extent: [number, number, number]) {
    this.dims = dims;
    this.ext = extent;
    this.upload(this.vtex, 0, data, dims);
    this.haveVolume = true;
    this.dist = 1.1;
    this.draw();
  }

  /** The mask on the same grid (or none). */
  setMask(data: Uint8Array | null) {
    if (data) this.upload(this.mtex, 1, data, this.dims);
    this.haveMask = !!data;
    this.draw();
  }

  /**
   * The labels of a linked segmentation file on the same grid, two bytes per cell (coverage, segment + 1), and the colours of the
   * segments (`colors[i]` is segment i, as 0..255 RGB); or none.
   */
  setLabels(data: Uint8Array | null, colors: [number, number, number][] = []) {
    const gl = this.gl;
    if (data) {
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_3D, this.ltex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, this.dims[0], this.dims[1], this.dims[2], 0, gl.RG, gl.UNSIGNED_BYTE, data);
      const pal = new Uint8Array(256 * 4);
      colors.slice(0, 255).forEach((c, i) => pal.set([c[0], c[1], c[2], 255], (i + 1) * 4));
      gl.activeTexture(gl.TEXTURE0 + 3);
      gl.bindTexture(gl.TEXTURE_2D, this.ptex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);
    }
    this.haveLabels = !!data;
    this.draw();
  }

  setParams(p: Partial<RenderParams>) {
    this.params = { ...this.params, ...p };
    this.draw();
  }

  resetView() {
    this.yaw = 0.5;
    this.pitch = 0.25;
    this.dist = 1.1;
    this.draw();
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.008;
    this.pitch = Math.min(Math.max(this.pitch + dy * 0.008, -1.5), 1.5);
    this.draw();
  }

  zoom(f: number) {
    this.dist = Math.min(Math.max(this.dist * f, 0.6), 8);
    this.draw();
  }

  /** Asks for a frame: a coarse one right away, a fine one when nothing changed for a moment. */
  draw() {
    this.coarse = true;
    window.clearTimeout(this.idle);
    this.idle = window.setTimeout(() => {
      this.coarse = false;
      this.schedule();
    }, 220);
    this.schedule();
  }

  private schedule() {
    if (this.queued || this.disposed) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.disposed) this.frame();
    });
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name) ?? null;
  }

  private frame() {
    const gl = this.gl;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * (this.coarse ? 0.5 : 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    gl.viewport(0, 0, w, h);
    if (!this.haveVolume) {
      gl.clearColor(0.07, 0.07, 0.09, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.useProgram(this.prog);
    const [ex, ey, ez] = this.ext;
    const size = Math.max(ex, ey, ez);
    const cp = Math.cos(this.pitch);
    const eye: [number, number, number] = [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp].map((v) => v * this.dist * size) as [number, number, number];
    const fwd = norm([-eye[0], -eye[1], -eye[2]]);
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const p = this.params;
    gl.uniform1i(this.u("vol"), 0);
    gl.uniform1i(this.u("msk"), 1);
    gl.uniform1i(this.u("lbl"), 2);
    gl.uniform1i(this.u("pal"), 3);
    gl.uniform3f(this.u("ext"), ex, ey, ez);
    gl.uniform3f(this.u("camPos"), ...eye);
    gl.uniform3f(this.u("camRight"), ...right);
    gl.uniform3f(this.u("camUp"), ...up);
    gl.uniform3f(this.u("camFwd"), ...fwd);
    gl.uniform1f(this.u("aspect"), w / h);
    gl.uniform1f(this.u("tanHalfFov"), Math.tan((35 * Math.PI) / 180));
    gl.uniform1i(this.u("steps"), this.coarse ? 120 : 420);
    gl.uniform2f(this.u("win"), p.low, Math.max(p.high, p.low + 0.01));
    gl.uniform1f(this.u("density"), p.density);
    gl.uniform1i(this.u("mip"), p.mip ? 1 : 0);
    gl.uniform1i(this.u("showImage"), p.showImage ? 1 : 0);
    gl.uniform1i(this.u("showMask"), p.showMask && this.haveMask ? 1 : 0);
    gl.uniform3f(this.u("maskColor"), ...p.maskColor);
    gl.uniform1f(this.u("maskOpacity"), p.maskOpacity);
    gl.uniform1i(this.u("showLabels"), p.showLabels && this.haveLabels ? 1 : 0);
    gl.uniform1f(this.u("labelOpacity"), p.labelOpacity);
    gl.uniform3f(this.u("size3"), this.dims[0], this.dims[1], this.dims[2]);
    gl.uniform3f(this.u("texel"), 1 / this.dims[0], 1 / this.dims[1], 1 / this.dims[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.idle);
    const gl = this.gl;
    gl.deleteTexture(this.vtex);
    gl.deleteTexture(this.mtex);
    gl.deleteTexture(this.ltex);
    gl.deleteTexture(this.ptex);
    gl.deleteProgram(this.prog);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** `#rrggbb` as 0..1 components. */
export function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 0.2, 0.2];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
