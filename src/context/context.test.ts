import { describe, expect, it } from "vitest";
import { validateContext } from "./validate";
import enso from "../public/contexts/enso-nino-3-4.json";
import leman from "../public/contexts/leman-lake.json";
import index from "../public/contexts/index.json";
import { requestedContext as request } from "./load";
import {
  cadenceOf,
  findTime,
  monthGroups,
  timeKey,
  timeText,
} from "../data/time";
import { maskOutline, geojsonParts } from "../ui/overlays";
import { createBox, levelLimit } from "../data/box";
import {
  CursorSeries,
  chunkOrder,
  seriesPoint,
  type SeriesStore,
} from "../data/cursor-series";
import {
  loadStep,
  monthVolume,
  sampleAt,
  type ChunkReader,
} from "../data/blocks";
import { createSpace } from "../gl/space";

const FILES: Record<string, unknown> = {
  "enso-nino-3-4.json": enso,
  "leman-lake.json": leman,
  "index.json": index,
};
const read = (name: string) =>
  structuredClone(FILES[name]) as Record<string, unknown>;

describe("context schema", () => {
  it("accepts the bundled contexts", () => {
    expect(validateContext(read("enso-nino-3-4.json"))).toEqual([]);
    expect(validateContext(read("leman-lake.json"))).toEqual([]);
  });

  it("lists every bundled context in the index", () => {
    const index = read("index.json") as unknown as Array<{
      id: string;
      file: string;
    }>;
    for (const listing of index) {
      expect(read(listing.file).id).toBe(listing.id);
    }
  });

  it("names the field and the problem", () => {
    const context = read("leman-lake.json");
    delete (context as { extent?: unknown }).extent;
    (context.display as Record<string, unknown>).land = "water";
    const errors = validateContext(context);
    expect(errors).toContainEqual({ path: "/extent", message: "is required" });
    expect(errors.map((e) => e.path)).toContain("/display/land");
  });

  it("rejects unknown fields and overlay types", () => {
    const context = read("enso-nino-3-4.json");
    context.colour = "red";
    (context.overlays as unknown[]).push({ type: "circle" });
    const paths = validateContext(context).map((e) => e.path);
    expect(paths).toContain("/colour");
    expect(paths).toContain("/overlays/3/type");
  });

  it("checks cross references", () => {
    const context = read("enso-nino-3-4.json");
    (context.indicators as Array<{ box: string }>)[0].box = "nino12";
    expect(validateContext(context).map((e) => e.path)).toEqual([
      "/indicators/0/box",
    ]);
  });
});

describe("context request", () => {
  const at = (url: string) => new URL(url) as unknown as Location;
  const requestedContext = (loc: Location) => request(loc, "/strata/");
  it("reads the path, ?ctx= and ?config=", () => {
    expect(requestedContext(at("https://fxi.io/strata/leman-lake"))).toEqual({
      kind: "listed",
      id: "leman-lake",
    });
    expect(
      requestedContext(at("https://fxi.io/strata/?ctx=leman-lake")).id,
    ).toBe("leman-lake");
    expect(requestedContext(at("https://fxi.io/strata/")).id).toBe(
      "enso-nino-3-4",
    );
    expect(
      requestedContext(
        at("https://fxi.io/strata/?config=https://x.org/c.json"),
      ),
    ).toEqual({
      kind: "url",
      id: "https://x.org/c.json",
      url: "https://x.org/c.json",
    });
    expect(requestedContext(at("https://fxi.io/strata/imported")).kind).toBe(
      "imported",
    );
  });
});

describe("time", () => {
  const hours = Array.from({ length: 20 }, (_, i) =>
    Date.UTC(2024, 0, 31, 3 * i),
  );
  const months = Array.from({ length: 14 }, (_, i) => Date.UTC(2023, i, 1));

  it("finds the cadence of a store", () => {
    expect(cadenceOf(hours)).toEqual({ kind: "hour", hours: 3 });
    expect(cadenceOf(months).kind).toBe("month");
  });

  it("writes and reads steps", () => {
    const cadence = cadenceOf(hours);
    expect(timeText(hours[3], cadence)).toBe("2024-01-31 09:00");
    expect(timeKey(hours[3], cadence)).toBe("2024-01-31T09");
    expect(findTime(hours, cadence, "2024-01-31T09")).toBe(3);
    expect(findTime(hours, cadence, "2024-01-31 09:00")).toBe(3);
    expect(timeKey(months[2], cadenceOf(months))).toBe("2023-03");
  });

  it("groups steps by month", () => {
    const groups = monthGroups(hours);
    expect(groups).toEqual([
      { start: 0, end: 7, label: "2024-01" },
      { start: 8, end: 19, label: "2024-02" },
    ]);
  });
});

describe("overlays", () => {
  it("outlines the valid cells", () => {
    // A 2 × 2 block of water in a 4 × 4 grid.
    const plane = new Float32Array(16).fill(NaN);
    for (const i of [5, 6, 9, 10]) {
      plane[i] = 1;
    }
    const [ring, ...rest] = maskOutline(plane, 4, 4, {
      west: 0,
      east: 4,
      south: 0,
      north: 4,
    });
    expect(rest).toHaveLength(0);
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    expect(Math.min(...lons)).toBe(1);
    expect(Math.max(...lons)).toBe(3);
    expect(Math.min(...lats)).toBe(1);
    expect(Math.max(...lats)).toBe(3);
  });

  it("splits GeoJSON into lines and labelled points", () => {
    const parts = geojsonParts({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Buoy" },
          geometry: { type: "Point", coordinates: [6.5, 46.4] },
        },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
    expect(parts.points).toEqual([{ lon: 6.5, lat: 46.4, label: "Buoy" }]);
    expect(parts.lines).toHaveLength(1);
  });
});

describe("field store steps", () => {
  // A 3-level, 2 × 3 grid in one chunk per step: [1][level][lat][lon].
  const LON = [6.1, 6.2, 6.3];
  const LAT = [46.2, 46.3];
  const DEPTH = [1, 10, 100];

  it("keeps the levels to the first one below the bottom", () => {
    expect(levelLimit(DEPTH, 50)).toBe(100);
    expect(levelLimit(DEPTH, 10)).toBe(10);
  });

  it("reads one step, missing cells included, and resamples it", async () => {
    const box = createBox(
      { longitude: LON, latitude: LAT, depth: DEPTH },
      { latitude: 2, longitude: 3 },
      { west: 6, east: 6.4, south: 46, north: 46.4, maxDepth: 100 },
    );
    const data = new Float32Array(18).map((_, i) => i * 0.5);
    data[0] = NaN;
    const reader: ChunkReader = {
      fetchChunkResult: async (_name: string, indices: number[]) => {
        expect(indices).toEqual([7, 0, 0, 0]);
        return { data } as never;
      },
    };
    const block = await loadStep(
      reader,
      { name: "temperature", scale: 0.01 },
      box,
      7,
      {
        latitude: 2,
        longitude: 3,
      },
    );
    expect(block.start).toBe(7);
    // The whole chunk: kept as decoded, no copy.
    expect(block.floats).toBe(data);
    const volume = monthVolume(block, box, 0);
    expect(Number.isNaN(volume.values[0])).toBe(true);
    expect(volume.values[2 * 6 + 5]).toBeCloseTo(8.5, 5);
    // Halfway between the 10 m and 100 m levels.
    expect(sampleAt(volume, volume.values, 2, 1, 55)).toBeCloseTo(7, 5);
    expect(Number.isNaN(sampleAt(volume, volume.values, 0, 0, 0))).toBe(true);
  });

  it("measures the cube without a date line", () => {
    const box = createBox(
      { longitude: LON, latitude: LAT, depth: DEPTH },
      { latitude: 2, longitude: 3 },
      { west: 6, east: 6.4, south: 46, north: 46.4, maxDepth: 100 },
    );
    const space = createSpace(box, { latStretch: 1.45, bottom: 100 });
    expect(space.west).toBeCloseTo(6.05, 9);
    expect(space.east).toBeCloseTo(6.35, 9);
    expect(space.exaggeration).toBeGreaterThan(10);
    expect(space.exaggeration).toBeLessThan(1000);
  });
});

describe("cursor series", () => {
  it("keeps loading when asked again for the same cell", async () => {
    const store: SeriesStore = {
      latitude: [46.2, 46.3],
      longitude: [6.1, 6.2],
      depth: [1, 10],
      chunk: [4, 1, 2, 2],
      steps: 10,
      pick: async (indices, pick) => {
        await new Promise((done) => setTimeout(done, 5));
        return Float32Array.from({ length: pick.count }, () => indices[0]);
      },
    };
    const series = new CursorSeries(store, () => undefined, 1);
    const point = seriesPoint(store, 6.2, 46.3, 9);
    expect(point).toMatchObject({ lat: 1, lon: 1, level: 1 });
    const first = series.load(point, 5);
    await series.load({ ...point }, 5);
    await first;
    // Every chunk read: steps 0–3 from chunk 0, 4–7 from 1, 8–9 from 2.
    expect(Array.from(series.values)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
    expect(chunkOrder(5, 2)).toEqual([2, 3, 1, 4, 0]);
  });
});
