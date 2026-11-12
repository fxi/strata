/**
 * Axis ticks, axis titles, region names, reference boxes and points of
 * interest of the 3D view, as DOM text at projected anchors (crisp at any
 * pixel ratio). Ticks follow the bottom edges that face the viewer; a group
 * whose edge collapses on screen is hidden.
 */

import { ticks as niceTicks, tickStep } from "d3";
import { latLabel, lonLabel } from "../data/box";
import { project, type Frame, type Vec3 } from "../gl/camera";
import { CubeRenderer, LineBatch } from "../gl/renderer";
import { toWorld, type Space } from "../gl/space";
import type { BoxOverlay } from "../context/types";
import type { Poi } from "./overlays";

type Align = "left" | "right" | "below" | "above" | "center" | "under";

const SHIFT: Record<Align, string> = {
  left: "translate(calc(-100% - 6px), -50%)",
  right: "translate(6px, -50%)",
  below: "translate(-50%, 6px)",
  above: "translate(-50%, calc(-100% - 4px))",
  center: "translate(-50%, -50%)",
  // Axis title, clear of the tick labels.
  under: "translate(-50%, 24px)",
};

interface Label {
  node: HTMLElement;
  group: string;
  at: () => Vec3;
  align: () => Align;
}

const TICK = 0.025;

/** Round ticks over [from, to] and the decimals their labels need. */
export function axisTicks(
  from: number,
  to: number,
  count: number,
): { values: number[]; digits: number } {
  const step = Math.abs(tickStep(from, to, count));
  return {
    values: niceTicks(from, to, count),
    digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)),
  };
}

export interface LabelOverlays {
  boxes: BoxOverlay[];
  boxLabel: (box: BoxOverlay) => string;
  pois: Poi[];
}

export class Labels {
  readonly element: HTMLElement;
  private labels: Label[] = [];
  /** Which bottom edges carry the ticks: the south (or north) and east (or west) ones. */
  private side = { y: -1, x: 1 };
  private lonTicks: number[];
  private latTicks: number[];
  private depthTicks: number[];

  constructor(
    private space: Space,
    overlays: LabelOverlays = { boxes: [], boxLabel: () => "", pois: [] },
  ) {
    this.element = document.createElement("div");
    this.element.className = "cube-labels";
    this.element.setAttribute("aria-hidden", "true");
    const [, hy, hz] = space.half;
    const lonAxis = axisTicks(space.west, space.east, 8);
    const latAxis = axisTicks(space.south, space.north, 6);
    const depthAxis = axisTicks(0, space.bottom, 6);
    this.lonTicks = lonAxis.values;
    this.latTicks = latAxis.values;
    this.depthTicks = depthAxis.values;
    // Every second tick is "minor": hidden when its edge is short on screen.
    for (const [i, lon] of this.lonTicks.entries()) {
      this.add(
        lonLabel(lon, lonAxis.digits),
        i % 2 ? "lon-minor" : "lon",
        "tick",
        () => {
          const p = toWorld(space, lon, 0, space.bottom);
          return [p[0], this.side.y * (hy + TICK * 2), -hz];
        },
        () => "below",
      );
    }
    for (const [i, lat] of this.latTicks.entries()) {
      this.add(
        latLabel(lat, latAxis.digits),
        i % 2 ? "lat-minor" : "lat",
        "tick",
        () => {
          const p = toWorld(space, space.west, lat, space.bottom);
          return [this.side.x * (space.half[0] + TICK * 2), p[1], -hz];
        },
        () => (this.side.x > 0 ? "right" : "left"),
      );
    }
    for (const depth of this.depthTicks) {
      this.add(
        depth.toFixed(depthAxis.digits),
        "depth",
        "tick",
        () => {
          const p = toWorld(space, space.west, 0, depth);
          return [
            -this.side.x * (space.half[0] + TICK * 2),
            this.side.y * hy,
            p[2],
          ];
        },
        () => (this.side.x > 0 ? "left" : "right"),
      );
    }
    this.add(
      "LONGITUDE",
      "lon",
      "axis",
      () => [0, this.side.y * (hy + TICK * 2), -hz],
      () => "under",
    );
    // Latitude ticks carry N / S: no title, which would leave the frame on narrow views.
    this.add(
      "DEPTH (m)",
      "depth",
      "axis",
      () => [-this.side.x * space.half[0], this.side.y * hy, hz + 0.08],
      () => "above",
    );
    for (const poi of overlays.pois) {
      this.add(
        poi.label,
        poi.onTop ? "top" : "pois",
        poi.marker ? "poi" : "feature",
        () => toWorld(space, poi.lon, poi.lat, 0),
        () => (poi.marker ? "above" : "center"),
      );
    }
    for (const box of overlays.boxes) {
      this.add(
        overlays.boxLabel(box),
        "roi",
        "feature",
        () =>
          toWorld(
            space,
            (box.west + box.east) / 2,
            box.north,
            box.depth?.[0] ?? 0,
          ),
        () => "above",
      );
    }
  }

  private add(
    text: string,
    group: string,
    kind: string,
    at: () => Vec3,
    align: () => Align,
  ): void {
    const node = document.createElement("span");
    node.className = `cube-label is-${kind}`;
    node.textContent = text;
    this.element.append(node);
    this.labels.push({ node, group, at, align });
  }

  /** Tick marks along the edges that carry the labels. */
  ticks(): LineBatch {
    const { space } = this;
    const [hx, hy, hz] = space.half;
    const batch = new LineBatch();
    for (const lon of this.lonTicks) {
      const [x] = toWorld(space, lon, 0, 0);
      batch.segment(
        [x, this.side.y * hy, -hz],
        [x, this.side.y * (hy + TICK), -hz],
      );
    }
    for (const lat of this.latTicks) {
      const [, y] = toWorld(space, space.west, lat, 0);
      batch.segment(
        [this.side.x * hx, y, -hz],
        [this.side.x * (hx + TICK), y, -hz],
      );
    }
    for (const depth of this.depthTicks) {
      const [, , z] = toWorld(space, space.west, 0, depth);
      batch.segment(
        [-this.side.x * hx, this.side.y * hy, z],
        [-this.side.x * (hx + TICK), this.side.y * hy, z],
      );
    }
    return batch;
  }

  /** Moves the labels; returns true when the tick edges changed (ticks to rebuild). */
  update(
    frame: Frame,
    width: number,
    height: number,
    show: { roi: boolean; pois?: boolean; box?: boolean },
  ): boolean {
    const side = {
      y: CubeRenderer.faces([0, -1, 0], frame.ray) ? -1 : 1,
      x: CubeRenderer.faces([1, 0, 0], frame.ray) ? 1 : -1,
    };
    const changed = side.x !== this.side.x || side.y !== this.side.y;
    this.side = side;
    const [hx, hy, hz] = this.space.half;
    // Screen length of each group's edge: a collapsed edge hides its labels.
    const length = (a: Vec3, b: Vec3) => {
      const [ax, ay] = project(frame, a, width, height);
      const [bx, by] = project(frame, b, width, height);
      return Math.hypot(bx - ax, by - ay);
    };
    const lonEdge = length([-hx, side.y * hy, -hz], [hx, side.y * hy, -hz]);
    const latEdge = length([side.x * hx, -hy, -hz], [side.x * hx, hy, -hz]);
    const visible: Record<string, boolean> = {
      lon: lonEdge > 120,
      "lon-minor": lonEdge > 560,
      lat: latEdge > 70,
      "lat-minor": latEdge > 150,
      depth:
        length(
          [-side.x * hx, side.y * hy, -hz],
          [-side.x * hx, side.y * hy, hz],
        ) > 70,
      top:
        CubeRenderer.faces([0, 0, 1], frame.ray) &&
        length([-hx, -hy, hz], [-hx, hy, hz]) > 60,
      roi: show.roi,
      pois: show.pois ?? true,
    };
    // Without the frame, no ticks or axis titles either.
    if (show.box === false) {
      for (const group of ["lon", "lon-minor", "lat", "lat-minor", "depth"]) {
        visible[group] = false;
      }
    }
    for (const label of this.labels) {
      if (!visible[label.group]) {
        label.node.style.opacity = "0";
        continue;
      }
      const [x, y] = project(frame, label.at(), width, height);
      label.node.style.opacity = "1";
      label.node.style.transform = `translate(${x}px, ${y}px) ${SHIFT[label.align()]}`;
    }
    return changed;
  }
}
