/**
 * Video export: the cube rendered frame by frame at a fixed size (vertical,
 * square or landscape), composited with its title, date, color scale and
 * credit, encoded in the browser with WebCodecs through mediabunny (the first
 * of H.264, HEVC, VP9 or AV1 the browser encodes) and muxed to MP4. Each frame is rendered on demand, so the clip does not depend
 * on the speed of the machine or the network.
 */

import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import { rampColor } from "../palettes";
import { saveFile } from "../ui/context-picker";

export interface Overlay {
  title: string;
  subtitle: string;
  credit: string;
  legendTitle: string;
  ramp: Uint8Array;
  domain: [number, number];
  /** Labels at canvas pixels (places), drawn over the cube. */
  labels: Array<{ text: string; x: number; y: number }>;
}

export interface VideoHost {
  contextId: string;
  /** The shown step and the last one. */
  start: number;
  last: number;
  text: (step: number) => string;
  key: (step: number) => string;
  /** Stops the live view and sizes the renderer for the clip. */
  begin: (width: number, height: number) => void;
  /**
   * Renders step `m` (fractional: blends into the next) into the GL canvas,
   * with the particles advanced `modelSeconds`, the camera turned `yaw` radians
   * from the current view. Resolves with the canvas, drawn and not yet cleared.
   */
  frame: (
    m: number,
    options: {
      width: number;
      height: number;
      yaw: number;
      frameIndex: number;
      fps: number;
      stepsPerSecond: number;
    },
  ) => Promise<HTMLCanvasElement>;
  overlay: (width: number, height: number) => Overlay;
  /** Restores the live view. */
  end: () => void;
}

const SIZES: Record<string, [number, number]> = {
  vertical: [1080, 1920],
  square: [1080, 1080],
  landscape: [1920, 1080],
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

const FONT = '"IBM Plex Mono", ui-monospace, monospace';

/** Title, date, color scale and credit around the cube. */
function composite(
  ctx: CanvasRenderingContext2D,
  cube: HTMLCanvasElement,
  width: number,
  height: number,
  date: string,
  o: Overlay,
): void {
  const unit = Math.min(width, height) / 1080;
  const pad = 56 * unit;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(cube, 0, 0, width, height);

  ctx.textBaseline = "top";
  ctx.fillStyle = "#eceef1";
  ctx.font = `600 ${40 * unit}px ${FONT}`;
  let y = pad;
  const wrap = (text: string, size: number, color: string, weight = 400) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    const words = text.split(" ");
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width - 2 * pad && line) {
        ctx.fillText(line, pad, y);
        y += size * 1.3;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) {
      ctx.fillText(line, pad, y);
      y += size * 1.3;
    }
  };
  wrap(o.title, 40 * unit, "#eceef1", 600);
  y += 6 * unit;
  wrap(o.subtitle, 24 * unit, "rgba(236, 238, 241, 0.7)");

  // Places.
  ctx.font = `${20 * unit}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const label of o.labels) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillText(
      label.text,
      label.x + 1.5 * unit,
      label.y - 6 * unit + 1.5 * unit,
    );
    ctx.fillStyle = "#ffdb73";
    ctx.fillText(label.text, label.x, label.y - 6 * unit);
  }
  ctx.textAlign = "left";

  // Date, large, and the color scale at the bottom.
  const bottom = height - pad;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(236, 238, 241, 0.6)";
  ctx.font = `${18 * unit}px ${FONT}`;
  ctx.fillText(o.credit, pad, bottom, width - 2 * pad);
  const barY = bottom - 92 * unit;
  const barW = width - 2 * pad;
  const barH = 16 * unit;
  for (let x = 0; x < barW; x++) {
    const [r, g, b] = rampColor(o.ramp, x / barW);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(pad + x, barY, 1.5, barH);
  }
  ctx.fillStyle = "#eceef1";
  ctx.font = `${20 * unit}px ${FONT}`;
  ctx.fillText(String(o.domain[0]), pad, barY + barH + 28 * unit);
  ctx.textAlign = "right";
  ctx.fillText(String(o.domain[1]), pad + barW, barY + barH + 28 * unit);
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(236, 238, 241, 0.7)";
  ctx.fillText(o.legendTitle, pad + barW / 2, barY + barH + 28 * unit);
  ctx.textAlign = "left";
  ctx.fillStyle = "#eceef1";
  ctx.font = `500 ${52 * unit}px ${FONT}`;
  ctx.fillText(date, pad, barY - 28 * unit);
}

export class VideoExporter {
  private backdrop: HTMLElement;
  private form: HTMLFormElement;
  private progress: HTMLProgressElement;
  private message: HTMLElement;
  private running = false;
  private cancelled = false;

  constructor(
    private button: HTMLButtonElement,
    private host: () => VideoHost | null,
  ) {
    this.backdrop = element("div", "", "context-backdrop");
    this.backdrop.hidden = true;
    const dialog = element("section", "", "context-picker video-export");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Export video");
    this.backdrop.append(dialog);
    document.body.append(this.backdrop);

    const header = element("header");
    header.append(element("h2", "EXPORT VIDEO"));
    const close = element("button", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.close());
    header.append(close);

    this.form = element("form", "", "video-form");
    this.form.innerHTML = `
      <label>FORMAT
        <select name="size">
          <option value="vertical">1080 × 1920 · vertical (reels, stories)</option>
          <option value="square">1080 × 1080 · square</option>
          <option value="landscape">1920 × 1080 · landscape</option>
        </select>
      </label>
      <label>DURATION (s) <input name="seconds" type="number" min="1" max="120" value="10" /></label>
      <label>TIME STEPS PER SECOND <input name="rate" type="number" min="0" max="120" step="0.25" value="4" /></label>
      <label>FRAMES PER SECOND
        <select name="fps"><option>24</option><option selected>30</option><option>60</option></select>
      </label>
      <label>CAMERA ORBIT (°) <input name="orbit" type="number" min="-360" max="360" value="40" /></label>
      <p class="muted" data-span></p>
      <div class="context-actions">
        <button type="submit">Render MP4</button>
        <button type="button" data-cancel hidden>Cancel</button>
      </div>`;
    this.progress = element("progress");
    this.progress.max = 1;
    this.progress.value = 0;
    this.progress.hidden = true;
    this.message = element("pre", "", "context-message");
    this.message.hidden = true;
    dialog.append(header, this.form, this.progress, this.message);

    this.form.addEventListener("input", () => this.describe());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.render();
    });
    this.form
      .querySelector<HTMLButtonElement>("[data-cancel]")!
      .addEventListener("click", () => (this.cancelled = true));
    button.addEventListener("click", () => this.open());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.running) {
        this.close();
      }
    });
    this.backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === this.backdrop && !this.running) {
        this.close();
      }
    });
  }

  private value(name: string): number {
    const field = this.form.elements.namedItem(name) as HTMLInputElement;
    return Number(field.value);
  }

  private describe(): void {
    const host = this.host();
    const span = this.form.querySelector<HTMLElement>("[data-span]")!;
    if (!host) {
      span.textContent = "The cube is still loading.";
      return;
    }
    const steps = this.value("seconds") * this.value("rate");
    const end = Math.min(host.last, host.start + steps);
    span.textContent = `From ${host.text(host.start)} to ${host.text(Math.floor(end))} (${Math.round(end - host.start)} steps), starting at the shown step.`;
  }

  open(): void {
    this.backdrop.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    this.describe();
  }

  close(): void {
    this.backdrop.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }

  private say(text: string | null, error = false): void {
    this.message.hidden = !text;
    this.message.textContent = text ?? "";
    this.message.classList.toggle("is-error", error);
  }

  private async render(): Promise<void> {
    const host = this.host();
    if (!host || this.running) {
      return;
    }
    if (typeof VideoEncoder === "undefined") {
      this.say(
        "This browser has no WebCodecs video encoder (try Chrome, Edge or Safari 17+).",
        true,
      );
      return;
    }
    const sizeName = (this.form.elements.namedItem("size") as HTMLSelectElement)
      .value;
    const [width, height] = SIZES[sizeName];
    const fps = this.value("fps");
    const seconds = this.value("seconds");
    const stepsPerSecond = this.value("rate");
    const orbit = (this.value("orbit") * Math.PI) / 180;
    const frames = Math.max(1, Math.round(seconds * fps));
    const format = new Mp4OutputFormat({ fastStart: "in-memory" });
    const codec = await getFirstEncodableVideoCodec(
      format.getSupportedVideoCodecs(),
      { width, height, quality: QUALITY_HIGH },
    );
    if (!codec) {
      this.say("This browser cannot encode video at this size.", true);
      return;
    }

    this.running = true;
    this.cancelled = false;
    const cancel = this.form.querySelector<HTMLButtonElement>("[data-cancel]")!;
    const submit = this.form.querySelector<HTMLButtonElement>("[type=submit]")!;
    cancel.hidden = false;
    submit.disabled = true;
    this.progress.hidden = false;
    this.progress.value = 0;
    this.say("Rendering…");

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d")!;
    const output = new Output({ format, target: new BufferTarget() });
    const video = new CanvasSource(out, {
      codec,
      // Thin trails are fine detail the default quality smears: ~0.25 bit per pixel and frame
      // (about 15 Mbit/s at 1080 × 1920, 30 fps); platforms re-encode from this master.
      bitrate: Math.round(width * height * fps * 0.25),
      keyFrameInterval: 2,
    });
    output.addVideoTrack(video, { frameRate: fps });
    let finished = false;
    const start = host.start;
    let lastStep = start;
    host.begin(width, height);
    try {
      await output.start();
      for (let i = 0; i < frames; i++) {
        if (this.cancelled) {
          break;
        }
        const m = Math.min(host.last, start + (i / fps) * stepsPerSecond);
        lastStep = m;
        const cube = await host.frame(m, {
          width,
          height,
          yaw: frames > 1 ? (orbit * i) / (frames - 1) : 0,
          frameIndex: i,
          fps,
          stepsPerSecond,
        });
        composite(
          ctx,
          cube,
          width,
          height,
          host.text(Math.floor(m)),
          host.overlay(width, height),
        );
        // Resolves when the encoder can take more: backpressure.
        await video.add(i / fps, 1 / fps);
        this.progress.value = (i + 1) / frames;
        this.say(
          `Rendering frame ${i + 1} / ${frames} · ${host.text(Math.floor(m))}`,
        );
      }
      if (this.cancelled) {
        await output.cancel();
        finished = true;
        this.say("Cancelled.");
        return;
      }
      await output.finalize();
      finished = true;
      const buffer = output.target.buffer!;
      const name = `strata-${host.contextId}-${host.key(start)}-${host.key(Math.floor(lastStep))}.mp4`;
      saveFile(name, buffer, "video/mp4");
      this.say(`Saved ${name} (${(buffer.byteLength / 1e6).toFixed(1)} MB).`);
    } catch (error) {
      this.say(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      if (!finished) {
        await output.cancel().catch(() => undefined);
      }
      host.end();
      this.running = false;
      cancel.hidden = true;
      submit.disabled = false;
      this.progress.hidden = true;
    }
  }
}
