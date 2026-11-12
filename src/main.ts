/**
 * strata: a 4D data cube from a context file (see context/types.ts). The
 * context names zartigl catalog entries, the extent, display defaults,
 * reference boxes and places; the cube reads its store in blocks of time
 * steps (five-year blocks of a point-series store, single steps of a field
 * store), resamples them on a regular depth grid and draws slices, an
 * isotherm and sections through time.
 */

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./style.css";

import { resolveLocalizedText } from "@fxi/zartigl/catalog";
import { ZarrSource, cacheChunkStore } from "@fxi/zartigl/engine";
import { tickStep } from "d3";
import {
  BlockCache,
  loadBlock,
  loadStep,
  monthVolume,
  sampleAt,
  type Block,
  type CubeVariable,
  type Volume,
} from "./data/blocks";
import {
  boxLongitude,
  createBox,
  latLabel,
  levelLimit,
  lonLabel,
} from "./data/box";
import {
  CursorSeries,
  seriesPoint,
  type SeriesStore,
} from "./data/cursor-series";
import { depthTable } from "./data/depth";
import { WorkerChunkReader } from "./data/worker-source";
import {
  anomaly,
  climatology,
  episodes,
  ninoSeries,
  runningMean,
} from "./data/nino";
import {
  cadenceLabel,
  cadenceOf,
  findTime,
  monthGroups,
  timeKey,
  timeText,
} from "./data/time";
import {
  PRESETS,
  blendViews,
  frame,
  unproject,
  type Preset,
  type Vec3,
  type View,
} from "./gl/camera";
import { CubeRenderer, LineBatch, type Show } from "./gl/renderer";
import { createSpace, fromWorld, toWorld } from "./gl/space";
import {
  listPalettes,
  rampBytes,
  rampColor,
  type PaletteName,
} from "./palettes";
import { PaletteMenu } from "./ui/palette-menu";
import { currentCatalog, findEntry, storeUrl } from "./context/catalog";
import { loadContext, localize, type LoadedContext } from "./context/load";
import type { ContextState, StrataContext } from "./context/types";
import { ContextPicker } from "./ui/context-picker";
import { VideoExporter, type VideoHost } from "./export/video";
import { project } from "./gl/camera";
import { Labels } from "./ui/labels";
import { maskOutline, resolveOverlays, type Polyline } from "./ui/overlays";
import { SlicePanel, type Cursor, type SliceKind } from "./ui/slice2d";
import { DataManager, type DataBlock } from "./ui/data-manager";
import { Timeline, type BlockStatus } from "./ui/timeline";

type Mode = "absolute" | "anomaly";
/** Steps of a field store kept in memory, per field. */
const FIELD_STEPS = 8;
const MOBILE = 760;
const PRESET_NAMES: Record<Preset, string> = {
  iso: "3D ISO",
  top: "3D TOP",
  front: "3D FRONT",
  side: "3D SIDE",
  cavalier: "3D CAVALIER",
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function facts(target: HTMLElement, rows: Array<[string, string]>): void {
  target.replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

/** 5, 4478, 0.13: whole metres when whole, two decimals near the surface. */
function metres(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value < 10 ? value.toFixed(2) : value.toFixed(0);
}

/** A coordinate with the decimals it has, at most two. */
function degrees(value: number): number {
  return Math.round(value * 100) / 100;
}

function digitsOf(value: number): number {
  const text = String(degrees(value));
  return text.includes(".") ? text.split(".")[1].length : 0;
}

const ICONS: Record<string, string> = {
  first: '<path d="M5 4v12M16 4 8 10l8 6z"/>',
  back: '<path d="M10 4 3 10l7 6zM18 4l-7 6 7 6z"/>',
  play: '<path d="M6 4l11 6-11 6z"/>',
  pause: '<path d="M6 4h3v12H6zM12 4h3v12h-3z"/>',
  forward: '<path d="M2 4l7 6-7 6zM10 4l7 6-7 6z"/>',
  last: '<path d="M15 4v12M4 4l8 6-8 6z"/>',
};

function icon(button: HTMLElement, name: string): void {
  button.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Runs `tasks` with at most `limit` in flight. */
async function pooled(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      await tasks[next++]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
}

async function run(
  loaded: LoadedContext,
  picker: ContextPicker,
): Promise<void> {
  const ctx = loaded.context;
  const L = (text: Parameters<typeof localize>[0]) => localize(text);
  const layout = ctx.data.store;
  const field = layout === "field";
  const unit = ctx.display.unit ?? "";
  const anomalySpec = ctx.data.scalar.anomaly;
  const bottom = ctx.extent.bottom;

  const loading = $("loading");
  const status = (text: string | null) => {
    loading.hidden = !text;
    loading.textContent = text ?? "";
  };
  status("READING CATALOG…");
  document.title = `${L(ctx.title)} — strata`;

  const catalog = await currentCatalog();
  const entry = findEntry(catalog, ctx.data.scalar.entry);
  const anomalyEntry = anomalySpec?.entry
    ? findEntry(catalog, anomalySpec.entry)
    : entry;
  const url = storeUrl(entry, layout);

  status("READING METADATA…");
  // Chunks persist across sessions: the stores only append steps (see lib/chunkStore.ts).
  const chunkStore = cacheChunkStore();
  // Metadata here; chunks are read and decoded in a worker.
  const source = new ZarrSource(url, 2, { chunkStore });
  const reader = new WorkerChunkReader(url);
  await source.init();
  const coords = source.getCoords();
  const times = source.getTimeDimension().values;
  const cadence = cadenceOf(times);
  const text = (i: number) => timeText(times[i], cadence);
  /** The store's int16 precision of a variable; from the domain when the store has none. */
  const variable = (name: string, domain: [number, number]): CubeVariable => {
    const scale = Number(source.getVariableAttrs(name).scale_factor);
    return {
      name,
      scale:
        Number.isFinite(scale) && scale > 0
          ? scale
          : Math.max(Math.abs(domain[0]), Math.abs(domain[1])) / 30000,
    };
  };
  const SCALAR = variable(ctx.data.scalar.variable, ctx.display.domain);
  const ANOMALY = anomalySpec
    ? variable(anomalySpec.variable, anomalySpec.domain)
    : null;
  /** The vector field: in the same store as the scalar (checked here). */
  const vectorSpec = ctx.data.vector;
  const VELOCITY =
    vectorSpec &&
    source.hasVariable(vectorSpec.u) &&
    source.hasVariable(vectorSpec.v)
      ? {
          u: variable(vectorSpec.u, [-3, 3]),
          v: variable(vectorSpec.v, [-3, 3]),
        }
      : null;
  if (vectorSpec && !VELOCITY) {
    console.warn(
      `${vectorSpec.u}/${vectorSpec.v} are not in ${ctx.data.scalar.entry}'s store: no particles`,
    );
  }
  const particleSpec = ctx.display.particles ?? {};
  const stepSeconds =
    cadence.kind === "month"
      ? 30.44 * 86400
      : cadence.kind === "day"
        ? 86400
        : cadence.hours * 3600;
  const chunk = source.getChunkShape(SCALAR.name);
  const [storeTimeChunk, , tileLat, tileLon] = chunk;
  const tile = { latitude: tileLat, longitude: tileLon };
  /** Time steps per loaded block: the store's time chunk, or one step of a field store. */
  const timeChunk = field ? 1 : storeTimeChunk;
  const box = createBox(
    {
      longitude: coords.longitude,
      latitude: coords.latitude,
      depth: coords.vertical,
    },
    tile,
    {
      west: ctx.extent.west,
      east: ctx.extent.east,
      south: ctx.extent.south,
      north: ctx.extent.north,
      maxDepth: levelLimit(coords.vertical, bottom),
      lonWrap: ctx.extent.lonWrap ?? false,
    },
  );
  if (!box.lon.index.length || !box.lat.index.length || !box.depth.length) {
    throw new Error("The context's extent holds no cell of the store");
  }
  const midLat = (ctx.extent.south + ctx.extent.north) / 2;
  const space = createSpace(box, {
    latStretch:
      ctx.space?.latStretch ??
      Math.round((1 / Math.cos((midLat * Math.PI) / 180)) * 100) / 100,
    bottom,
  });
  const lastMonth = times.length - 1;
  const range = `${text(0)} – ${text(lastMonth)}`;
  const allDepths = Array.from(coords.vertical);
  const lonDigits = space.lonStep < 0.1 ? 3 : 1;
  const latDigits = space.latStep < 0.1 ? 3 : 1;
  const overlays = await resolveOverlays(
    ctx.overlays ?? [],
    { ...ctx.extent },
    L,
    loaded.baseUrl,
  );
  const boxNames = overlays.boxes.map((b) => L(b.label) || b.id).join(", ");
  const basePeriod = anomalySpec?.basePeriod;
  const baseText = basePeriod ? `base ${basePeriod[0]}–${basePeriod[1]}` : "";

  // Text around the cube.
  const extentText = () => {
    const { west, east, south, north } = ctx.extent;
    const lonD = Math.max(digitsOf(west), digitsOf(east));
    return `${lonLabel(west, lonD)}–${lonLabel(east, lonD)}, ${latLabel(south, digitsOf(south))}–${latLabel(north, digitsOf(north))}`;
  };
  /** The facts that name the shown variable. */
  const describe = (anomalyMode: boolean) => {
    const shownVariable =
      anomalyMode && ANOMALY
        ? `${ANOMALY.name} (${[unit, baseText].filter(Boolean).join(", ")})`
        : `${SCALAR.name} (${unit})`;
    $("entry-title").textContent = resolveLocalizedText(
      (anomalyMode ? anomalyEntry : entry).title,
      "en",
    );
    $("entry-subtitle").textContent =
      anomalyMode && anomalySpec?.subtitle
        ? L(anomalySpec.subtitle)
        : L(ctx.subtitle);
    $("entry-provider").textContent = L(ctx.provider);
    facts($("dataset"), [
      ["Dataset", L(ctx.facts?.dataset) || SCALAR.name],
      [
        "Period",
        `${range} · ${allDepths.length} levels · ${metres(allDepths[0])} m to ${metres(allDepths[allDepths.length - 1])} m`,
      ],
      [
        "Grid",
        L(ctx.facts?.grid) ||
          `${degrees(space.lonStep)}° × ${degrees(space.latStep)}°`,
      ],
      ["Variable", shownVariable],
      [
        "Cube",
        `${extentText()} · 0–${bottom} m · ${cadenceLabel(cadence).toLowerCase()}${boxNames ? ` · ROI ${boxNames}` : ""}`,
      ],
      ["id", (anomalyMode ? anomalyEntry : entry).id],
    ]);
  };
  /** Facts of the data cube, at the head of the DATA panel. */
  const cubeFacts = (anomalyMode: boolean): Array<[string, string]> => [
    [
      "VARIABLE",
      anomalyMode && ANOMALY
        ? `${SCALAR.name} + ${ANOMALY.name}${baseText ? ` (${baseText})` : ""}`
        : `${SCALAR.name} (${unit})`,
    ],
    ["GRID", L(ctx.facts?.region) || L(ctx.title)],
    [
      "LEVELS",
      `${box.depth.length} of ${allDepths.length} (${metres(box.depth[0])}–${metres(box.depth[box.depth.length - 1])} m)`,
    ],
    ["TIME", range],
    [
      "BLOCKS",
      field
        ? `1 step per chunk · ${box.tiles.length} chunk${box.tiles.length > 1 ? "s" : ""} per step and variable`
        : `${timeChunk} months · ${box.tiles.length * box.depth.length} chunks per variable`,
    ],
    ["STORE", url.replace(/^https?:\/\//, "")],
  ];
  describe(false);
  $("context-title").textContent = L(ctx.title);
  $("context").title = L(ctx.heading) || L(ctx.description) || L(ctx.title);
  $("credit").textContent = L(ctx.credit);
  $("time-range").textContent = `(${range})`;
  $("time-cadence").textContent = cadenceLabel(cadence);
  $("scale").textContent =
    `lat ×${space.latStretch} · depth ×${space.exaggeration.toLocaleString("en")} · ${box.depth.length} levels to ${metres(box.depth[box.depth.length - 1])} m`;
  if (ctx.panel) {
    $("about").hidden = false;
    $("about-title").textContent = L(ctx.panel.title);
    $("about-note").textContent = L(ctx.panel.note);
    $("about-detail").textContent = L(ctx.panel.detail);
  }
  const iso = ctx.display.iso;
  $("label-iso").textContent = iso
    ? L(iso.label) || `ISO-SURFACE ${iso.value} ${unit}`.trim()
    : "ISO-SURFACE";
  $("cube").setAttribute(
    "aria-label",
    `Interactive 3D cube of ${SCALAR.name}, ${extentText()}, surface to ${bottom} m, with movable slice planes.`,
  );

  // Renderer and labels.
  const canvas = $<HTMLCanvasElement>("cube");
  let renderer: CubeRenderer;
  try {
    renderer = new CubeRenderer(canvas, space.half);
  } catch {
    status("THIS VIEW NEEDS WEBGL2.");
    return;
  }
  renderer.setDepthTable(depthTable(box.depth, 512, bottom));
  const stage = $("stage");
  const labels = new Labels(space, {
    boxes: overlays.boxes,
    boxLabel: (b) => `${L(b.label) || b.id} box`.toUpperCase(),
    pois: overlays.pois,
  });
  stage.append(labels.element);
  /** Surface lines: the context's, plus the outline of the data once a step is read. */
  let surfaceLines: Polyline[] = overlays.lines;
  const setSurfaceLines = (lines: Polyline[]) => {
    surfaceLines = lines;
    const batch = new LineBatch();
    for (const line of lines) {
      batch.polyline(line.map(([lon, lat]) => toWorld(space, lon, lat, 0)));
    }
    renderer.setLines("coast", batch);
    for (const panel of panels.values()) {
      panel.setLines(lines);
    }
  };
  {
    const roi = new LineBatch();
    for (const b of overlays.boxes) {
      const [top, base] = b.depth ?? [0, bottom];
      roi.box(
        toWorld(space, b.west, b.south, base),
        toWorld(space, b.east, b.north, top),
      );
    }
    renderer.setLines("roi", roi);
    const marks = new LineBatch();
    const drops = new LineBatch();
    const size = 0.018;
    for (const poi of overlays.pois) {
      if (!poi.marker) {
        continue;
      }
      const [x, y, z] = toWorld(space, poi.lon, poi.lat, 0);
      marks.segment([x - size, y, z], [x + size, y, z]);
      marks.segment([x, y - size, z], [x, y + size, z]);
      if (poi.drop) {
        drops.segment([x, y, z], toWorld(space, poi.lon, poi.lat, poi.drop));
      }
    }
    renderer.setLines("pois", marks);
    renderer.setLines("drops", drops);
    renderer.setLines("ticks", labels.ticks());
  }

  // State.
  // Palettes: every zartigl one (or the context's list), diverging ones for the anomaly.
  const allPalettes = listPalettes().filter(
    (p) => !ctx.display.palettes || ctx.display.palettes.includes(p.id),
  );
  const palettes = allPalettes.map((p) => p.id);
  const divergingPalettes = allPalettes.filter((p) => p.kind === "diverging");
  let palette: PaletteName = palettes.includes(ctx.display.palette ?? "")
    ? ctx.display.palette!
    : (palettes.find((id) => id === "thermal") ?? palettes[0]);
  let anomalyPalette: PaletteName =
    divergingPalettes.find((p) => p.id === "balance")?.id ??
    divergingPalettes[0]?.id ??
    "balance";
  /** Absolute values, or their departure from the climatology (balance palette, fixed). */
  let mode: Mode = "absolute";
  const anomalyMode = () => mode === "anomaly" && ANOMALY !== null;
  const domain = (): [number, number] =>
    anomalyMode() && anomalySpec ? anomalySpec.domain : ctx.display.domain;
  let ramp = rampBytes(palette);
  renderer.setPalette(ramp);
  const show: Show = {
    slices: true,
    iso: Boolean(iso),
    roi: overlays.boxes.length > 0,
    coast: true,
    contours: true,
    pois: true,
    particles: Boolean(VELOCITY && particleSpec.show),
  };
  const cursor: Cursor = {
    ...(ctx.display.cursor ?? {
      lon: (space.west + space.east) / 2,
      lat: (space.south + space.north) / 2,
      depth: bottom / 3,
    }),
  };
  const startPreset = (
    ctx.display.view && ctx.display.view in PRESETS ? ctx.display.view : "iso"
  ) as Preset;
  let view: View = { ...PRESETS[startPreset] };
  let transition: { from: View; to: View; start: number } | null = null;
  let month = lastMonth;
  let shown = -1;
  let current: Volume | null = null;
  let nextMonth = -1;
  let playing = false;
  /** The view preset in use, null once the view was turned by hand. */
  let preset: Preset | null = startPreset;
  /** `#…&capture`: video capture drives the steps and their blend (see cubeCapture below). */
  const capture = /[#&]capture\b/.test(location.hash);
  let captureMix: number | null = null;
  const speeds = ctx.time?.speeds ?? [
    { value: 2, label: "2 steps/s" },
    { value: 4, label: "4 steps/s" },
    { value: 8, label: "8 steps/s" },
  ];
  let speed = speeds[Math.min(speeds.length - 1, ctx.time?.speed ?? 0)].value;
  let dirty = true;
  const requestDraw = () => (dirty = true);

  // Data: one cache per variable; the anomaly is only read in anomaly mode.
  /** Re-reads what is on disk shortly after blocks were read (see the DATA panel). */
  let refreshTimer = 0;
  const refreshDisk = () => {
    clearTimeout(refreshTimer);
    // Listing the cache is heavy for field stores: not while playing (see setPlaying).
    if (field && playing) {
      return;
    }
    refreshTimer = window.setTimeout(
      () => void manager.refresh(),
      field ? 1500 : 400,
    );
  };
  const readBlock = (
    v: CubeVariable,
    index: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Block> =>
    field
      ? loadStep(reader, v, box, index, tile)
      : loadBlock(
          reader,
          v,
          box,
          index,
          timeChunk,
          times.length,
          tile,
          (progress) => onProgress?.(progress.done, progress.total),
        );
  const blockCache = (v: CubeVariable, label: string) => {
    const cache: BlockCache = new BlockCache(
      (index) =>
        readBlock(v, index, (done, total) => {
          if (Math.floor(month / timeChunk) === index && !cache.has(index)) {
            const first = text(index * timeChunk).slice(0, 4);
            const last = text(
              Math.min(lastMonth, (index + 1) * timeChunk - 1),
            ).slice(0, 4);
            status(
              `LOADING ${label}${first}–${last} · ${done}/${total} CHUNKS`,
            );
          }
          updateBlocks();
        }).then((block) => {
          refreshDisk();
          return block;
        }),
      // About 6 MB per field and step: 8 steps × 3 fields stay under 150 MB.
      field ? FIELD_STEPS : 3,
    );
    return cache;
  };
  const temperatures = blockCache(SCALAR, "");
  const departures = ANOMALY ? blockCache(ANOMALY, "ANOMALY ") : null;
  const currents = VELOCITY
    ? {
        u: blockCache(VELOCITY.u, "CURRENTS "),
        v: blockCache(VELOCITY.v, "CURRENTS "),
      }
    : null;
  const particlesOn = () => show.particles && currents !== null;
  /** The caches the current mode needs, read together. */
  const caches = () => [
    temperatures,
    ...(anomalyMode() && departures ? [departures] : []),
    ...(particlesOn() && currents ? [currents.u, currents.v] : []),
  ];
  const cache = {
    has: (b: number) => caches().every((c) => c.has(b)),
    loading: (b: number) => caches().some((c) => c.loading(b)),
    get: (b: number) => Promise.all(caches().map((c) => c.get(b))),
  };
  const blockOf = (m: number) => Math.floor(m / timeChunk);
  const volumeOf = (m: number): Volume | null => {
    const block = temperatures.peek(blockOf(m));
    const departure =
      anomalyMode() && departures ? departures.peek(blockOf(m)) : undefined;
    if (!block || (anomalyMode() && !departure)) {
      return null;
    }
    let velocity: { u: Block; v: Block } | undefined;
    if (particlesOn() && currents) {
      const u = currents.u.peek(blockOf(m));
      const v = currents.v.peek(blockOf(m));
      if (!u || !v) {
        return null;
      }
      velocity = { u, v };
    }
    return monthVolume(block, box, m - block.start, departure, velocity);
  };
  /** Steps ahead read during playback of a field store. */
  const prefetch = (from: number) => {
    if (!field) {
      return;
    }
    // Within the cache: the shown step and the next stay in it.
    const ahead = Math.min(
      FIELD_STEPS - 3,
      Math.max(2, Math.ceil(speed * 0.75)),
    );
    for (let k = 1; k <= ahead && from + k <= lastMonth; k++) {
      if (!cache.has(from + k) && !cache.loading(from + k)) {
        void cache.get(from + k).then(updateBlocks);
      }
    }
  };

  // Slice panels.
  const isoStep = iso?.step ?? 2;
  const panels = new Map<SliceKind, SlicePanel>();
  for (const section of document.querySelectorAll<HTMLElement>(".slice")) {
    const kind = section.dataset.slice as SliceKind;
    const readout = section.querySelector<HTMLElement>(".slice-title")!;
    const panel = new SlicePanel(
      kind,
      space,
      {
        boxes: overlays.boxes,
        iso: {
          main: iso?.value ?? NaN,
          step: isoStep,
          range: [
            ctx.display.domain[0] - 4 * isoStep,
            ctx.display.domain[1] + isoStep,
          ],
        },
        unit,
        clearLand: ctx.display.land === "clear",
      },
      readout,
      (change) => setCursor(change),
    );
    section.append(panel.canvas);
    panels.set(kind, panel);
  }
  setSurfaceLines(surfaceLines);
  let outlined = !overlays.maskOutline;
  /** The outline of the data's surface cells, from the first step read. */
  const outlineFrom = (volume: Volume) => {
    if (wetShare < 0) {
      const plane = volume.cols * volume.rows;
      let wet = 0;
      for (let i = 0; i < plane; i++) {
        wet += Number.isNaN(volume.values[i]) ? 0 : 1;
      }
      wetShare = wet / plane;
    }
    if (outlined) {
      return;
    }
    outlined = true;
    const plane = volume.values.subarray(0, volume.cols * volume.rows);
    setSurfaceLines([
      ...overlays.lines,
      ...maskOutline(plane, volume.rows, volume.cols, space),
    ]);
  };
  const drawPanels = () => {
    for (const panel of panels.values()) {
      panel.update(
        current,
        { ...cursor },
        {
          ramp,
          domain: domain(),
          anomaly: anomalyMode(),
          contours: show.contours,
          roi: show.roi,
          coast: show.coast,
        },
      );
    }
  };

  // Timeline: groups of steps (blocks of a point-series store, months of a field store).
  const groups = field
    ? monthGroups(times)
    : Array.from({ length: Math.ceil(times.length / timeChunk) }, (_, b) => {
        const start = b * timeChunk;
        const end = Math.min(lastMonth, (b + 1) * timeChunk - 1);
        return {
          start,
          end,
          label: `${text(start).slice(0, 4)}–${text(end).slice(0, 4)}`,
        };
      });
  const groupOfStep = new Int32Array(times.length);
  groups.forEach((g, i) => groupOfStep.fill(i, g.start, g.end + 1));
  const indicator = (ctx.indicators ?? []).find((i) => i.type === "box-index");
  let index: Float64Array | null = null;
  if (indicator && !field) {
    const region = overlays.boxes.find((b) => b.id === indicator.box)!;
    status(`READING ${(L(region.label) || region.id).toUpperCase()}…`);
    const series = await ninoSeries(
      reader,
      coords,
      times.length,
      timeChunk,
      tile,
      { ...region, lonWrap: ctx.extent.lonWrap },
      SCALAR.name,
    );
    index = runningMean(
      anomaly(series, times, climatology(series, times, indicator.basePeriod)),
    );
    $("time-legend").hidden = false;
    $("episode-key").hidden = false;
    $("indicator-label").textContent = L(indicator.label);
  } else if (indicator) {
    console.warn("box-index indicators need a point-series store");
  }
  const timeline = new Timeline(
    Array.from(times),
    index,
    index ? episodes(index) : [],
    groups,
    (m) => setMonth(m),
  );
  $("timeline").append(timeline.canvas);

  // The scalar at the cursor, every step, from the point-series store (field contexts).
  let loadCursorSeries = () => {};
  let drawCursorSeries = () => {};
  if ((ctx.indicators ?? []).some((i) => i.type === "cursor-series")) {
    try {
      const seriesUrl = storeUrl(entry, "pointSeries");
      const seriesSource = new ZarrSource(seriesUrl, 1, { chunkStore });
      await seriesSource.init();
      const seriesCoords = seriesSource.getCoords();
      const seriesSteps = seriesSource.getTimeDimension().values.length;
      if (seriesSteps !== times.length) {
        console.warn(
          `point-series store has ${seriesSteps} steps, the field ${times.length}`,
        );
      }
      const seriesReader = new WorkerChunkReader(seriesUrl);
      const store: SeriesStore = {
        latitude: seriesCoords.latitude,
        longitude: Float64Array.from(seriesCoords.longitude, (lon) =>
          boxLongitude(ctx.extent, lon),
        ),
        depth: seriesCoords.vertical,
        chunk: seriesSource.getChunkShape(SCALAR.name) as SeriesStore["chunk"],
        steps: Math.min(seriesSteps, times.length),
        pick: (indices, pick) => seriesReader.pick(SCALAR.name, indices, pick),
      };
      const series = new CursorSeries(store, () => drawCursorSeries());
      const label = L(
        (ctx.indicators ?? []).find((i) => i.type === "cursor-series")?.label,
      );
      drawCursorSeries = () => {
        timeline.setSeries({
          values: series.values,
          ramp: rampBytes(palette),
          domain: ctx.display.domain,
        });
        const p = series.point;
        $("indicator-label").textContent = p
          ? `${label || SCALAR.name} at ${lonLabel(p.longitude, lonDigits)} ${latLabel(p.latitude, latDigits)}, ${metres(p.depth)} m (${unit})`
          : "";
      };
      $("time-legend").hidden = false;
      let timer = 0;
      loadCursorSeries = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          void series.load(
            seriesPoint(store, cursor.lon, cursor.lat, cursor.depth),
            Math.floor(month),
          );
        }, 400);
      };
    } catch (error) {
      console.warn("No cursor series:", error);
    }
  }
  /** Groups of the current mode complete on disk, as last read by the DATA panel. */
  let onDisk = new Set<number>();
  const updateBlocks = () => {
    const loadedGroups = new Set<number>();
    const loadingGroups = new Set<number>();
    for (const c of caches()) {
      for (const b of c.loaded()) {
        loadedGroups.add(groupOfStep[b * timeChunk]);
      }
      for (const b of c.pendingKeys()) {
        loadingGroups.add(groupOfStep[b * timeChunk]);
      }
    }
    const states: BlockStatus[] = groups.map((_, g) =>
      loadedGroups.has(g)
        ? "loaded"
        : loadingGroups.has(g)
          ? "loading"
          : onDisk.has(g)
            ? "cached"
            : "missing",
    );
    timeline.setStatus(states);
  };

  // DATA panel: the chunks of each group, on disk or to download.
  const groupChunks = (v: CubeVariable, g: number) => {
    const chunkOf = (indices: number[]) => ({
      url: source.chunkUrl(v.name, indices),
      revision: source.chunkRevision(v.name, indices),
    });
    if (field) {
      const out = [];
      for (let t = groups[g].start; t <= groups[g].end; t++) {
        for (const [y, x] of box.tiles) {
          out.push(chunkOf([t, 0, y, x]));
        }
      }
      return out;
    }
    return Array.from(box.depth, (_, level) => level).flatMap((level) =>
      box.tiles.map(([y, x]) => chunkOf([g, level, y, x])),
    );
  };
  const allVariables = [
    SCALAR,
    ...(ANOMALY ? [ANOMALY] : []),
    ...(VELOCITY ? [VELOCITY.u, VELOCITY.v] : []),
  ];
  const modeVariables = () => [
    SCALAR,
    ...(anomalyMode() && ANOMALY ? [ANOMALY] : []),
    ...(particlesOn() && VELOCITY ? [VELOCITY.u, VELOCITY.v] : []),
  ];
  const manager = new DataManager({
    button: $<HTMLButtonElement>("data"),
    store: chunkStore,
    prefix: url,
    bulk: !field,
    facts: () => cubeFacts(anomalyMode()),
    blocks: () =>
      groups.map(
        (group, g): DataBlock => ({
          index: g,
          label: group.label,
          chunks: modeVariables().flatMap((v) => groupChunks(v, g)),
          all: allVariables.flatMap((v) => groupChunks(v, g).map((c) => c.url)),
        }),
      ),
    // Read through ZarrSource, so the chunks land on disk; the blocks themselves are dropped.
    download: async (g, onProgress) => {
      const variables = modeVariables();
      if (field) {
        const tasks: Array<() => Promise<void>> = [];
        const total =
          variables.length *
          (groups[g].end - groups[g].start + 1) *
          box.tiles.length;
        let done = 0;
        for (const v of variables) {
          for (let t = groups[g].start; t <= groups[g].end; t++) {
            for (const [y, x] of box.tiles) {
              tasks.push(async () => {
                await reader.fetchChunkResult(v.name, [t, 0, y, x]);
                onProgress(++done, total);
              });
            }
          }
        }
        await pooled(tasks, 6);
        return;
      }
      const perVariable = box.depth.length * box.tiles.length;
      const total = variables.length * perVariable;
      for (const [i, v] of variables.entries()) {
        await readBlock(v, g, (done) =>
          onProgress(i * perVariable + done, total),
        );
      }
    },
    onChange: (complete) => {
      onDisk = complete;
      updateBlocks();
    },
  });
  void manager.refresh();

  // Sliders.
  const sliders = $("sliders");
  const lonMin = space.west + space.lonStep / 2;
  const lonMax = space.east - space.lonStep / 2;
  const latMin = box.lat.value[0];
  const latMax = box.lat.value[box.lat.value.length - 1];
  const sliderSpecs: Array<{
    key: keyof Cursor | "time";
    axis: string;
    name: string;
    min: number;
    max: number;
    step: number;
    text: (v: number) => string;
  }> = [
    {
      key: "lon",
      axis: "X",
      name: "LON (°)",
      min: lonMin,
      max: lonMax,
      step: space.lonStep / 2,
      text: (v) => lonLabel(v, lonDigits),
    },
    {
      key: "lat",
      axis: "Y",
      name: "LAT (°)",
      min: latMin,
      max: latMax,
      step: space.latStep,
      text: (v) => latLabel(v, latDigits),
    },
    {
      key: "depth",
      axis: "Z",
      name: "DEPTH (m)",
      min: 0,
      max: bottom,
      step: ctx.display.depthStep ?? 5,
      text: (v) => `${Math.round(v)} m`,
    },
    {
      key: "time",
      axis: "T",
      name: "TIME",
      min: 0,
      max: lastMonth,
      step: 1,
      text: (v) => text(Math.round(v)),
    },
  ];
  const inputs = new Map<
    string,
    {
      input: HTMLInputElement;
      value: HTMLOutputElement;
      text: (v: number) => string;
    }
  >();
  for (const spec of sliderSpecs) {
    const row = document.createElement("label");
    row.className = "slider";
    row.innerHTML = `<span class="axis">${spec.axis}</span><span class="name">${spec.name}</span>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const value = document.createElement("output");
    value.className = "chip";
    row.append(input, value);
    sliders.append(row);
    inputs.set(spec.key, { input, value, text: spec.text });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      if (spec.key === "time") {
        setMonth(Math.round(v));
      } else {
        setCursor({ [spec.key]: v });
      }
    });
  }
  const syncSliders = () => {
    const values: Record<string, number> = {
      ...cursor,
      time: Math.floor(month),
    };
    for (const [key, { input, value, text }] of inputs) {
      if (document.activeElement !== input) {
        input.value = String(values[key]);
      }
      value.textContent = text(values[key]);
    }
  };

  // Slices in 3D.
  const sliceLines = () => {
    const [x] = toWorld(space, cursor.lon, 0, 0);
    const [, y] = toWorld(space, space.west, cursor.lat, 0);
    const [, , z] = toWorld(space, space.west, 0, cursor.depth);
    const [hx, hy, hz] = space.half;
    const batch = new LineBatch();
    const rect = (corners: number[][]) => {
      for (let i = 0; i < 4; i++) {
        batch.segment(corners[i], corners[(i + 1) % 4]);
      }
    };
    rect([
      [x, -hy, -hz],
      [x, hy, -hz],
      [x, hy, hz],
      [x, -hy, hz],
    ]);
    rect([
      [-hx, y, -hz],
      [hx, y, -hz],
      [hx, y, hz],
      [-hx, y, hz],
    ]);
    rect([
      [-hx, -hy, z],
      [hx, -hy, z],
      [hx, hy, z],
      [-hx, hy, z],
    ]);
    renderer.setLines("slices", batch);
    return [x, y, z] as [number, number, number];
  };
  let sliceWorld = sliceLines();

  function setCursor(change: Partial<Cursor>): void {
    Object.assign(cursor, change);
    cursor.lon = Math.min(lonMax, Math.max(lonMin, cursor.lon));
    cursor.lat = Math.min(space.north, Math.max(space.south, cursor.lat));
    cursor.depth = Math.min(bottom, Math.max(0, cursor.depth));
    sliceWorld = sliceLines();
    syncSliders();
    drawPanels();
    writeHash();
    loadCursorSeries();
    requestDraw();
  }

  /** The step, cursors, view preset and mode in the URL: #t=…&x=…&y=…&z=…&v=front&m=a. */
  function writeHash(): void {
    const parts = [
      `t=${timeKey(times[Math.floor(month)], cadence)}`,
      `x=${cursor.lon.toFixed(lonDigits)}`,
      `y=${cursor.lat.toFixed(latDigits + 1)}`,
      `z=${Math.round(cursor.depth)}`,
      ...(preset ? [`v=${preset}`] : []),
      ...(anomalyMode() ? ["m=a"] : []),
      ...(capture ? ["capture"] : []),
    ];
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#${parts.join("&")}`,
    );
  }

  const showTime = (m: number) => {
    $("view-month").textContent = text(m);
    $("time-chip").textContent = `t = ${text(m)}`;
  };

  /** Shows step `m` (integer) once its block is in memory. */
  async function setMonth(m: number): Promise<void> {
    month = Math.max(0, Math.min(lastMonth, m));
    const wanted = Math.floor(month);
    syncSliders();
    timeline.setMonth(month);
    writeHash();
    showTime(wanted);
    if (!cache.has(blockOf(wanted))) {
      if (field) {
        // Scrubbing a field store: read only the step the pointer rests on.
        await new Promise((done) => setTimeout(done, 90));
        if (Math.floor(month) !== wanted) {
          return;
        }
        status(`LOADING ${text(wanted)}`);
      }
      updateBlocks();
      await cache.get(blockOf(wanted));
      updateBlocks();
      if (Math.floor(month) !== wanted) {
        return;
      }
    }
    status(null);
    if (shown !== wanted) {
      current = volumeOf(wanted);
      if (current) {
        outlineFrom(current);
        renderer.setVolume(0, current);
        shown = wanted;
        nextMonth = -1;
        drawPanels();
      }
    }
    prepareNext();
    requestDraw();
  }

  /** Uploads the step after the shown one, if its block is in memory. */
  function prepareNext(): void {
    const next = shown + 1;
    if (next > lastMonth || nextMonth === next) {
      return;
    }
    const volume = volumeOf(next);
    if (volume) {
      // Spread over the next frames: one field per frame (see the loop).
      renderer.setVolume(1, volume, true);
      nextMonth = next;
    } else if (!cache.loading(blockOf(next))) {
      cache.get(blockOf(next)).then(() => {
        updateBlocks();
        prepareNext();
      });
      updateBlocks();
    }
  }

  // Playback.
  const playButton = $("play");
  const setPlaying = (value: boolean) => {
    playing = value && month < lastMonth;
    icon(playButton, playing ? "pause" : "play");
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (playing) {
      prefetch(Math.floor(month));
    } else {
      refreshDisk();
      month = Math.floor(month);
      requestDraw();
    }
  };
  icon($("first"), "first");
  icon($("back"), "back");
  icon($("forward"), "forward");
  icon($("last"), "last");
  setPlaying(false);
  playButton.addEventListener("click", () => setPlaying(!playing));
  $("first").addEventListener("click", () => setMonth(0));
  $("last").addEventListener("click", () => setMonth(lastMonth));
  $("back").addEventListener("click", () => setMonth(Math.floor(month) - 1));
  $("forward").addEventListener("click", () => setMonth(Math.floor(month) + 1));
  const speedSelect = $<HTMLSelectElement>("speed");
  speedSelect.replaceChildren(
    ...speeds.map((option) => {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = option.label;
      node.selected = option.value === speed;
      return node;
    }),
  );
  speedSelect.addEventListener("change", () => {
    speed = Number(speedSelect.value);
  });
  window.addEventListener("keydown", (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      setPlaying(!playing);
    } else if (event.key === "ArrowLeft") {
      setMonth(Math.floor(month) - 1);
    } else if (event.key === "ArrowRight") {
      setMonth(Math.floor(month) + 1);
    }
  });

  // Display toggles: rows without anything to show are hidden.
  const toggles: Array<[string, keyof Show, string | null | undefined]> = [
    ["show-slices", "slices", undefined],
    ["show-iso", "iso", iso ? undefined : null],
    ["show-roi", "roi", overlays.boxesLabel],
    ["show-coast", "coast", overlays.linesLabel],
    ["show-contours", "contours", undefined],
    [
      "show-pois",
      "pois",
      overlays.pois.some((p) => p.marker) ? undefined : null,
    ],
    ["show-particles", "particles", VELOCITY ? undefined : null],
  ];
  for (const [id, key, label] of toggles) {
    const input = $<HTMLInputElement>(id);
    const row = input.closest("label")!;
    if (label === null) {
      row.hidden = true;
      show[key] = false;
      continue;
    }
    if (label) {
      row.querySelector("span")!.textContent = label;
    }
    input.checked = show[key];
    input.addEventListener("change", () => {
      show[key] = input.checked;
      if (key === "particles") {
        renderer.clearTrails();
        reloadStep();
      }
      drawPanels();
      requestDraw();
    });
  }
  /** Shows the step again once the blocks the display needs are read (mode, particles). */
  const reloadStep = () => {
    shown = -1;
    nextMonth = -1;
    void manager.refresh();
    void setMonth(Math.floor(month));
  };
  /** Pace and number of particles: set in the context (display.particles). */
  const flow = particleSpec.flow ?? 1;
  /** Particles simulated; fewer are drawn when the cube is small on screen. */
  const particleCount = particleSpec.count ?? 60000;
  /** Particles drawn per device pixel of the water on screen (as zartigl's particleDensity). */
  const density = particleSpec.density ?? 0.05;
  /** Share of the trails kept each frame: long trails still, short while the camera moves. */
  const trailFade = particleSpec.fade ?? 0.985;
  const MOVING_FADE = 0.8;
  let fadeNow = trailFade;
  let lastViewKey = "";
  /** Share of the cube's surface cells that hold water, from the first step read. */
  let wetShare = -1;
  /** Volume fraction per (m/s · s): metres across the cube east and north. */
  const particleRate: [number, number] = [
    1 /
      ((space.east - space.west) * 111320 * Math.cos((midLat * Math.PI) / 180)),
    1 / ((space.north - space.south) * 111320),
  ];
  /**
   * Model seconds to advance the particles over `seconds` of real time, so the
   * fastest current (speedMax) moves PIXELS_PER_SECOND × flow on screen, at any
   * zoom and playback speed (zartigl's "speed": constant visual speed). The
   * paths are those of the shown currents; only their pace is visual.
   */
  const PIXELS_PER_SECOND = 60;
  const visualSeconds = (f: ReturnType<typeof frame>, seconds: number) => {
    const w = renderer.canvas.width;
    const h = renderer.canvas.height;
    const [hx, hy] = space.half;
    const length = (a: Vec3, b: Vec3) => {
      const [ax, ay] = project(f, a, w, h);
      const [bx, by] = project(f, b, w, h);
      return Math.hypot(bx - ax, by - ay);
    };
    // Device pixels per (m/s · s): the cube's east and north edges on screen.
    const perMetre = Math.max(
      particleRate[0] * length([-hx, 0, 0], [hx, 0, 0]),
      particleRate[1] * length([0, -hy, 0], [0, hy, 0]),
      1e-9,
    );
    return (
      (PIXELS_PER_SECOND * flow * seconds) /
      ((particleSpec.speedMax ?? 0.2) * perMetre)
    );
  };
  let particleFrame = 0;
  const legend = $<HTMLCanvasElement>("legend");
  const drawLegend = () => {
    const [low, high] = domain();
    // A tick every round step, labelled every second one.
    const tick = tickStep(low, high, 10);
    $("legend-title").textContent =
      anomalyMode() && basePeriod
        ? `ANOMALY vs ${basePeriod[0]}–${basePeriod[1]} (${unit})`
        : anomalyMode()
          ? `ANOMALY (${unit})`
          : `COLORMAP (${unit})`;
    const ratio = window.devicePixelRatio || 1;
    const rect = legend.getBoundingClientRect();
    legend.width = Math.round(rect.width * ratio);
    legend.height = Math.round(rect.height * ratio);
    const lctx = legend.getContext("2d")!;
    lctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    lctx.clearRect(0, 0, rect.width, rect.height);
    // A horizontal bar, low on the left, ticks and labels under it.
    const barLeft = 8;
    const barWidth = Math.max(1, rect.width - 16);
    const barTop = 2;
    const barHeight = 10;
    for (let x = 0; x < barWidth; x++) {
      const [r, g, b] = rampColor(ramp, x / barWidth);
      lctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      lctx.fillRect(barLeft + x, barTop, 1, barHeight);
    }
    lctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    lctx.fillStyle = "rgba(235, 237, 240, 0.9)";
    lctx.strokeStyle = "rgba(235, 237, 240, 0.9)";
    lctx.textAlign = "center";
    lctx.textBaseline = "top";
    const first = Math.ceil(low / tick) * tick;
    for (let t = first; t <= high + 1e-9; t += tick) {
      const x = barLeft + ((t - low) / (high - low)) * barWidth;
      const labelled = Math.abs(Math.round(t / tick)) % 2 === 0;
      lctx.beginPath();
      lctx.moveTo(x, barTop + barHeight);
      lctx.lineTo(x, barTop + barHeight + (labelled ? 5 : 3));
      lctx.stroke();
      if (labelled) {
        const value = Math.round(t * 1e6) / 1e6;
        lctx.fillText(
          anomalyMode() && value > 0 ? `+${value}` : String(value),
          x,
          barTop + barHeight + 6,
        );
      }
    }
  };
  /** The palette menu: every palette for the values, the diverging ones for the anomaly. */
  const paletteMenu = new PaletteMenu((id) => {
    if (anomalyMode()) {
      anomalyPalette = id;
    } else {
      palette = id;
    }
    applyRamp();
  });
  $("palettes").replaceChildren(paletteMenu.element);
  /** The ramp of the mode: one chosen for the values, one for the anomaly. */
  const applyRamp = () => {
    const shown = anomalyMode() ? anomalyPalette : palette;
    ramp = rampBytes(shown);
    renderer.setPalette(ramp);
    paletteMenu.set(anomalyMode() ? divergingPalettes : allPalettes, shown);
    drawCursorSeries();
    drawLegend();
    drawPanels();
    requestDraw();
  };
  $("mode-group").hidden = !ANOMALY;
  const modeButtons =
    document.querySelectorAll<HTMLButtonElement>("[data-mode]");
  const pressModes = () => {
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
  };
  /** Switches the shown values; the step is shown again once the blocks it needs are read. */
  const setMode = (next: Mode) => {
    mode = next;
    pressModes();
    describe(anomalyMode());
    applyRamp();
    // The blocks complete on disk depend on the mode's variables.
    reloadStep();
  };
  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.mode !== mode) {
        setMode(button.dataset.mode as Mode);
      }
    });
  }

  // Views.
  const setPreset = (next: Preset, animate = true) => {
    preset = next;
    transition = animate
      ? {
          from: { ...view },
          to: { ...PRESETS[next] },
          start: performance.now(),
        }
      : null;
    if (!animate) {
      view = { ...PRESETS[next] };
    }
    writeHash();
    $("view-name").textContent = PRESET_NAMES[next];
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view]",
    )) {
      button.setAttribute("aria-pressed", String(button.dataset.view === next));
    }
    requestDraw();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-view]",
  )) {
    button.addEventListener("click", () =>
      setPreset(button.dataset.view as Preset),
    );
  }

  // Orbit, zoom and pick.
  const pointers = new Map<number, [number, number]>();
  let pinch = 0;
  const size = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  /** The frame of the view, zoomed out on narrow stages so the box and its labels fit. */
  const fittedFrame = (width: number, height: number) => {
    const aspect = width / height;
    return frame(
      { ...view, zoom: view.zoom * Math.min(1, aspect / 1.15) },
      aspect,
    );
  };
  const freeView = () => {
    transition = null;
    if (preset) {
      preset = null;
      writeHash();
    }
    $("view-name").textContent = "3D FREE";
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-view]",
    )) {
      button.setAttribute("aria-pressed", "false");
    }
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, [event.offsetX, event.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      pick(event.offsetX, event.offsetY);
      return;
    }
    pointers.set(event.pointerId, [event.offsetX, event.offsetY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch > 0) {
        view.zoom = Math.min(4, Math.max(0.3, view.zoom * (distance / pinch)));
      }
      pinch = distance;
    } else {
      if (transition || view.oblique > 0) {
        view = { ...view, oblique: 0 };
      }
      freeView();
      view.yaw += (event.offsetX - previous[0]) * 0.008;
      view.pitch = Math.min(
        Math.PI / 2,
        Math.max(-0.2, view.pitch + (event.offsetY - previous[1]) * 0.008),
      );
    }
    requestDraw();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    pinch = 0;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("dblclick", () => setPreset(startPreset));
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.zoom = Math.min(
        4,
        Math.max(0.3, view.zoom * Math.exp(-event.deltaY * 0.0015)),
      );
      requestDraw();
    },
    { passive: false },
  );

  /** Value under the pointer: the nearest slice plane hit, else the box face. */
  function pick(px: number, py: number): void {
    const { width, height } = size();
    if (!current || !width) {
      return;
    }
    const f = fittedFrame(width, height);
    const origin = unproject(f, px, py, width, height);
    const d = f.ray;
    const [hx, hy, hz] = space.half;
    const half = [hx, hy, hz];
    let near = -Infinity;
    let far = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (Math.abs(origin[i]) > half[i]) {
          near = Infinity;
        }
        continue;
      }
      const t1 = (-half[i] - origin[i]) / d[i];
      const t2 = (half[i] - origin[i]) / d[i];
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
    }
    if (!(near <= far)) {
      $("pick").textContent = "PICK —";
      return;
    }
    let t = near;
    if (show.slices) {
      const hits = [0, 1, 2]
        .map((i) =>
          Math.abs(d[i]) > 1e-9 ? (sliceWorld[i] - origin[i]) / d[i] : Infinity,
        )
        .filter((hit) => hit >= near && hit <= far);
      if (hits.length) {
        t = Math.min(...hits);
      }
    }
    const point = [0, 1, 2].map((i) => origin[i] + d[i] * t);
    const [lon, lat, depth] = fromWorld(space, point);
    const { cols, rows, values, anomaly } = current;
    const c = Math.min(
      cols - 1,
      Math.max(
        0,
        Math.floor(((lon - space.west) / (space.east - space.west)) * cols),
      ),
    );
    const r = Math.min(
      rows - 1,
      Math.max(
        0,
        Math.floor(((lat - space.south) / (space.north - space.south)) * rows),
      ),
    );
    const value = sampleAt(current, values, c, r, depth);
    const departure = anomaly
      ? sampleAt(current, anomaly, c, r, depth)
      : undefined;
    const shownValue = Number.isNaN(value)
      ? (ctx.display.landLabel ?? "no data")
      : departure === undefined || Number.isNaN(departure)
        ? `${value.toFixed(2)} ${unit}`
        : `${departure >= 0 ? "+" : ""}${departure.toFixed(2)} ${unit} (${value.toFixed(2)} ${unit})`;
    $("pick").textContent =
      `PICK ${lonLabel(lon, lonDigits)} · ${latLabel(lat, latDigits)} · ${Math.round(depth)} m · ${shownValue}`;
  }

  // Layout.
  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = size();
    renderer.resize(Math.round(width * ratio), Math.round(height * ratio));
    for (const panel of panels.values()) {
      panel.resize();
    }
    timeline.resize();
    drawLegend();
    requestDraw();
  };
  new ResizeObserver(resize).observe(document.body);

  /** Draws the cube for a frame: the live view or a video frame. */
  /** Particles to draw: the water's share of the cube's screen box, times the density. */
  const drawnCount = (f: ReturnType<typeof frame>) => {
    const w = renderer.canvas.width;
    const h = renderer.canvas.height;
    const [hx, hy, hz] = space.half;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const [x, y] = project(f, [sx * hx, sy * hy, sz * hz], w, h);
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    const area =
      Math.max(0, Math.min(w, x1) - Math.max(0, x0)) *
      Math.max(0, Math.min(h, y1) - Math.max(0, y0));
    return Math.min(
      particleCount,
      Math.max(500, area * Math.max(0.05, wetShare) * density),
    );
  };
  const drawCube = (
    f: ReturnType<typeof frame>,
    mix: number,
    width: number,
    particles: boolean,
    fade: number,
  ) => {
    renderer.render(f, {
      slice: sliceWorld,
      show,
      mix,
      domain: domain(),
      anomaly: anomalyMode(),
      iso: iso?.value ?? 0,
      bottom,
      step: width < MOBILE ? 0.012 : 0.006,
      land: ctx.display.land ?? "solid",
      bed: ctx.display.bed ?? false,
      ...(particles
        ? {
            particles: {
              speedMax: particleSpec.speedMax ?? 0.2,
              drawn: drawnCount(f),
              fade,
              // One CSS pixel: as thin as the trails, crisp at any pixel ratio.
              point: 1,
              depthCue: particleSpec.depthCue ?? 0.3,
              // Color from the scalar through the palette (as projversor), unless set to speed.
              tint: particleSpec.tint !== "speed",
            },
          }
        : {}),
    });
  };

  // Video export: frames rendered on demand at the clip's size.
  let exporting: { view: View } | null = null;
  const videoHost = (): VideoHost => ({
    contextId: ctx.id,
    start: Math.floor(month),
    last: lastMonth,
    text,
    key: (i) => timeKey(times[i], cadence),
    begin: (width, height) => {
      setPlaying(false);
      transition = null;
      exporting = { view: { ...view } };
      renderer.resize(width, height);
    },
    frame: async (m, o) => {
      const whole = Math.max(0, Math.min(lastMonth, Math.floor(m)));
      if (whole === shown + 1 && nextMonth === whole) {
        renderer.swapVolumes();
        shown = whole;
        current = volumeOf(shown);
        nextMonth = -1;
        showTime(shown);
      } else if (whole !== shown) {
        await setMonth(whole);
      }
      if (whole < lastMonth) {
        await cache.get(blockOf(whole + 1));
        prepareNext();
      }
      renderer.flush();
      const mix = nextMonth === whole + 1 ? m - whole : 0;
      month = m;
      timeline.setMonth(m);
      const base = exporting?.view ?? view;
      // Fitted as the live view, a little smaller to leave room for the title and scale.
      const aspect = o.width / o.height;
      const f = frame(
        {
          ...base,
          yaw: base.yaw + o.yaw,
          zoom: base.zoom * Math.min(1, aspect / 1.15) * 0.92,
        },
        aspect,
      );
      const particles = particlesOn() && current?.u !== undefined;
      // Model time per frame: the clip's pace, or the idle drift on a still step.
      const perFrame = visualSeconds(f, 1 / o.fps);
      if (particles) {
        const system = renderer.particles(particleCount);
        if (o.frameIndex === 0) {
          // Every export starts from the same particles: all respawn from seeded picks,
          // then two seconds of flow, trails drawn, so the first frame is already full.
          system.setCount(particleCount);
          renderer.clearTrails();
          for (let k = 0; k < 2 * o.fps; k++) {
            renderer.stepParticles({
              modelSeconds: perFrame,
              realSeconds: 1 / o.fps,
              rate: particleRate,
              mix,
              seed: 100000 + k,
            });
            drawCube(f, mix, o.width, true, trailFade);
          }
        }
        renderer.stepParticles({
          modelSeconds: perFrame,
          realSeconds: 1 / o.fps,
          rate: particleRate,
          mix,
          seed: o.frameIndex,
        });
      }
      // A slow orbit barely moves the trails: the still fade keeps them long.
      drawCube(f, mix, o.width, particles, trailFade);
      lastExportFrame = f;
      return canvas;
    },
    overlay: (width, height) => ({
      title: L(ctx.title),
      subtitle: L(ctx.subtitle),
      credit: L(ctx.credit),
      legendTitle: $("legend-title").textContent ?? "",
      ramp,
      domain: domain(),
      labels: lastExportFrame
        ? overlays.pois
            .filter((p) => p.marker && show.pois)
            .map((p) => {
              const [x, y] = project(
                lastExportFrame!,
                toWorld(space, p.lon, p.lat, 0),
                width,
                height,
              );
              return { text: p.label, x, y };
            })
        : [],
    }),
    end: () => {
      exporting = null;
      resize();
      month = Math.floor(month);
      syncSliders();
      writeHash();
      requestDraw();
    },
  });
  let lastExportFrame: ReturnType<typeof frame> | null = null;
  new VideoExporter($<HTMLButtonElement>("video"), () => videoHost());

  // Loop.
  let last = performance.now();
  let panelsDrawn = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (exporting) {
      requestAnimationFrame(loop);
      return;
    }
    // One queued field of the next step per frame.
    renderer.pump();
    let nextReady = !renderer.uploading;
    if (transition) {
      const t = Math.min(1, (now - transition.start) / 600);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      view = blendViews(transition.from, transition.to, eased);
      if (t >= 1) {
        transition = null;
      }
      dirty = true;
    }
    if (playing) {
      const target = month + dt * speed;
      const whole = Math.floor(month);
      if (Math.floor(target) > whole) {
        if (nextMonth === whole + 1 && nextReady) {
          // The next step becomes the shown one.
          renderer.swapVolumes();
          shown = whole + 1;
          current = volumeOf(shown);
          nextMonth = -1;
          month = Math.min(target, shown + 0.999);
          prepareNext();
          prefetch(shown);
          // Sections at most four times a second while playing.
          if (now - panelsDrawn > 250) {
            panelsDrawn = now;
            drawPanels();
          }
          syncSliders();
          showTime(shown);
          if (
            !field &&
            shown % timeChunk >= timeChunk - 12 &&
            blockOf(shown) + 1 <= blockOf(lastMonth)
          ) {
            cache.get(blockOf(shown) + 1).then(updateBlocks);
          }
          if (shown >= lastMonth) {
            setPlaying(false);
          }
        } else {
          // Wait for the next block.
          month = whole + 0.999;
          prepareNext();
        }
      } else {
        month = target;
      }
      timeline.setMonth(month);
      dirty = true;
    }
    // A swap above may have queued the next step: blend only once it is uploaded.
    nextReady = !renderer.uploading;
    const particles = particlesOn() && current?.u !== undefined;
    if (particles) {
      renderer.particles(particleCount);
      const mix =
        captureMix ??
        (playing && nextReady && nextMonth === Math.floor(month) + 1
          ? month - Math.floor(month)
          : 0);
      if (!capture) {
        const { width: sw, height: sh } = size();
        renderer.stepParticles({
          modelSeconds: visualSeconds(fittedFrame(sw || 1, sh || 1), dt),
          realSeconds: dt,
          rate: particleRate,
          mix,
          seed: particleFrame++,
        });
      }
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      const { width, height } = size();
      if (width > 0 && height > 0) {
        const f = fittedFrame(width, height);
        const mix =
          captureMix ??
          (playing && nextReady && nextMonth === Math.floor(month) + 1
            ? month - Math.floor(month)
            : 0);
        // Trails are screen-space: a camera move fades them fast, then they grow back.
        const viewKey = `${Array.from(f.viewProjection, (v) => v.toFixed(5)).join()}|${sliceWorld.join()}|${renderer.canvas.width}x${renderer.canvas.height}`;
        const moving = viewKey !== lastViewKey;
        lastViewKey = viewKey;
        fadeNow +=
          ((moving ? MOVING_FADE : trailFade) - fadeNow) *
          (moving ? 0.5 : 0.08);
        drawCube(f, mix, width, particles, fadeNow);
        if (labels.update(f, width, height, show)) {
          renderer.setLines("ticks", labels.ticks());
          dirty = true;
        }
      }
    }
    requestAnimationFrame(loop);
  };

  // The context's saved view, then the URL's: #t=…&x=…&y=…&z=…&v=…&m=a.
  const saved: ContextState = ctx.state ?? {};
  if (saved.palette && palettes.includes(saved.palette as PaletteName)) {
    palette = saved.palette as PaletteName;
  }
  for (const [key, value] of Object.entries(saved.show ?? {})) {
    if (key in show && typeof value === "boolean") {
      const input = document.getElementById(
        `show-${key}`,
      ) as HTMLInputElement | null;
      if (input && !input.closest("label")!.hidden) {
        show[key as keyof Show] = value;
        input.checked = value;
      }
    }
  }
  syncSliders();
  updateBlocks();
  resize();
  applyRamp();
  requestAnimationFrame(loop);
  const param = (key: string) =>
    new RegExp(`[#&]${key}=([^&]+)`).exec(location.hash)?.[1];
  // Read everything first: applying the cursors rewrites the hash.
  const sharedTime = param("t") ?? saved.time;
  const sharedPreset = param("v") ?? saved.view;
  if (
    ANOMALY &&
    (param("m") === "a" || (!param("m") && saved.mode === "anomaly"))
  ) {
    mode = "anomaly";
    pressModes();
    describe(true);
    applyRamp();
  }
  const sharedMonth = sharedTime
    ? findTime(times, cadence, decodeURIComponent(sharedTime))
    : -1;
  const sharedCursor: Partial<Cursor> = { ...saved.cursor };
  for (const [key, cursorField] of [
    ["x", "lon"],
    ["y", "lat"],
    ["z", "depth"],
  ] as const) {
    const value = Number(param(key));
    if (param(key) !== undefined && Number.isFinite(value)) {
      sharedCursor[cursorField] = value;
    }
  }
  setCursor(sharedCursor);
  if (sharedPreset && sharedPreset in PRESETS) {
    setPreset(sharedPreset as Preset, false);
  } else {
    setPreset(startPreset, false);
  }

  // Export: the context with the current view.
  picker.setSnapshot((): StrataContext => {
    const { state: _previous, ...rest } = ctx;
    void _previous;
    return {
      ...rest,
      state: {
        time: timeKey(times[Math.floor(month)], cadence),
        cursor: { ...cursor },
        ...(preset ? { view: preset } : {}),
        mode,
        palette,
        show: { ...show },
      },
    };
  });

  await setMonth(sharedMonth >= 0 ? sharedMonth : lastMonth);

  if (capture) {
    /**
     * Shows step `m` of the store's time axis, fractional parts blending into the next
     * step as in playback, and resolves once that frame is drawn.
     */
    const captureFrame = async (m: number) => {
      const whole = Math.max(0, Math.min(lastMonth, Math.floor(m)));
      await setMonth(whole);
      if (whole < lastMonth) {
        await cache.get(blockOf(whole + 1));
        prepareNext();
      }
      renderer.flush();
      captureMix = nextMonth === whole + 1 ? m - whole : 0;
      month = m;
      timeline.setMonth(m);
      requestDraw();
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
    };
    const indexOf = (key: string) => findTime(times, cadence, key);
    Object.assign(window, {
      cubeCapture: { frame: captureFrame, index: indexOf, lastMonth },
    });
  }
}

async function main(): Promise<void> {
  const picker = new ContextPicker({ button: $<HTMLButtonElement>("context") });
  let loaded: LoadedContext;
  try {
    loaded = await loadContext();
  } catch (error) {
    picker.open();
    throw error;
  }
  picker.setCurrent(loaded.request.id);
  await run(loaded, picker);
}

main().catch((error: unknown) => {
  const loading = document.getElementById("loading");
  if (loading) {
    loading.hidden = false;
    loading.textContent = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.error(error);
});
