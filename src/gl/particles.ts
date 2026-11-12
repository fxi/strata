/**
 * Particles in the currents of the cube: positions advected on the GPU with
 * transform feedback (two state buffers, ping-pong). Drawn as zartigl draws
 * its particles: each frame fades a screen-sized trail texture a little, then
 * adds the segment every particle moved (previous state → current one), so
 * the trails are the paths themselves, one pixel wide at any zoom. Each
 * particle keeps its depth: the stores give eastward and northward velocity only.
 */

import drawFrag from "./shaders/particles.draw.frag.glsl";
import drawVert from "./shaders/particles.draw.vert.glsl";
import updateFrag from "./shaders/particles.update.frag.glsl";
import updateVert from "./shaders/particles.update.vert.glsl";
import trailVert from "./shaders/trail.vert.glsl";
import fadeFrag from "./shaders/trail.fade.frag.glsl";
import compositeFrag from "./shaders/trail.composite.frag.glsl";
import type { Frame, Vec3 } from "./camera";

type GL = WebGL2RenderingContext;

function program(
  gl: GL,
  vert: string,
  frag: string,
  feedback?: string[],
): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Particle shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(p, shader);
  }
  if (feedback) {
    gl.transformFeedbackVaryings(p, feedback, gl.INTERLEAVED_ATTRIBS);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Particle program: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export interface ParticleStep {
  /** Model seconds advanced this frame. */
  modelSeconds: number;
  /** Real seconds this frame (ages, fades). */
  realSeconds: number;
  /** Volume fraction per (m/s · s) east and north. */
  rate: [number, number];
  mix: number;
  /** Seed of this frame's respawns (a frame counter keeps exports reproducible). */
  seed: number;
}

/** What the particles sample: the velocity fields, the mask and the depth table. */
export interface FlowTextures {
  u: [WebGLTexture, WebGLTexture];
  v: [WebGLTexture, WebGLTexture];
  mask: WebGLTexture;
  depth: WebGLTexture;
  depthSize: number;
  /** Cell size, volume fraction east and north. */
  cell: [number, number];
}

export interface ParticleDraw {
  frame: Frame;
  half: Vec3;
  slice: Vec3;
  /** Cut-away corner, per axis ±1, or 0s for none. */
  cut: Vec3;
  mix: number;
  speedMax: number;
  /** Particles drawn (the first ones): fewer when the cube is small on screen. */
  drawn: number;
  /** Share of the trails kept each frame (0–1): lower while the camera moves. */
  fade: number;
  /** Point size at each particle, device pixels. */
  point: number;
  /** Alpha left at the far side of the box from the viewer (depth cue), 0–1. */
  depthCue: number;
}

export class ParticleSystem {
  private update: WebGLProgram;
  private draw: WebGLProgram;
  private buffers: [WebGLBuffer, WebGLBuffer];
  private updateVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject];
  /** Draw VAOs by current buffer: a_curr from it, a_prev from the other. */
  private drawVaos: [WebGLVertexArrayObject, WebGLVertexArrayObject];
  private fadeProgram: WebGLProgram;
  private compositeProgram: WebGLProgram;
  /** Trail textures (RGBA8, straight color), ping-pong, at the canvas size. */
  private trails: Array<{
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
  }> = [];
  private trailSize = "";
  private trailIndex = 0;
  private emptyVao: WebGLVertexArrayObject;
  private feedback: WebGLTransformFeedback;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private current = 0;
  count = 0;
  /** Mean life of a particle, real seconds. */
  life = 4;
  /** > 1: more particles near the surface. */
  depthBias = 1.3;

  constructor(
    private gl: GL,
    count: number,
  ) {
    this.update = program(gl, updateVert, updateFrag, ["v_state"]);
    this.draw = program(gl, drawVert, drawFrag);
    this.fadeProgram = program(gl, trailVert, fadeFrag);
    this.compositeProgram = program(gl, trailVert, compositeFrag);
    this.emptyVao = gl.createVertexArray()!;
    this.buffers = [gl.createBuffer()!, gl.createBuffer()!];
    this.feedback = gl.createTransformFeedback()!;
    this.updateVaos = [gl.createVertexArray()!, gl.createVertexArray()!];
    this.drawVaos = [gl.createVertexArray()!, gl.createVertexArray()!];
    for (let i = 0; i < 2; i++) {
      gl.bindVertexArray(this.updateVaos[i]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[i]);
      const a = gl.getAttribLocation(this.update, "a_state");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(this.drawVaos[i]);
      for (const [name, buffer] of [
        ["a_curr", this.buffers[i]],
        ["a_prev", this.buffers[1 - i]],
      ] as const) {
        const b = gl.getAttribLocation(this.draw, name);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(b);
        gl.vertexAttribPointer(b, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(b, 1);
      }
    }
    gl.bindVertexArray(null);
    this.setCount(count);
  }

  /** Restarts with `count` particles, all due for a respawn. */
  setCount(count: number): void {
    const gl = this.gl;
    this.count = count;
    const state = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      state[i * 4] = Math.random();
      state[i * 4 + 1] = Math.random();
      state[i * 4 + 2] = Math.random();
      // Old: respawned on the first step, spread over the life so they do not blink together.
      state[i * 4 + 3] = 1e6;
    }
    for (const buffer of this.buffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, state, gl.DYNAMIC_COPY);
    }
    this.current = 0;
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${p === this.update ? "u" : p === this.draw ? "d" : p === this.fadeProgram ? "f" : "c"}:${name}`;
    if (!this.uniforms.has(key)) {
      this.uniforms.set(key, this.gl.getUniformLocation(p, name));
    }
    return this.uniforms.get(key)!;
  }

  private bindFlow(p: WebGLProgram, f: FlowTextures): void {
    const gl = this.gl;
    const bind = (
      unit: number,
      name: string,
      target: number,
      texture: WebGLTexture,
    ) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, texture);
      gl.uniform1i(this.u(p, name), unit);
    };
    bind(5, "u_mask", gl.TEXTURE_3D, f.mask);
    bind(6, "u_depth", gl.TEXTURE_2D, f.depth);
    bind(7, "u_u_a", gl.TEXTURE_3D, f.u[0]);
    bind(8, "u_u_b", gl.TEXTURE_3D, f.u[1]);
    bind(9, "u_v_a", gl.TEXTURE_3D, f.v[0]);
    bind(10, "u_v_b", gl.TEXTURE_3D, f.v[1]);
    gl.uniform1f(this.u(p, "u_depth_size"), f.depthSize);
    gl.uniform2fv(this.u(p, "u_cell"), f.cell);
  }

  step(flow: FlowTextures, s: ParticleStep): void {
    const gl = this.gl;
    if (!this.count) {
      return;
    }
    const p = this.update;
    gl.useProgram(p);
    this.bindFlow(p, flow);
    gl.uniform1f(this.u(p, "u_mix"), s.mix);
    gl.uniform2fv(this.u(p, "u_rate"), s.rate);
    gl.uniform1f(this.u(p, "u_dt"), s.modelSeconds);
    gl.uniform1f(this.u(p, "u_age"), s.realSeconds);
    gl.uniform1f(this.u(p, "u_life"), this.life);
    gl.uniform1f(this.u(p, "u_seed"), s.seed % 9973);
    gl.uniform1f(this.u(p, "u_depth_bias"), this.depthBias);
    const next = 1 - this.current;
    // A buffer cannot be bound for transform feedback and as the array buffer at once.
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindVertexArray(this.updateVaos[this.current]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[next]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    this.current = next;
  }

  /** Trail textures at the drawing buffer's size, cleared when it changes. */
  private ensureTrails(width: number, height: number): void {
    const gl = this.gl;
    const size = `${width}x${height}`;
    if (size === this.trailSize) {
      return;
    }
    this.trailSize = size;
    for (const trail of this.trails) {
      gl.deleteTexture(trail.texture);
      gl.deleteFramebuffer(trail.framebuffer);
    }
    this.trails = [0, 1].map(() => {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { texture, framebuffer };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Forgets the trails (particles turned on again, a jump in time). */
  clearTrails(): void {
    this.trailSize = "";
  }

  /**
   * Fades the trails, adds this frame's segments, and composites the trails
   * over what the canvas holds.
   */
  render(flow: FlowTextures, d: ParticleDraw): void {
    const gl = this.gl;
    if (!this.count) {
      return;
    }
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    this.ensureTrails(width, height);
    const previous = this.trails[this.trailIndex];
    const next = this.trails[1 - this.trailIndex];
    this.trailIndex = 1 - this.trailIndex;

    // 1. The previous trails, faded, into the next texture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.fadeProgram);
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    gl.uniform1i(this.u(this.fadeProgram, "u_trails"), 11);
    gl.uniform1f(this.u(this.fadeProgram, "u_opacity"), d.fade);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. This frame's segments, over them (straight color, alpha accumulates).
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    const p = this.draw;
    gl.useProgram(p);
    this.bindFlow(p, flow);
    gl.uniformMatrix4fv(this.u(p, "u_vp"), false, d.frame.viewProjection);
    gl.uniform3fv(this.u(p, "u_half"), d.half);
    gl.uniform3fv(this.u(p, "u_ray"), d.frame.ray);
    gl.uniform3fv(this.u(p, "u_slice"), d.slice);
    gl.uniform3fv(this.u(p, "u_cut"), d.cut);
    gl.uniform1f(this.u(p, "u_mix"), d.mix);
    gl.uniform1f(this.u(p, "u_speed_max"), d.speedMax);
    gl.uniform1f(this.u(p, "u_life"), this.life);
    // The box's extent along the view ray, for the depth cue.
    const ray = d.frame.ray;
    const norm = Math.hypot(ray[0], ray[1], ray[2]) || 1;
    const reach =
      (Math.abs(ray[0]) * d.half[0] +
        Math.abs(ray[1]) * d.half[1] +
        Math.abs(ray[2]) * d.half[2]) /
      norm;
    gl.uniform2f(this.u(p, "u_view_range"), -reach, reach);
    gl.uniform1f(this.u(p, "u_depth_cue"), d.depthCue);
    gl.bindVertexArray(this.drawVaos[this.current]);
    const drawn = Math.min(this.count, Math.max(0, Math.round(d.drawn)));
    // The path moved this frame, and a point at the particle: segments under a
    // pixel (slow water) draw nothing, the points do.
    gl.uniform1f(this.u(p, "u_point"), 0);
    gl.drawArraysInstanced(gl.LINES, 0, 2, drawn);
    gl.uniform1f(this.u(p, "u_point"), d.point);
    gl.drawArraysInstanced(gl.POINTS, 0, 1, drawn);

    // 3. The trails over the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, next.texture);
    gl.uniform1i(this.u(this.compositeProgram, "u_trails"), 11);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}
