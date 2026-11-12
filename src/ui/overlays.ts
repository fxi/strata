/**
 * Context overlays as plain geometry in the cube's longitude convention:
 * polylines on the surface (Natural Earth coastlines, the outline of the
 * data's surface cells, GeoJSON lines and polygons), reference boxes and
 * points of interest (GeoJSON points included).
 */

import { contours } from "d3";
import { mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land from "world-atlas/land-50m.json";
import { boxLongitude } from "../data/box";
import type {
  BoxOverlay,
  GeoJsonOverlay,
  Overlay,
  PoiOverlay,
} from "../context/types";

export type Polyline = Array<[number, number]>;

export interface Extent {
  west: number;
  east: number;
  south: number;
  north: number;
  lonWrap?: boolean;
}

export interface Poi {
  label: string;
  lon: number;
  lat: number;
  drop?: number;
  marker: boolean;
  onTop: boolean;
}

/** Cuts lines where they leave the extent or jump across the meridian where unwrapping restarts. */
function clip(
  lines: Array<Array<[number, number]>>,
  extent: Extent,
): Polyline[] {
  const inside = ([lon, lat]: [number, number]) =>
    lon >= extent.west &&
    lon <= extent.east &&
    lat >= extent.south &&
    lat <= extent.north;
  const result: Polyline[] = [];
  for (const line of lines) {
    let current: Polyline = [];
    let previous: [number, number] | null = null;
    for (const [lon, lat] of line) {
      const point: [number, number] = [boxLongitude(extent, lon), lat];
      const jump = previous !== null && Math.abs(point[0] - previous[0]) > 180;
      if (!inside(point) || jump) {
        if (current.length > 1) {
          result.push(current);
        }
        current = inside(point) ? [point] : [];
      } else {
        current.push(point);
      }
      previous = point;
    }
    if (current.length > 1) {
      result.push(current);
    }
  }
  return result;
}

/** Natural Earth 1:50m coastlines (world-atlas) inside the extent. */
export function coastlines(extent: Extent): Polyline[] {
  const topology = land as unknown as Topology<{ land: GeometryCollection }>;
  const lines = mesh(topology, topology.objects.land).coordinates as Array<
    Array<[number, number]>
  >;
  return clip(lines, extent);
}

/**
 * Outline of the valid cells of a plane (rows south to north, `cols` west to
 * east), as polylines at the cells' edges: a lake shore at the grid's resolution.
 */
export function maskOutline(
  plane: ArrayLike<number>,
  rows: number,
  cols: number,
  extent: { west: number; east: number; south: number; north: number },
): Polyline[] {
  // One empty cell all around, so the outline closes along the box edges too.
  const width = cols + 2;
  const height = rows + 2;
  const grid = new Array<number>(width * height).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      grid[(r + 1) * width + c + 1] = Number.isNaN(plane[r * cols + c]) ? 0 : 1;
    }
  }
  const [shape] = contours()
    .size([width, height])
    .smooth(false)
    .thresholds([0.5])(grid);
  const lon = (x: number) =>
    extent.west + ((x - 1) / cols) * (extent.east - extent.west);
  const lat = (y: number) =>
    extent.south + ((y - 1) / rows) * (extent.north - extent.south);
  const lines: Polyline[] = [];
  for (const polygon of shape?.coordinates ?? []) {
    for (const ring of polygon) {
      lines.push(ring.map(([x, y]) => [lon(x), lat(y)]));
    }
  }
  return lines;
}

/** Lines, polygon rings and points of a GeoJSON object. */
export function geojsonParts(data: GeoJSON.GeoJSON): {
  lines: Array<Array<[number, number]>>;
  points: Array<{ lon: number; lat: number; label: string }>;
} {
  const lines: Array<Array<[number, number]>> = [];
  const points: Array<{ lon: number; lat: number; label: string }> = [];
  const visit = (geometry: GeoJSON.Geometry | null, label: string) => {
    if (!geometry) {
      return;
    }
    const pair = (p: GeoJSON.Position): [number, number] => [p[0], p[1]];
    switch (geometry.type) {
      case "Point":
        points.push({
          lon: geometry.coordinates[0],
          lat: geometry.coordinates[1],
          label,
        });
        break;
      case "MultiPoint":
        for (const p of geometry.coordinates) {
          points.push({ lon: p[0], lat: p[1], label });
        }
        break;
      case "LineString":
        lines.push(geometry.coordinates.map(pair));
        break;
      case "MultiLineString":
      case "Polygon":
        for (const line of geometry.coordinates) {
          lines.push(line.map(pair));
        }
        break;
      case "MultiPolygon":
        for (const polygon of geometry.coordinates) {
          for (const ring of polygon) {
            lines.push(ring.map(pair));
          }
        }
        break;
      case "GeometryCollection":
        for (const part of geometry.geometries) {
          visit(part, label);
        }
        break;
    }
  };
  const labelOf = (properties: GeoJSON.GeoJsonProperties) =>
    String(properties?.label ?? properties?.name ?? properties?.title ?? "");
  if (data.type === "FeatureCollection") {
    for (const feature of data.features) {
      visit(feature.geometry, labelOf(feature.properties));
    }
  } else if (data.type === "Feature") {
    visit(data.geometry, labelOf(data.properties));
  } else {
    visit(data, "");
  }
  return { lines, points };
}

/** Everything a context's overlays draw, resolved (GeoJSON fetched). */
export interface ResolvedOverlays {
  /** Surface lines that are known before data: coastlines and GeoJSON. */
  lines: Polyline[];
  /** Whether the outline of the data's surface cells is drawn with the lines. */
  maskOutline: boolean;
  boxes: BoxOverlay[];
  pois: Poi[];
  /** Label of the lines toggle, of the boxes toggle; null when there are none. */
  linesLabel: string | null;
  boxesLabel: string | null;
}

export async function resolveOverlays(
  overlays: Overlay[],
  extent: Extent,
  localize: (text: GeoJsonOverlay["label"]) => string,
  baseUrl: string,
): Promise<ResolvedOverlays> {
  const lines: Polyline[] = [];
  const boxes: BoxOverlay[] = [];
  const pois: Poi[] = [];
  const lineLabels: string[] = [];
  let outline = false;
  const poi = (o: PoiOverlay): Poi => ({
    label: localize(o.label),
    lon: boxLongitude(extent, o.lon),
    lat: o.lat,
    drop: o.drop,
    marker: o.marker ?? true,
    onTop: o.onTop ?? false,
  });
  for (const overlay of overlays) {
    switch (overlay.type) {
      case "coastline":
        lines.push(...coastlines(extent));
        lineLabels.push(localize(overlay.label) || "COASTLINES");
        break;
      case "mask-outline":
        outline = true;
        lineLabels.push(localize(overlay.label) || "OUTLINE");
        break;
      case "box":
        boxes.push({
          ...overlay,
          west: boxLongitude(extent, overlay.west),
          east: boxLongitude(extent, overlay.east),
        });
        break;
      case "poi":
        pois.push(poi(overlay));
        break;
      case "geojson": {
        const data =
          overlay.data ??
          ((await fetch(new URL(overlay.url!, baseUrl)).then((response) => {
            if (!response.ok) {
              throw new Error(
                `GeoJSON ${overlay.url}: HTTP ${response.status}`,
              );
            }
            return response.json();
          })) as GeoJSON.GeoJSON);
        const parts = geojsonParts(data);
        lines.push(...clip(parts.lines, extent));
        for (const point of parts.points) {
          pois.push(
            poi({
              type: "poi",
              label: point.label,
              lon: point.lon,
              lat: point.lat,
            }),
          );
        }
        if (parts.lines.length) {
          lineLabels.push(localize(overlay.label) || overlay.id.toUpperCase());
        }
        break;
      }
    }
  }
  const boxLabels = boxes.map((b) => `${localize(b.label) || b.id} box`);
  return {
    lines,
    maskOutline: outline,
    boxes,
    pois,
    linesLabel: lineLabels.length ? lineLabels.join(" · ").toUpperCase() : null,
    boxesLabel: boxes.length ? boxLabels.join(" · ").toUpperCase() : null,
  };
}
