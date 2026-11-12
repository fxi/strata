/**
 * Timeline of the store's time steps: years, an optional box index (the
 * Niño 3.4 anomaly) as bars (warm red, cold blue) over shaded El Niño /
 * La Niña episodes, a strip of the data groups (five-year blocks, months:
 * in memory, on disk, loading, not loaded) and the playhead. Drag to scrub.
 */

import type { Episode } from "../data/nino";
import { rampColor } from "../palettes";

/** A series drawn as a line (min/max per pixel column), colored by the palette. */
export interface TimelineSeries {
  values: Float32Array;
  ramp: Uint8Array;
  domain: [number, number];
}

const FONT = '10px "IBM Plex Mono", ui-monospace, monospace';
const RANGE = 2.5;
const WARM = "rgba(255, 92, 72, 0.9)";
const COLD = "rgba(72, 150, 255, 0.9)";

/** In memory, being read, on disk only (cache), or to download. */
export type BlockStatus = "loaded" | "loading" | "cached" | "missing";

/** A run of time steps shown as one cell of the data strip. */
export interface TimeGroup {
  start: number;
  end: number;
}

export class Timeline {
  readonly canvas: HTMLCanvasElement;
  private month = 0;
  private status: BlockStatus[] = [];
  private series: TimelineSeries | null = null;
  /** Min and max of the series per pixel column, for the current width. */
  private envelope: {
    width: number;
    low: Float32Array;
    high: Float32Array;
  } | null = null;

  constructor(
    private times: number[],
    private index: Float64Array | null,
    private episodes: Episode[],
    private groups: TimeGroup[],
    private onScrub: (month: number) => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "timeline-canvas";
    let dragging = false;
    const scrub = (event: PointerEvent) => {
      const month = this.monthAt(event.offsetX);
      if (month !== null) {
        onScrub(month);
      }
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      scrub(event);
    });
    this.canvas.addEventListener(
      "pointermove",
      (event) => dragging && scrub(event),
    );
    this.canvas.addEventListener("pointerup", () => (dragging = false));
  }

  private area() {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    return { x: 12, w: width - 24, height };
  }

  private x(month: number): number {
    const { x, w } = this.area();
    return x + (month / Math.max(1, this.times.length - 1)) * w;
  }

  private monthAt(px: number): number | null {
    const { x, w } = this.area();
    const f = (px - x) / w;
    return Math.round(Math.min(1, Math.max(0, f)) * (this.times.length - 1));
  }

  setMonth(month: number): void {
    this.month = month;
    this.draw();
  }

  /** Shows a series instead of the index bars (null: none). */
  setSeries(series: TimelineSeries | null): void {
    this.series = series;
    this.envelope = null;
    this.draw();
  }

  private columns(w: number): { low: Float32Array; high: Float32Array } {
    const columns = Math.max(1, Math.round(w));
    if (this.envelope?.width === columns) {
      return this.envelope;
    }
    const low = new Float32Array(columns).fill(NaN);
    const high = new Float32Array(columns).fill(NaN);
    const values = this.series!.values;
    const last = Math.max(1, values.length - 1);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value !== value) {
        continue;
      }
      const c = Math.min(columns - 1, Math.floor((i / last) * columns));
      if (!(low[c] <= value)) {
        low[c] = value;
      }
      if (!(high[c] >= value)) {
        high[c] = value;
      }
    }
    this.envelope = { width: columns, low, high };
    return this.envelope;
  }

  private drawSeries(
    ctx: CanvasRenderingContext2D,
    x: number,
    w: number,
    top: number,
    bottom: number,
  ): void {
    const series = this.series!;
    const { low, high } = this.columns(w);
    let min = Infinity;
    let max = -Infinity;
    for (let c = 0; c < low.length; c++) {
      if (low[c] === low[c]) {
        min = Math.min(min, low[c]);
        max = Math.max(max, high[c]);
      }
    }
    if (!(min <= max)) {
      return;
    }
    const pad = Math.max(0.5, (max - min) * 0.08);
    const from = min - pad;
    const to = max + pad;
    const y = (value: number) =>
      bottom - ((value - from) / (to - from)) * (bottom - top);
    const [d0, d1] = series.domain;
    const step = w / low.length;
    for (let c = 0; c < low.length; c++) {
      if (low[c] !== low[c]) {
        continue;
      }
      const [r, g, b] = rampColor(
        series.ramp,
        ((low[c] + high[c]) / 2 - d0) / (d1 - d0),
      );
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      const top = y(high[c]);
      ctx.fillRect(
        x + c * step,
        top,
        Math.max(1, step),
        Math.max(1.2, y(low[c]) - top),
      );
    }
    // Range of the series, at the left edge.
    ctx.fillStyle = "rgba(235, 237, 240, 0.7)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(max.toFixed(1), x + 2, top);
    ctx.textBaseline = "bottom";
    ctx.fillText(min.toFixed(1), x + 2, bottom);
  }

  setStatus(status: BlockStatus[]): void {
    this.status = status;
    this.draw();
  }

  resize(): void {
    this.envelope = null;
    const ratio = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.draw();
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const { x, w, height } = this.area();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = FONT;
    const top = 16;
    const strip = height - 8;
    const mid = top + (strip - 10 - top) / 2;
    const half = (strip - 10 - top) / 2;
    const step = w / Math.max(1, this.times.length - 1);

    // Episodes.
    for (const episode of this.episodes) {
      ctx.fillStyle =
        episode.phase === "el-nino"
          ? "rgba(255, 92, 72, 0.13)"
          : "rgba(72, 150, 255, 0.13)";
      ctx.fillRect(
        this.x(episode.start) - step / 2,
        top,
        this.x(episode.end) - this.x(episode.start) + step,
        strip - 10 - top,
      );
    }

    // Years: at the first step of each, labelled every five (every one over short spans).
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fillStyle = "rgba(235, 237, 240, 0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const span =
      new Date(this.times[this.times.length - 1] ?? 0).getUTCFullYear() -
      new Date(this.times[0] ?? 0).getUTCFullYear();
    const every = span <= 15 ? 1 : 5;
    let previousYear = NaN;
    this.times.forEach((ms, i) => {
      const date = new Date(ms);
      const year = date.getUTCFullYear();
      const first = year !== previousYear;
      previousYear = year;
      if (!first || (i === 0 && date.getUTCMonth() !== 0)) {
        return;
      }
      const px = this.x(i);
      const major = year % every === 0;
      ctx.beginPath();
      ctx.moveTo(px, top - (major ? 4 : 2));
      ctx.lineTo(px, top);
      ctx.stroke();
      if (major && (w > 500 || year % (2 * every) === 0)) {
        ctx.fillText(String(year), px, 2);
      }
    });

    if (this.series) {
      this.drawSeries(ctx, x, w, top + 2, strip - 12);
    }

    // Anomaly bars and zero line.
    if (this.index) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.beginPath();
      ctx.moveTo(x, mid);
      ctx.lineTo(x + w, mid);
      ctx.stroke();
    }
    const bar = Math.max(1, step * 0.8);
    this.index?.forEach((value, i) => {
      if (Number.isNaN(value)) {
        return;
      }
      const v = Math.max(-RANGE, Math.min(RANGE, value));
      ctx.fillStyle = v >= 0 ? WARM : COLD;
      const h = (v / RANGE) * half;
      ctx.fillRect(
        this.x(i) - bar / 2,
        v >= 0 ? mid - h : mid,
        bar,
        Math.abs(h),
      );
    });

    // Data groups.
    this.status.forEach((status, b) => {
      const group = this.groups[b];
      if (!group) {
        return;
      }
      const start = this.x(group.start) - step / 2;
      const end = this.x(Math.min(this.times.length - 1, group.end)) + step / 2;
      ctx.fillStyle =
        status === "loaded"
          ? "rgba(255, 255, 255, 0.7)"
          : status === "loading"
            ? "rgba(255, 255, 255, 0.3)"
            : status === "cached"
              ? "rgba(255, 255, 255, 0.45)"
              : "rgba(255, 255, 255, 0.08)";
      ctx.fillRect(start + 1, strip - 4, end - start - 2, 3);
    });

    // Playhead.
    const px = this.x(this.month);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, top - 2);
    ctx.lineTo(px, strip);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(px - 3, top - 6, 6, 6);
  }
}
