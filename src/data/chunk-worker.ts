/**
 * Reads and decodes chunks off the main thread: a ZarrSource of the store
 * (with the same Cache Storage chunk store) answering `fetchChunkResult`
 * requests. The decoded values are copied out of its cache and transferred.
 */

import { ZarrSource, cacheChunkStore } from "@fxi/zartigl/engine";

interface Request {
  id: number;
  url: string;
  variable: string;
  indices: number[];
  /** Only these values of the chunk: `count` from `offset`, every `stride`. */
  pick?: { offset: number; stride: number; count: number };
}

const sources = new Map<string, Promise<ZarrSource>>();

function source(url: string): Promise<ZarrSource> {
  let pending = sources.get(url);
  if (!pending) {
    const zarr = new ZarrSource(url, 4, { chunkStore: cacheChunkStore() });
    pending = zarr.init().then(() => zarr);
    sources.set(url, pending);
  }
  return pending;
}

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const { id, url, variable, indices, pick } = event.data;
  try {
    const zarr = await source(url);
    const result = await zarr.fetchChunkResult(variable, indices);
    // The source keeps its own decoded copy in its cache: send a copy, or the picked values.
    const data = pick
      ? Float32Array.from(
          { length: pick.count },
          (_, i) => result.data[pick.offset + i * pick.stride] ?? NaN,
        )
      : new Float32Array(result.data);
    (self as unknown as Worker).postMessage({ id, data }, [data.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
