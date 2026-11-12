/**
 * Where the cube sits in world units. x spans the longitudes, y the latitudes
 * (stretched ×latStretch, or a tropical band would be a sliver) and z the
 * depth, from the surface at +HALF.z down. The texture covers the cells' outer edges.
 */

import type { Box } from "../data/box";
import type { Vec3 } from "./camera";

/** Default depth steps of the regular grid. */
export const STEPS = 64;

export interface Space {
  half: Vec3;
  /** Cell edges of the cube, degrees and metres. */
  west: number;
  east: number;
  south: number;
  north: number;
  bottom: number;
  /** Latitude stretch against longitude, shown in the HUD. */
  latStretch: number;
  /** Depth exaggeration against longitude, rounded for the HUD. */
  exaggeration: number;
  /** Cell size, degrees. */
  lonStep: number;
  latStep: number;
}

const EARTH_KM_PER_DEGREE = 111.32;

/** Two significant digits above 1000 rounded to the thousand, as in the HUD. */
function roundExaggeration(value: number): number {
  if (value >= 1000) {
    return Math.round(value / 1000) * 1000;
  }
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
  return Math.round(value / magnitude) * magnitude;
}

export function createSpace(
  box: Box,
  options: { latStretch: number; bottom: number },
): Space {
  const { latStretch, bottom } = options;
  const lon = box.lon.value;
  const lat = box.lat.value;
  const lonStep = (lon[lon.length - 1] - lon[0]) / (lon.length - 1);
  const latStep = (lat[lat.length - 1] - lat[0]) / (lat.length - 1);
  const west = lon[0] - lonStep / 2;
  const east = lon[lon.length - 1] + lonStep / 2;
  const south = lat[0] - latStep / 2;
  const north = lat[lat.length - 1] + latStep / 2;
  const halfX = 1;
  const halfY = (halfX * (north - south) * latStretch) / (east - west);
  const halfZ = 0.42;
  const cosLat = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const kmPerUnitX =
    ((east - west) * EARTH_KM_PER_DEGREE * cosLat) / (2 * halfX);
  const kmPerUnitZ = bottom / 1000 / (2 * halfZ);
  const exaggeration = roundExaggeration(kmPerUnitX / kmPerUnitZ);
  return {
    half: [halfX, halfY, halfZ],
    west,
    east,
    south,
    north,
    bottom,
    latStretch,
    exaggeration,
    lonStep,
    latStep,
  };
}

/** World point of (longitude in the box's convention, latitude, depth in metres). */
export function toWorld(
  space: Space,
  lon: number,
  lat: number,
  depth: number,
): Vec3 {
  const [hx, hy, hz] = space.half;
  return [
    -hx + ((lon - space.west) / (space.east - space.west)) * 2 * hx,
    -hy + ((lat - space.south) / (space.north - space.south)) * 2 * hy,
    hz - (depth / space.bottom) * 2 * hz,
  ];
}

/** (longitude, latitude, depth) of a world point. */
export function fromWorld(space: Space, p: readonly number[]): Vec3 {
  const [hx, hy, hz] = space.half;
  return [
    space.west + ((p[0] + hx) / (2 * hx)) * (space.east - space.west),
    space.south + ((p[1] + hy) / (2 * hy)) * (space.north - space.south),
    ((hz - p[2]) / (2 * hz)) * space.bottom,
  ];
}
