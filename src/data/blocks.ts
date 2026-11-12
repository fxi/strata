/**
 * Five-year blocks of the cube, read from the point-series store
 * (geoChunked.zarr, chunks of 60 months × 1 level × 60 × 60 cells). A block is
 * one time chunk of every tile and level the box needs for one variable, kept
 * as int16 codes at the store's own precision (about 44 MB), so three blocks
 * stay well under 200 MB.
 */

import type { ZarrSource } from "@fxi/zartigl/engine";
import type { Box } from "./box";
import { interpolate } from "./depth";

/** A store variable the cube reads, with its int16 precision. */
export interface CubeVariable {
  name: string;
  /** Degrees per int16 code: the store's own scale factor. */
  scale: number;
}

/** Absolute potential temperature. */
export const POTTMP: CubeVariable = { name: "pottmp", scale: 0.002 };
/** Departure from the 1991–2020 monthly climatology. */
export const POTTMP_ANOM: CubeVariable = { name: "pottmp_anom", scale: 0.001 };
/** Code of a missing cell (land, below the sea floor). */
export const MISSING = -32768;

export interface Block {
  index: number;
  /** First month of the block, as an index on the store's time axis. */
  start: number;
  months: number;
  /** Degrees per code. */
  scale: number;
  /** Codes in [month][level][lat][lon] order (empty for a step of a field store). */
  codes: Int16Array;
  /** A step of a field store: decoded values in [level][lat][lon] order, NaN where missing. */
  floats?: Float32Array;
}

export interface BlockProgress {
  index: number;
  done: number;
  total: number;
}

/** What a block loader needs from ZarrSource. */
export type ChunkReader = Pick<ZarrSource, "fetchChunkResult">;

/** Runs `tasks` with at most `limit` in flight. */
async function pooled<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

/** Offset of a cell in a block's codes. */
function cellOffset(
  box: Box,
): (m: number, k: number, r: number, c: number) => number {
  const rows = box.lat.index.length;
  const cols = box.lon.index.length;
  const levels = box.depth.length;
  return (m, k, r, c) => ((m * levels + k) * rows + r) * cols + c;
}

/**
 * Reads a block of `variable`: every (level, tile) chunk of time chunk `index`,
 * copied into the box. `timeChunk` and the tile size come from the store's chunk shape.
 */
export async function loadBlock(
  reader: ChunkReader,
  variable: CubeVariable,
  box: Box,
  index: number,
  timeChunk: number,
  totalMonths: number,
  tileSize: { latitude: number; longitude: number },
  onProgress?: (progress: BlockProgress) => void,
  concurrency = 8,
): Promise<Block> {
  const start = index * timeChunk;
  const months = Math.min(timeChunk, totalMonths - start);
  const rows = box.lat.index.length;
  const cols = box.lon.index.length;
  const levels = box.depth.length;
  const codes = new Int16Array(months * levels * rows * cols).fill(MISSING);
  const at = cellOffset(box);
  const tasks: Array<() => Promise<void>> = [];
  let done = 0;
  const total = levels * box.tiles.length;
  for (let k = 0; k < levels; k++) {
    for (const [tileLat, tileLon] of box.tiles) {
      tasks.push(async () => {
        const result = await reader.fetchChunkResult(variable.name, [
          index,
          k,
          tileLat,
          tileLon,
        ]);
        const data = result.data;
        for (let r = 0; r < rows; r++) {
          if (box.lat.chunk[r] !== tileLat) {
            continue;
          }
          const y = box.lat.offset[r];
          for (let c = 0; c < cols; c++) {
            if (box.lon.chunk[c] !== tileLon) {
              continue;
            }
            const x = box.lon.offset[c];
            for (let m = 0; m < months; m++) {
              // The chunk holds one level: [time][1][lat][lon].
              const value =
                data[(m * tileSize.latitude + y) * tileSize.longitude + x];
              codes[at(m, k, r, c)] = Number.isNaN(value)
                ? MISSING
                : Math.round(value / variable.scale);
            }
          }
        }
        done++;
        onProgress?.({ index, done, total });
      });
    }
  }
  await pooled(tasks, concurrency);
  return { index, start, months, scale: variable.scale, codes };
}

/**
 * Reads time step `t` of a field store (timeChunked.zarr), where one chunk
 * holds every level of the grid for one step: [1][level][lat][lon]. The
 * decoded floats are kept as they are when the box is the whole chunk (no
 * copy), else the box's cells are copied out.
 */
export async function loadStep(
  reader: ChunkReader,
  variable: CubeVariable,
  box: Box,
  t: number,
  chunk: { latitude: number; longitude: number },
): Promise<Block> {
  const rows = box.lat.index.length;
  const cols = box.lon.index.length;
  const levels = box.depth.length;
  const plane = chunk.latitude * chunk.longitude;
  const block = (floats: Float32Array): Block => ({
    index: t,
    start: t,
    months: 1,
    scale: variable.scale,
    codes: new Int16Array(0),
    floats,
  });
  if (box.tiles.length === 1 && isWhole(box, chunk)) {
    const { data } = await reader.fetchChunkResult(variable.name, [t, 0, 0, 0]);
    return block(
      data.length === levels * plane ? data : data.subarray(0, levels * plane),
    );
  }
  const floats = new Float32Array(levels * rows * cols).fill(NaN);
  await Promise.all(
    box.tiles.map(async ([tileLat, tileLon]) => {
      const { data } = await reader.fetchChunkResult(variable.name, [
        t,
        0,
        tileLat,
        tileLon,
      ]);
      for (let k = 0; k < levels; k++) {
        for (let r = 0; r < rows; r++) {
          if (box.lat.chunk[r] !== tileLat) {
            continue;
          }
          const y = box.lat.offset[r];
          for (let c = 0; c < cols; c++) {
            if (box.lon.chunk[c] === tileLon) {
              floats[(k * rows + r) * cols + c] =
                data[k * plane + y * chunk.longitude + box.lon.offset[c]];
            }
          }
        }
      }
    }),
  );
  return block(floats);
}

/** Whether the box is a whole chunk in store order: its cells need no copy. */
function isWhole(
  box: Box,
  chunk: { latitude: number; longitude: number },
): boolean {
  const identity = (index: Int32Array, size: number) =>
    index.length === size && index.every((value, i) => value === i);
  return (
    identity(box.lat.index, chunk.latitude) &&
    identity(box.lon.index, chunk.longitude)
  );
}

/**
 * One time step of the cube on the store's own levels: what the GPU samples
 * (depth is resampled in the shader) and what the sections and picks read.
 */
export interface Volume {
  cols: number;
  rows: number;
  levels: number;
  /** Level centres, metres, shallow to deep. */
  depths: Float64Array;
  /** Values in [level][lat][lon] order; NaN where missing. */
  values: Float32Array;
  /** Departure from the climatology, same layout, when the anomaly is shown. */
  anomaly?: Float32Array;
  /** Eastward and northward velocity, m/s, same layout, when particles are shown. */
  u?: Float32Array;
  v?: Float32Array;
}

/** Step `m` of a block (index in the block) as floats on the native levels. */
function stepValues(block: Block, box: Box, m: number): Float32Array {
  if (block.floats) {
    return block.floats;
  }
  const size = box.depth.length * box.lat.index.length * box.lon.index.length;
  const out = new Float32Array(size);
  const codes = block.codes.subarray(m * size, (m + 1) * size);
  for (let i = 0; i < size; i++) {
    const code = codes[i];
    out[i] = code === MISSING ? NaN : code * block.scale;
  }
  return out;
}

/**
 * Step `m` of a block (index in the block), with the same step of an anomaly
 * block and of the velocity blocks when given.
 */
export function monthVolume(
  block: Block,
  box: Box,
  m: number,
  anomaly?: Block,
  velocity?: { u: Block; v: Block },
): Volume {
  const at = (other: Block) => m - other.start + block.start;
  return {
    cols: box.lon.index.length,
    rows: box.lat.index.length,
    levels: box.depth.length,
    depths: box.depth,
    values: stepValues(block, box, m),
    ...(anomaly ? { anomaly: stepValues(anomaly, box, at(anomaly)) } : {}),
    ...(velocity
      ? {
          u: stepValues(velocity.u, box, at(velocity.u)),
          v: stepValues(velocity.v, box, at(velocity.v)),
        }
      : {}),
  };
}

/** The two levels around `depth` and the weight of the deeper one (see depthWeights). */
export function levelAt(
  depths: ArrayLike<number>,
  depth: number,
): [number, number, number] {
  const last = depths.length - 1;
  if (depth <= depths[0]) {
    return [0, 0, 0];
  }
  if (depth >= depths[last]) {
    return [last, last, 0];
  }
  let k = 0;
  while (k < last - 1 && depths[k + 1] < depth) {
    k++;
  }
  return [k, k + 1, (depth - depths[k]) / (depths[k + 1] - depths[k])];
}

/** A field of a volume at cell (c, r) and a depth, interpolated between levels; NaN where missing. */
export function sampleAt(
  volume: Volume,
  field: Float32Array,
  c: number,
  r: number,
  depth: number,
): number {
  const [upper, lower, weight] = levelAt(volume.depths, depth);
  const plane = volume.cols * volume.rows;
  const i = r * volume.cols + c;
  return interpolate(
    field[upper * plane + i],
    field[lower * plane + i],
    weight,
  );
}

/** Keeps the most recently used blocks and loads each one once. */
export class BlockCache {
  private blocks = new Map<number, Block>();
  private pending = new Map<number, Promise<Block>>();

  constructor(
    private readonly load: (index: number) => Promise<Block>,
    private readonly capacity = 3,
  ) {}

  has(index: number): boolean {
    return this.blocks.has(index);
  }

  peek(index: number): Block | undefined {
    const block = this.blocks.get(index);
    if (block) {
      this.blocks.delete(index);
      this.blocks.set(index, block);
    }
    return block;
  }

  loading(index: number): boolean {
    return this.pending.has(index);
  }

  get(index: number): Promise<Block> {
    const block = this.peek(index);
    if (block) {
      return Promise.resolve(block);
    }
    let promise = this.pending.get(index);
    if (!promise) {
      promise = this.load(index)
        .then((loaded) => {
          this.blocks.set(index, loaded);
          while (this.blocks.size > this.capacity) {
            this.blocks.delete(this.blocks.keys().next().value!);
          }
          return loaded;
        })
        .finally(() => this.pending.delete(index));
      this.pending.set(index, promise);
    }
    return promise;
  }

  /** Indices of the blocks in memory. */
  loaded(): number[] {
    return [...this.blocks.keys()];
  }

  /** Indices of the blocks being read. */
  pendingKeys(): number[] {
    return [...this.pending.keys()];
  }
}
