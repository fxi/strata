/**
 * The scalar at one point (the cursor) for every time step, from the
 * point-series store (geoChunked.zarr: chunks of many steps × 1 level × a
 * tile of cells). Each chunk gives the point's values over its steps; chunks
 * are read nearest to the playhead first, a few at a time, and the series
 * fills in as they arrive. A new point cancels the reads still queued.
 */

export interface SeriesStore {
  /** Store coordinates: latitude and longitude of cells, depth of levels. */
  latitude: ArrayLike<number>;
  longitude: ArrayLike<number>;
  depth: ArrayLike<number>;
  /** Chunk shape: [time, level, latitude, longitude]. */
  chunk: [number, number, number, number];
  steps: number;
  /** Reads `count` values of a chunk from `offset` every `stride`. */
  pick: (
    indices: number[],
    pick: { offset: number; stride: number; count: number },
  ) => Promise<Float32Array>;
}

/** Index of the nearest coordinate. */
export function nearest(values: ArrayLike<number>, value: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - value) < Math.abs(values[best] - value)) {
      best = i;
    }
  }
  return best;
}

export interface SeriesPoint {
  /** Store indices of the cell and level. */
  lat: number;
  lon: number;
  level: number;
  /** Their coordinates. */
  latitude: number;
  longitude: number;
  depth: number;
}

/** The store cell and level nearest a cursor. */
export function seriesPoint(
  store: Pick<SeriesStore, "latitude" | "longitude" | "depth">,
  lon: number,
  lat: number,
  depth: number,
): SeriesPoint {
  const iLat = nearest(store.latitude, lat);
  const iLon = nearest(store.longitude, lon);
  const level = nearest(store.depth, depth);
  return {
    lat: iLat,
    lon: iLon,
    level,
    latitude: store.latitude[iLat],
    longitude: store.longitude[iLon],
    depth: store.depth[level],
  };
}

/** Time chunks ordered by distance from the one holding `step`. */
export function chunkOrder(blocks: number, from: number): number[] {
  const order = [from];
  for (let d = 1; order.length < blocks; d++) {
    if (from + d < blocks) {
      order.push(from + d);
    }
    if (from - d >= 0) {
      order.push(from - d);
    }
  }
  return order.filter((b) => b >= 0 && b < blocks);
}

export class CursorSeries {
  values: Float32Array;
  point: SeriesPoint | null = null;
  private generation = 0;

  constructor(
    private store: SeriesStore,
    private onUpdate: (series: CursorSeries) => void,
    private concurrency = 4,
  ) {
    this.values = new Float32Array(store.steps).fill(NaN);
  }

  /** Reads the series at a point, starting near `step`; a new call cancels the previous one. */
  async load(point: SeriesPoint, step: number): Promise<void> {
    const same =
      this.point &&
      this.point.lat === point.lat &&
      this.point.lon === point.lon &&
      this.point.level === point.level;
    // The same cell and level: the running load goes on.
    if (same) {
      return;
    }
    const generation = ++this.generation;
    this.point = point;
    this.values = new Float32Array(this.store.steps).fill(NaN);
    this.onUpdate(this);
    const [timeChunk, , tileLat, tileLon] = this.store.chunk;
    const blocks = Math.ceil(this.store.steps / timeChunk);
    const order = chunkOrder(blocks, Math.floor(step / timeChunk));
    const y = point.lat % tileLat;
    const x = point.lon % tileLon;
    const indices = (b: number) => [
      b,
      point.level,
      Math.floor(point.lat / tileLat),
      Math.floor(point.lon / tileLon),
    ];
    let next = 0;
    let redraw = 0;
    const worker = async () => {
      while (next < order.length && generation === this.generation) {
        const b = order[next++];
        const count = Math.min(timeChunk, this.store.steps - b * timeChunk);
        try {
          const column = await this.store.pick(indices(b), {
            offset: y * tileLon + x,
            stride: tileLat * tileLon,
            count,
          });
          if (generation !== this.generation) {
            return;
          }
          this.values.set(column, b * timeChunk);
        } catch (error) {
          console.warn("cursor series", error);
        }
        // Redraw at most every 150 ms while filling.
        const now = performance.now();
        if (now - redraw > 150) {
          redraw = now;
          this.onUpdate(this);
        }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
    if (generation === this.generation) {
      this.onUpdate(this);
    }
  }
}
