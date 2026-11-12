/**
 * The chunk reads of a store, decoded in a worker (chunk-worker.ts) so the
 * main thread only receives the values. Metadata stays with the main
 * thread's ZarrSource; this only stands in for `fetchChunkResult`.
 */

import type { ChunkReader } from "./blocks";

type Result = Awaited<ReturnType<ChunkReader["fetchChunkResult"]>>;

export class WorkerChunkReader implements ChunkReader {
  private worker: Worker;
  private next = 0;
  private waiting = new Map<
    number,
    { resolve: (result: Result) => void; reject: (error: Error) => void }
  >();

  constructor(private url: string) {
    this.worker = new Worker(new URL("./chunk-worker.ts", import.meta.url), {
      type: "module",
    });
    // A worker that fails to start or crashes: every pending read fails, none hangs.
    const fail = (message: string) => {
      for (const pending of this.waiting.values()) {
        pending.reject(new Error(message));
      }
      this.waiting.clear();
    };
    this.worker.addEventListener("error", (event) =>
      fail(`Chunk worker: ${event.message || "failed"}`),
    );
    this.worker.addEventListener("messageerror", () =>
      fail("Chunk worker: unreadable message"),
    );
    this.worker.addEventListener(
      "message",
      (
        event: MessageEvent<{
          id: number;
          data?: Float32Array;
          error?: string;
        }>,
      ) => {
        const { id, data, error } = event.data;
        const pending = this.waiting.get(id);
        this.waiting.delete(id);
        if (!pending) {
          return;
        }
        if (error || !data) {
          pending.reject(new Error(error ?? "No data"));
        } else {
          pending.resolve({ data } as Result);
        }
      },
    );
  }

  fetchChunkResult(variable: string, indices: number[]): Promise<Result> {
    return this.request(variable, indices);
  }

  /** `count` values of a chunk from `offset`, every `stride` (a point's series in a chunk). */
  async pick(
    variable: string,
    indices: number[],
    pick: { offset: number; stride: number; count: number },
  ): Promise<Float32Array> {
    return (await this.request(variable, indices, pick)).data;
  }

  private request(
    variable: string,
    indices: number[],
    pick?: { offset: number; stride: number; count: number },
  ): Promise<Result> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, url: this.url, variable, indices, pick });
    });
  }
}
