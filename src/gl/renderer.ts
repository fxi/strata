/**
 * The cube in WebGL2: one raymarch pass over the box's front faces (slices,
 * isotherm and its depth contours), then lines on top: box edges (hidden ones dashed),
 * slice outlines, the ROI box, coastlines on the surface and axis ticks.
 */

import type { Volume } from "../data/blocks";
import type { Frame, Vec3 } from "./camera";
import { ParticleSystem, type FlowTextures } from "./particles";

type FieldName = "t" | "a" | "u" | "v";
import linesFrag from "./shaders/lines.frag.glsl";
import linesVert from "./shaders/lines.vert.glsl";
import volumeFrag from "./shaders/volume.frag.glsl";
import volumeVert from "./shaders/volume.vert.glsl";

export interface Show {
  slices: boolean;
  iso: boolean;
  roi: boolean;
  coast: boolean;
  /** Depth contours on the isotherm, with the 2D isotherms. */
  contours: boolean;
  /** Points of interest. */
  pois: boolean;
  /** Particles in the currents (contexts with a vector field). */
  particles: boolean;
}

export interface RenderState {
  /** World x, y, z of the slice planes. */
  slice: Vec3;
  show: Show;
  /** Blend of the next month, 0–1. */
  mix: number;
  domain: [number, number];
  /** Color the slices by the anomaly and draw the isotherm neutral. */
  anomaly: boolean;
  iso: number;
  /** Depth of the box bottom, metres. */
  bottom: number;
  /** Raymarch step, world units: larger on small screens. */
  step: number;
  /** Cells without data: dark land on the slices, or clear. */
  land: "solid" | "clear";
  /** Shade the boundary of the data (lake bed). */
  bed: boolean;
  /** Particles in the currents, with the slices as a cut-away corner. */
  particles?: {
    speedMax: number;
    /** Particles drawn this frame (see ParticleDraw.drawn). */
    drawn: number;
    /** Share of the trails kept this frame. */
    fade: number;
    /** Point size at each particle, device pixels. */
    point: number;
    /** Alpha left at the far side of the box from the viewer. */
    depthCue: number;
    /** Color from the shown scalar and the palette (else from speed). */
    tint: boolean;
  };
}

type GL = WebGL2RenderingContext;

function compile(gl: GL, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  constructor(
    private gl: GL,
    private program: WebGLProgram,
  ) {}
  get(name: string): WebGLUniformLocation | null {
    if (!this.cache.has(name)) {
      this.cache.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.cache.get(name)!;
  }
}

/** Unit cube faces, outward and counter-clockwise, as triangles. */
const FACES: Array<{ normal: Vec3; corners: Vec3[] }> = [
  {
    normal: [1, 0, 0],
    corners: [
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
      [1, -1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [-1, 1, -1],
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [1, 1, -1],
      [-1, 1, -1],
      [-1, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
  {
    normal: [0, 0, 1],
    corners: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [-1, 1, -1],
      [1, 1, -1],
      [1, -1, -1],
      [-1, -1, -1],
    ],
  },
];

function cubeTriangles(): Float32Array {
  const out: number[] = [];
  for (const { corners } of FACES) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      out.push(...corners[i]);
    }
  }
  return new Float32Array(out);
}

/** The 12 box edges as unit corners, with the two faces each one borders. */
const EDGES: Array<{ a: Vec3; b: Vec3; faces: [Vec3, Vec3] }> = (() => {
  const edges: Array<{ a: Vec3; b: Vec3; faces: [Vec3, Vec3] }> = [];
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const a: Vec3 = [0, 0, 0];
        a[axis] = -1;
        a[u] = su;
        a[v] = sv;
        const b: Vec3 = [...a];
        b[axis] = 1;
        const fu: Vec3 = [0, 0, 0];
        fu[u] = su;
        const fv: Vec3 = [0, 0, 0];
        fv[v] = sv;
        edges.push({ a, b, faces: [fu, fv] });
      }
    }
  }
  return edges;
})();

/** Interleaved (x, y, z, distance) vertices of line segments. */
export class LineBatch {
  data: number[] = [];

  segment(a: readonly number[], b: readonly number[]): this {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.data.push(a[0], a[1], a[2], 0, b[0], b[1], b[2], length);
    return this;
  }

  polyline(points: ReadonlyArray<readonly number[]>): this {
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      this.data.push(
        a[0],
        a[1],
        a[2],
        distance,
        b[0],
        b[1],
        b[2],
        distance + length,
      );
      distance += length;
    }
    return this;
  }

  /** The 12 edges of an axis-aligned box. */
  box(min: Vec3, max: Vec3): this {
    for (const { a, b } of EDGES) {
      const at = (c: Vec3) => c.map((s, i) => (s < 0 ? min[i] : max[i]));
      this.segment(at(a), at(b));
    }
    return this;
  }
}

interface Lines {
  buffer: WebGLBuffer;
  count: number;
}

export class CubeRenderer {
  readonly gl: GL;
  private volumeProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private volumeUniforms: Uniforms;
  private lineUniforms: Uniforms;
  private cube: WebGLBuffer;
  /** Each field on the store's levels, current and next step: value, 0 where missing. */
  private fields: Record<FieldName, [WebGLTexture, WebGLTexture]>;
  /** Cells with data (static: land and the bed do not move), 1 or 0. */
  private mask: WebGLTexture;
  private masked = false;
  /** Cell size of the grid, volume fraction east and north. */
  private cell: [number, number] = [1, 1];
  /** Texture depth coordinate of regular depths (depthTable), fetched and interpolated. */
  private depth: WebGLTexture;
  private depthSize = 1;
  /** Reused for the upload: values with missing cells at 0. */
  private scratch = new Float32Array(0);
  /**
   * R32F where float textures filter (no conversion on upload: the driver's
   * float → half conversion costs ~20 ms per field), else R16F.
   */
  private fieldFormat: number;
  /** Allocated size of each field texture, so steps upload with texSubImage3D. */
  private sizes = new WeakMap<WebGLTexture, string>();
  private lut: WebGLTexture;
  private lines = new Map<string, Lines>();
  private edges: WebGLBuffer;
  private particleSystem: ParticleSystem | null = null;
  /** Uploads of the next step, spread over frames. */
  private queue: Array<() => void> = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    private half: Vec3,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      premultipliedAlpha: true,
      alpha: false,
    });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    this.gl = gl;
    this.fieldFormat = gl.getExtension("OES_texture_float_linear")
      ? gl.R32F
      : gl.R16F;
    this.volumeProgram = compile(gl, volumeVert, volumeFrag);
    this.lineProgram = compile(gl, linesVert, linesFrag);
    this.volumeUniforms = new Uniforms(gl, this.volumeProgram);
    this.lineUniforms = new Uniforms(gl, this.lineProgram);
    this.cube = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.bufferData(gl.ARRAY_BUFFER, cubeTriangles(), gl.STATIC_DRAW);
    const pair = (): [WebGLTexture, WebGLTexture] => [
      this.volumeTexture(),
      this.volumeTexture(),
    ];
    this.fields = { t: pair(), a: pair(), u: pair(), v: pair() };
    this.mask = this.volumeTexture();
    this.depth = gl.createTexture()!;
    this.setDepthTable(new Float32Array([0.5, 0.5]));
    this.lut = gl.createTexture()!;
    this.edges = gl.createBuffer()!;
    const batch = new LineBatch();
    for (const { a, b } of EDGES) {
      batch.segment(
        a.map((s, i) => s * half[i]),
        b.map((s, i) => s * half[i]),
      );
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edges);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(batch.data),
      gl.STATIC_DRAW,
    );
  }

  private volumeTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const wrap of [
      gl.TEXTURE_WRAP_S,
      gl.TEXTURE_WRAP_T,
      gl.TEXTURE_WRAP_R,
    ]) {
      gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
    }
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R16F,
      1,
      1,
      1,
      0,
      gl.RED,
      gl.FLOAT,
      new Float32Array(1),
    );
    return texture;
  }

  /** Texture depth coordinates of regular depths, surface to bottom (see depthTable). */
  setDepthTable(table: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.depth);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32F,
      table.length,
      1,
      0,
      gl.RED,
      gl.FLOAT,
      table,
    );
    this.depthSize = table.length;
  }

  /** Uploads one field: missing cells at 0, the mask tells them apart. */
  private upload(
    texture: WebGLTexture,
    volume: Volume,
    data: Float32Array,
  ): void {
    const gl = this.gl;
    if (this.scratch.length !== data.length) {
      this.scratch = new Float32Array(data.length);
    }
    const out = this.scratch;
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      out[i] = value === value ? value : 0;
    }
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const size = `${volume.cols}x${volume.rows}x${volume.levels}`;
    if (this.sizes.get(texture) !== size) {
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        this.fieldFormat,
        volume.cols,
        volume.rows,
        volume.levels,
        0,
        gl.RED,
        gl.FLOAT,
        out,
      );
      this.sizes.set(texture, size);
      return;
    }
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      0,
      0,
      0,
      volume.cols,
      volume.rows,
      volume.levels,
      gl.RED,
      gl.FLOAT,
      out,
    );
  }

  /** The cells with data, from a volume's values (once: the mask is static). */
  private setMask(volume: Volume): void {
    const gl = this.gl;
    const bytes = new Uint8Array(volume.values.length);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.isNaN(volume.values[i]) ? 0 : 255;
    }
    gl.bindTexture(gl.TEXTURE_3D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      volume.cols,
      volume.rows,
      volume.levels,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      bytes,
    );
    this.masked = true;
    this.cell = [1 / volume.cols, 1 / volume.rows];
  }

  /**
   * Uploads a step into slot 0 (current) or 1 (next): its values, and its
   * anomaly and velocity when it has them, on the store's own levels.
   */
  setVolume(slot: 0 | 1, volume: Volume, spread = false): void {
    if (!this.masked) {
      this.setMask(volume);
    }
    const tasks = [
      () => this.upload(this.fields.t[slot], volume, volume.values),
    ];
    if (volume.anomaly) {
      const anomaly = volume.anomaly;
      tasks.push(() => this.upload(this.fields.a[slot], volume, anomaly));
    }
    if (volume.u && volume.v) {
      const { u, v } = volume;
      tasks.push(() => this.upload(this.fields.u[slot], volume, u));
      tasks.push(() => this.upload(this.fields.v[slot], volume, v));
    }
    // A new upload replaces what was queued for the next slot.
    this.queue = [];
    if (spread) {
      this.queue = tasks;
    } else {
      tasks.forEach((task) => task());
    }
  }

  /** Uploads one queued field (one per frame keeps frames short); true when none is left. */
  pump(): boolean {
    this.queue.shift()?.();
    return this.queue.length === 0;
  }

  /** Uploads every queued field now. */
  flush(): void {
    while (!this.pump()) {
      // Until the queue is empty.
    }
  }

  /** Whether the next slot still has fields to upload (not ready to blend or swap). */
  get uploading(): boolean {
    return this.queue.length > 0;
  }

  /** Swaps the current and next months, when the next becomes current. */
  swapVolumes(): void {
    this.flush();
    for (const name of Object.keys(this.fields) as FieldName[]) {
      const [a, b] = this.fields[name];
      this.fields[name] = [b, a];
    }
  }

  /** The textures the particles sample. */
  private flowTextures(): FlowTextures {
    return {
      u: this.fields.u,
      v: this.fields.v,
      mask: this.mask,
      depth: this.depth,
      depthSize: this.depthSize,
      cell: this.cell,
      t: this.fields.t,
      a: this.fields.a,
      lut: this.lut,
    };
  }

  /** The particle system, created on first use with `count` particles. */
  particles(count: number): ParticleSystem {
    this.particleSystem ??= new ParticleSystem(this.gl, count);
    if (this.particleSystem.count !== count) {
      this.particleSystem.setCount(count);
    }
    return this.particleSystem;
  }

  /** Starts the particle trails afresh. */
  clearTrails(): void {
    this.particleSystem?.clearTrails();
  }

  /** Advances the particles; see ParticleSystem.step. */
  stepParticles(step: Parameters<ParticleSystem["step"]>[1]): void {
    this.particleSystem?.step(this.flowTextures(), step);
  }

  /** The cut-away corner for a view: the side of each plane facing the viewer. */
  static cut(ray: readonly number[]): Vec3 {
    return [0, 1, 2].map((i) => (ray[i] > 0 ? -1 : 1)) as Vec3;
  }

  setPalette(bytes: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bytes.length / 4,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  /** Replaces a named set of line segments. */
  setLines(name: string, batch: LineBatch): void {
    const gl = this.gl;
    let lines = this.lines.get(name);
    if (!lines) {
      lines = { buffer: gl.createBuffer()!, count: 0 };
      this.lines.set(name, lines);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, lines.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(batch.data),
      gl.DYNAMIC_DRAW,
    );
    lines.count = batch.data.length / 4;
  }

  /** Whether a box face (unit normal) faces the viewer. */
  static faces(normal: readonly number[], ray: readonly number[]): boolean {
    return normal[0] * ray[0] + normal[1] * ray[1] + normal[2] * ray[2] < 0;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  render(frame: Frame, state: RenderState): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Volume.
    gl.useProgram(this.volumeProgram);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const u = this.volumeUniforms;
    gl.uniformMatrix4fv(u.get("u_vp"), false, frame.viewProjection);
    gl.uniform3fv(u.get("u_half"), this.half);
    gl.uniform3fv(u.get("u_ray"), frame.ray);
    gl.uniform1f(u.get("u_mix"), state.mix);
    gl.uniform2fv(u.get("u_domain"), state.domain);
    gl.uniform1f(u.get("u_anomaly"), state.anomaly ? 1 : 0);
    gl.uniform1f(u.get("u_depth_size"), this.depthSize);
    gl.uniform3fv(u.get("u_slice"), state.slice);
    gl.uniform3f(
      u.get("u_show"),
      state.show.slices ? 1 : 0,
      state.show.iso ? 1 : 0,
      state.show.contours ? 1 : 0,
    );
    gl.uniform1f(u.get("u_bottom"), state.bottom);
    gl.uniform1f(u.get("u_iso"), state.iso);
    gl.uniform1f(u.get("u_step"), state.step);
    gl.uniform1f(u.get("u_land"), state.land === "solid" ? 1 : 0);
    gl.uniform1f(u.get("u_bed"), state.bed ? 1 : 0);
    const cut: Vec3 =
      state.particles && state.show.slices
        ? CubeRenderer.cut(frame.ray)
        : [0, 0, 0];
    gl.uniform3fv(u.get("u_cut"), cut);
    const bind = (
      unit: number,
      name: string,
      target: number,
      texture: WebGLTexture,
    ) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, texture);
      gl.uniform1i(u.get(name), unit);
    };
    bind(0, "u_t_a", gl.TEXTURE_3D, this.fields.t[0]);
    bind(1, "u_t_b", gl.TEXTURE_3D, this.fields.t[1]);
    bind(2, "u_lut", gl.TEXTURE_2D, this.lut);
    bind(3, "u_a_a", gl.TEXTURE_3D, this.fields.a[0]);
    bind(4, "u_a_b", gl.TEXTURE_3D, this.fields.a[1]);
    bind(5, "u_mask", gl.TEXTURE_3D, this.mask);
    bind(6, "u_depth", gl.TEXTURE_2D, this.depth);
    const position = gl.getAttribLocation(this.volumeProgram, "a_pos");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cube);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 36);
    gl.disableVertexAttribArray(position);
    gl.disable(gl.CULL_FACE);

    // Particles, over the volume.
    if (state.particles && this.particleSystem) {
      this.particleSystem.render(this.flowTextures(), {
        frame,
        half: this.half,
        slice: state.slice,
        cut,
        mix: state.mix,
        speedMax: state.particles.speedMax,
        drawn: state.particles.drawn,
        fade: state.particles.fade,
        point: state.particles.point,
        depthCue: state.particles.depthCue,
        tinted: state.particles.tint,
        anomaly: state.anomaly,
        domain: state.domain,
      });
    }

    // Lines.
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(
      this.lineUniforms.get("u_vp"),
      false,
      frame.viewProjection,
    );
    EDGES.forEach((edge, i) => {
      const visible = edge.faces.some((normal) =>
        CubeRenderer.faces(normal, frame.ray),
      );
      this.drawLines(
        this.edges,
        i * 2,
        2,
        visible ? [1, 1, 1, 0.75] : [1, 1, 1, 0.3],
        visible ? 0 : 0.03,
      );
    });
    const topVisible = CubeRenderer.faces([0, 0, 1], frame.ray);
    if (state.show.coast) {
      this.drawNamed("coast", [0.92, 0.94, 0.96, topVisible ? 0.85 : 0.18], 0);
    }
    this.drawNamed("ticks", [1, 1, 1, 0.55], 0);
    if (state.show.slices) {
      this.drawNamed("slices", [1, 1, 1, 0.5], 0);
    }
    if (state.show.roi) {
      this.drawNamed("roi", [1, 1, 1, 0.95], 0.04);
    }
    if (state.show.pois) {
      this.drawNamed("pois", [1, 0.86, 0.45, 0.95], 0);
      this.drawNamed("drops", [1, 0.86, 0.45, 0.8], 0.012);
    }
  }

  private drawNamed(name: string, color: number[], dash: number): void {
    const lines = this.lines.get(name);
    if (lines && lines.count) {
      this.drawLines(lines.buffer, 0, lines.count, color, dash);
    }
  }

  private drawLines(
    buffer: WebGLBuffer,
    first: number,
    count: number,
    color: number[],
    dash: number,
  ): void {
    const gl = this.gl;
    const position = gl.getAttribLocation(this.lineProgram, "a_pos");
    const distance = gl.getAttribLocation(this.lineProgram, "a_dist");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(distance);
    gl.vertexAttribPointer(distance, 1, gl.FLOAT, false, 16, 12);
    gl.uniform4fv(this.lineUniforms.get("u_color"), color);
    gl.uniform1f(this.lineUniforms.get("u_dash"), dash);
    gl.drawArrays(gl.LINES, first, count);
    gl.disableVertexAttribArray(position);
    gl.disableVertexAttribArray(distance);
  }
}
