/**
 * The three orthogonal sections of the month, drawn with Canvas2D from the
 * resampled volume: TOP (longitude × latitude at the depth cursor), EQ
 * (longitude × depth at the latitude cursor, the classic thermocline
 * section) and SIDE (latitude × depth at the longitude cursor). Each one
 * shows the other cursors, the ROI, optional isotherms, the value under the
 * pointer, and sets its two cursors on click or drag.
 */

import { contours } from "d3";
import { latLabel, lonLabel } from "../data/box";
import { levelAt, type Volume } from "../data/blocks";
import { depthWeights, interpolate, type DepthWeights } from "../data/depth";
import { rampColor } from "../palettes";
import type { Space } from "../gl/space";
import type { BoxOverlay } from "../context/types";
import { axisTicks } from "./labels";
import type { Polyline } from "./overlays";

export type SliceKind = "top" | "eq" | "side";

export interface Cursor {
  lon: number;
  lat: number;
  depth: number;
}

export interface SliceStyle {
  ramp: Uint8Array;
  domain: [number, number];
  /** Shade the anomaly and keep only the main isotherm of the temperature. */
  anomaly: boolean;
  contours: boolean;
  roi: boolean;
  coast: boolean;
}

/** Regular depth rows of the EQ and SIDE sections. */
const SECTION_STEPS = 96;
const FONT = '10px "IBM Plex Mono", ui-monospace, monospace';
const MARGIN = { left: 44, right: 10, top: 8, bottom: 22 };

/** Isotherms of the sections: every `step` from `range[0]`, `main` drawn stronger. */
export interface IsoLines {
  main: number;
  step: number;
  range: [number, number];
}

export interface SliceOptions {
  boxes: BoxOverlay[];
  iso: IsoLines;
  unit: string;
  /** Leave cells without data transparent (lakes) instead of dark land. */
  clearLand?: boolean;
}

interface Axis {
  /** Data coordinate at the plot's left/top and right/bottom edges. */
  from: number;
  to: number;
  ticks: number[];
  label: (value: number) => string;
}

export class SlicePanel {
  readonly canvas: HTMLCanvasElement;
  private image = document.createElement("canvas");
  private volume: Volume | null = null;
  private cursor: Cursor = { lon: 220, lat: 0, depth: 50 };
  private style: SliceStyle | null = null;
  private hover: [number, number] | null = null;
  private lines: Polyline[] = [];
  /** Depth weights of the sections, for the volume's levels. */
  private weights: { levels: Float64Array; table: DepthWeights } | null = null;

  constructor(
    readonly kind: SliceKind,
    private space: Space,
    private options: SliceOptions,
    private readout: HTMLElement,
    private onPick: (cursor: Partial<Cursor>) => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "slice-canvas";
    let dragging = false;
    const pick = (event: PointerEvent) => {
      const point = this.toData(event.offsetX, event.offsetY);
      if (!point) {
        return;
      }
      const [a, b] = point;
      if (kind === "top") {
        onPick({ lon: a, lat: b });
      } else if (kind === "eq") {
        onPick({ lon: a, depth: b });
      } else {
        onPick({ lat: a, depth: b });
      }
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      pick(event);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      this.hover = [event.offsetX, event.offsetY];
      if (dragging) {
        pick(event);
      }
      this.updateReadout();
    });
    this.canvas.addEventListener("pointerup", () => (dragging = false));
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.updateReadout();
    });
  }

  /** Surface lines of the TOP section (coastlines, shore). */
  setLines(lines: Polyline[]): void {
    this.lines = lines;
    this.draw();
  }

  /** Horizontal and vertical axes of this section. */
  private axes(): [Axis, Axis] {
    const { space } = this;
    // Round ticks clear of the plot's edges.
    const inner = (from: number, to: number, count: number) => {
      const { values, digits } = axisTicks(from, to, count);
      const margin = 0.05 * (to - from);
      return {
        values: values.filter((v) => v > from + margin && v < to - margin),
        digits,
      };
    };
    const lon = inner(space.west, space.east, 8);
    const lat = inner(space.south, space.north, 6);
    const depth = axisTicks(0, space.bottom, 6);
    const lonAxis: Axis = {
      from: space.west,
      to: space.east,
      ticks: lon.values,
      label: (v) => lonLabel(v, lon.digits),
    };
    const latAxis: Axis = {
      from: space.north,
      to: space.south,
      ticks: [...lat.values].reverse(),
      label: (v) => latLabel(v, lat.digits),
    };
    const latAcross: Axis = { ...latAxis, from: space.south, to: space.north };
    const depthAxis: Axis = {
      from: 0,
      to: space.bottom,
      ticks: depth.values,
      label: (v) => v.toFixed(depth.digits),
    };
    if (this.kind === "top") {
      return [lonAxis, latAxis];
    }
    return [this.kind === "eq" ? lonAxis : latAcross, depthAxis];
  }

  private plot(): { x: number; y: number; w: number; h: number } {
    const ratio = window.devicePixelRatio || 1;
    const w = this.canvas.width / ratio;
    const h = this.canvas.height / ratio;
    return {
      x: this.left(),
      y: MARGIN.top,
      w: Math.max(1, w - this.left() - MARGIN.right),
      h: Math.max(1, h - MARGIN.top - MARGIN.bottom),
    };
  }

  /** Left margin: room for the widest vertical tick label (about 6.2 px per character). */
  private left(): number {
    const [, v] = this.axes();
    const chars = Math.max(0, ...v.ticks.map((tick) => v.label(tick).length));
    return Math.max(MARGIN.left, Math.ceil(chars * 6.2 + 12));
  }

  /** Data coordinates under a CSS pixel of the canvas, or null outside the plot. */
  private toData(px: number, py: number): [number, number] | null {
    const plot = this.plot();
    const fx = (px - plot.x) / plot.w;
    const fy = (py - plot.y) / plot.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
      return null;
    }
    const [h, v] = this.axes();
    return [h.from + fx * (h.to - h.from), v.from + fy * (v.to - v.from)];
  }

  private toPixel(a: number, b: number): [number, number] {
    const plot = this.plot();
    const [h, v] = this.axes();
    return [
      plot.x + ((a - h.from) / (h.to - h.from)) * plot.w,
      plot.y + ((b - v.from) / (v.to - v.from)) * plot.h,
    ];
  }

  /** Index of the grid cell nearest a value on an evenly spaced axis of n cells. */
  private static cell(
    value: number,
    from: number,
    to: number,
    n: number,
  ): number {
    return Math.max(
      0,
      Math.min(n - 1, Math.floor(((value - from) / (to - from)) * n)),
    );
  }

  /**
   * The section as a row-major grid (first row at the top) and its size: of the
   * temperature, or of the anomaly when `field` asks for it and the volume has one.
   */
  private grid(field: "temperature" | "anomaly" = "temperature"): {
    values: Float32Array;
    width: number;
    height: number;
  } | null {
    const volume = this.volume;
    if (!volume) {
      return null;
    }
    const { cols, rows } = volume;
    const values =
      field === "anomaly" && volume.anomaly ? volume.anomaly : volume.values;
    const { space, cursor } = this;
    const plane = cols * rows;
    if (this.kind === "top") {
      // The plane at the depth cursor, between the two levels around it.
      const [upper, lower, weight] = levelAt(volume.depths, cursor.depth);
      const out = new Float32Array(plane);
      for (let r = 0; r < rows; r++) {
        // North at the top.
        const source = (rows - 1 - r) * cols;
        for (let c = 0; c < cols; c++) {
          out[r * cols + c] = interpolate(
            values[upper * plane + source + c],
            values[lower * plane + source + c],
            weight,
          );
        }
      }
      return { values: out, width: cols, height: rows };
    }
    // Sections: the levels resampled on regular depths, for this slice only.
    const steps = SECTION_STEPS;
    if (this.weights?.levels !== volume.depths) {
      this.weights = {
        levels: volume.depths,
        table: depthWeights(volume.depths, steps, space.bottom),
      };
    }
    const { upper, lower, weight } = this.weights.table;
    const across = this.kind === "eq" ? cols : rows;
    const at =
      this.kind === "eq"
        ? (() => {
            const row = SlicePanel.cell(
              cursor.lat,
              space.south,
              space.north,
              rows,
            );
            return (k: number, i: number) => values[k * plane + row * cols + i];
          })()
        : (() => {
            const col = SlicePanel.cell(
              cursor.lon,
              space.west,
              space.east,
              cols,
            );
            return (k: number, i: number) => values[k * plane + i * cols + col];
          })();
    const out = new Float32Array(across * steps);
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < across; i++) {
        out[s * across + i] = interpolate(
          at(upper[s], i),
          at(lower[s], i),
          weight[s],
        );
      }
    }
    return { values: out, width: across, height: steps };
  }

  /** The value under the pointer, as text. */
  private updateReadout(): void {
    const title = this.title();
    const point = this.hover ? this.toData(...this.hover) : null;
    const grid = point ? this.grid() : null;
    const departures =
      point && this.style?.anomaly && this.volume?.anomaly
        ? this.grid("anomaly")
        : null;
    if (!point || !grid) {
      this.readout.textContent = title;
      return;
    }
    const [h, v] = this.axes();
    const col = SlicePanel.cell(point[0], h.from, h.to, grid.width);
    // Latitude rows are cells; depth rows are samples at exact depths.
    const row =
      this.kind === "top"
        ? SlicePanel.cell(point[1], v.from, v.to, grid.height)
        : Math.max(
            0,
            Math.min(
              grid.height - 1,
              Math.round(
                ((point[1] - v.from) / (v.to - v.from)) * (grid.height - 1),
              ),
            ),
          );
    const value = grid.values[row * grid.width + col];
    const where =
      this.kind === "top"
        ? `${lonLabel(point[0], 1)} ${latLabel(point[1], 1)}`
        : this.kind === "eq"
          ? `${lonLabel(point[0], 1)} ${Math.round(point[1])} m`
          : `${latLabel(point[0], 1)} ${Math.round(point[1])} m`;
    const departure = departures?.values[row * grid.width + col];
    const unit = this.options.unit;
    const text = Number.isNaN(value)
      ? "—"
      : departure === undefined || Number.isNaN(departure)
        ? `${value.toFixed(2)} ${unit}`
        : `${departure >= 0 ? "+" : ""}${departure.toFixed(2)} ${unit} (${value.toFixed(2)} ${unit})`;
    this.readout.textContent = `${title} · ${where} · ${text}`;
  }

  title(): string {
    const { cursor } = this;
    if (this.kind === "top") {
      return `TOP (Z = ${Math.round(cursor.depth)} m)`;
    }
    if (this.kind === "eq") {
      return `SECTION (Y = ${latLabel(cursor.lat, 1)})`;
    }
    return `SIDE (X = ${lonLabel(cursor.lon, 1)})`;
  }

  update(volume: Volume | null, cursor: Cursor, style: SliceStyle): void {
    this.volume = volume;
    this.cursor = cursor;
    this.style = style;
    this.draw();
    this.updateReadout();
  }

  resize(): void {
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
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const plot = this.plot();
    const grid = this.grid();
    const style = this.style;
    const shaded = style?.anomaly ? this.grid("anomaly") : grid;
    if (grid && shaded && style) {
      this.image.width = grid.width;
      this.image.height = grid.height;
      const image = this.image.getContext("2d")!;
      const pixels = image.createImageData(grid.width, grid.height);
      const [low, high] = style.domain;
      shaded.values.forEach((value, i) => {
        // Land and sea floor follow the temperature, as in 3D.
        if (Number.isNaN(grid.values[i]) || Number.isNaN(value)) {
          if (!this.options.clearLand) {
            pixels.data.set([33, 34, 36, 255], i * 4);
          }
          return;
        }
        const [r, g, b] = rampColor(style.ramp, (value - low) / (high - low));
        pixels.data.set([r, g, b, 255], i * 4);
      });
      image.putImageData(pixels, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, plot.x, plot.y, plot.w, plot.h);
      if (style.contours) {
        this.drawContours(ctx, grid, plot, style.anomaly);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    if (this.kind === "top" && style?.coast) {
      ctx.strokeStyle = "rgba(240, 242, 245, 0.85)";
      ctx.lineWidth = 0.8;
      for (const line of this.lines) {
        ctx.beginPath();
        line.forEach(([lon, lat], i) => {
          const [x, y] = this.toPixel(lon, lat);
          if (i) {
            ctx.lineTo(x, y);
          } else {
            ctx.moveTo(x, y);
          }
        });
        ctx.stroke();
      }
    }
    if (style?.roi) {
      this.drawRoi(ctx);
    }
    this.drawCursors(ctx, plot);
    ctx.restore();
    this.drawAxes(ctx, plot);
  }

  private drawContours(
    ctx: CanvasRenderingContext2D,
    grid: { values: Float32Array; width: number; height: number },
    plot: { x: number; y: number; w: number; h: number },
    mainOnly = false,
  ): void {
    const filled = Array.from(grid.values, (value) =>
      Number.isNaN(value) ? -1e3 : value,
    );
    // Over the anomaly, only the main isotherm: the thermocline on the departures.
    const { main: isoMain, step: isoStep, range } = this.options.iso;
    const thresholds: number[] = [];
    if (mainOnly || !(isoStep > 0)) {
      thresholds.push(isoMain);
    } else {
      const first =
        isoMain - Math.floor((isoMain - range[0]) / isoStep) * isoStep;
      for (let t = first; t <= range[1] + 1e-9; t += isoStep) {
        thresholds.push(t);
      }
    }
    const sx = plot.w / grid.width;
    const sy = plot.h / grid.height;
    for (const contour of contours()
      .size([grid.width, grid.height])
      .thresholds(thresholds)(filled)) {
      const main = Math.abs(contour.value - isoMain) < 1e-9;
      ctx.strokeStyle = main
        ? "rgba(255, 255, 255, 0.95)"
        : "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = main ? 1.4 : 0.6;
      ctx.beginPath();
      for (const polygon of contour.coordinates) {
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => {
            const px = plot.x + x * sx;
            const py = plot.y + y * sy;
            if (i) {
              ctx.lineTo(px, py);
            } else {
              ctx.moveTo(px, py);
            }
          });
        }
      }
      ctx.stroke();
    }
  }

  private drawRoi(ctx: CanvasRenderingContext2D): void {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 1;
    for (const box of this.options.boxes) {
      const [top, bottom] = box.depth ?? [0, this.space.bottom];
      const corners: Array<[number, number]> =
        this.kind === "top"
          ? [
              [box.west, box.north],
              [box.east, box.south],
            ]
          : this.kind === "eq"
            ? [
                [box.west, top],
                [box.east, bottom],
              ]
            : [
                [box.south, top],
                [box.north, bottom],
              ];
      const [a, b] = corners.map(([u, v]) => this.toPixel(u, v));
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    ctx.setLineDash([]);
  }

  private drawCursors(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    const { cursor } = this;
    const [u, v] =
      this.kind === "top"
        ? [cursor.lon, cursor.lat]
        : this.kind === "eq"
          ? [cursor.lon, cursor.depth]
          : [cursor.lat, cursor.depth];
    const [x, y] = this.toPixel(u, v);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }

  private drawAxes(
    ctx: CanvasRenderingContext2D,
    plot: { x: number; y: number; w: number; h: number },
  ): void {
    const [h, v] = this.axes();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillStyle = "rgba(235, 237, 240, 0.85)";
    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Every tick, or every second one when labels would touch.
    const spacing =
      h.ticks.length > 1
        ? Math.abs(
            this.toPixel(h.ticks[1], 0)[0] - this.toPixel(h.ticks[0], 0)[0],
          )
        : Infinity;
    const label = ctx.measureText(h.label(h.ticks[0])).width + 10;
    const every = spacing < label ? Math.ceil(label / spacing) : 1;
    for (const [i, tick] of h.ticks.entries()) {
      const [x] = this.toPixel(tick, v.from);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1 || i % every) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(x, plot.y + plot.h);
      ctx.lineTo(x, plot.y + plot.h + 4);
      ctx.stroke();
      ctx.fillText(h.label(tick), x, plot.y + plot.h + 6);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tick of v.ticks) {
      const [, y] = this.toPixel(h.from, tick);
      if (y < plot.y - 1 || y > plot.y + plot.h + 1) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(plot.x - 4, y);
      ctx.lineTo(plot.x, y);
      ctx.stroke();
      ctx.fillText(v.label(tick), plot.x - 6, y);
    }
  }
}
