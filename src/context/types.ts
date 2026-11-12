/**
 * A strata context: what one cube shows. The data (zartigl catalog entries),
 * the extent in space and depth, display defaults, reference boxes, GeoJSON
 * and points of interest, and the text around the cube. Validated against
 * `schema.json`; see `contexts/*.json` for examples.
 */

export type Localized = string | Record<string, string>;

export interface ScalarData {
  /** Catalog entry: uuid or alias. */
  entry: string;
  variable: string;
  /** Departure from a climatology, read from the same store. */
  anomaly?: {
    entry?: string;
    variable: string;
    domain: [number, number];
    /** Base period of the climatology, for labels. */
    basePeriod?: [number, number];
    subtitle?: Localized;
  };
}

export interface VectorData {
  entry: string;
  u: string;
  v: string;
}

/** `pointSeries`: geo-chunked store read in time blocks; `field`: one chunk per time step holds the volume. */
export type StoreLayout = "pointSeries" | "field";

export interface BoxOverlay {
  type: "box";
  id: string;
  label?: Localized;
  west: number;
  east: number;
  south: number;
  north: number;
  /** Top and bottom depth, metres; the cube's depth by default. */
  depth?: [number, number];
}

export interface PoiOverlay {
  type: "poi";
  label: Localized;
  lon: number;
  lat: number;
  /** A vertical line from the surface down to this depth, metres. */
  drop?: number;
  /** Text only, without a marker (region names). */
  marker?: boolean;
  /** Shown only when the cube's top face is visible. */
  onTop?: boolean;
}

export interface GeoJsonOverlay {
  type: "geojson";
  id: string;
  label?: Localized;
  /** Relative to the context file, or absolute. */
  url?: string;
  data?: GeoJSON.GeoJSON;
}

/** Built-in coastlines (Natural Earth 1:50m land). */
export interface CoastOverlay {
  type: "coastline";
  label?: Localized;
}

/** Outline of the data's valid cells at the surface (lake shore, coasts at the grid's resolution). */
export interface MaskOutlineOverlay {
  type: "mask-outline";
  label?: Localized;
}

export type Overlay =
  | BoxOverlay
  | PoiOverlay
  | GeoJsonOverlay
  | CoastOverlay
  | MaskOutlineOverlay;

/** The Niño 3.4 style index of a box: cos-weighted surface mean, anomaly, 3-month mean. */
export interface BoxIndexIndicator {
  type: "box-index";
  box: string;
  basePeriod: [number, number];
  label?: Localized;
}

/** The scalar at the cursor's longitude, latitude and depth, every step, from the point-series store. */
export interface CursorSeriesIndicator {
  type: "cursor-series";
  label?: Localized;
}

export type Indicator = BoxIndexIndicator | CursorSeriesIndicator;

export interface SpeedOption {
  /** Time steps per second. */
  value: number;
  label: string;
}

/** View state, as in the URL hash; exported with a context. */
export interface ContextState {
  time?: string;
  cursor?: { lon?: number; lat?: number; depth?: number };
  view?: string;
  mode?: "absolute" | "anomaly";
  palette?: string;
  show?: Partial<Record<string, boolean>>;
}

export interface StrataContext {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  title: Localized;
  subtitle?: Localized;
  provider?: Localized;
  description?: Localized;
  /** Bar heading above the cube. */
  heading?: Localized;
  credit?: Localized;
  data: {
    store: StoreLayout;
    scalar: ScalarData;
    vector?: VectorData;
  };
  extent: {
    west: number;
    east: number;
    south: number;
    north: number;
    /** Depth of the cube's bottom, metres. */
    bottom: number;
    /** Longitudes east of 0 (0–360), for boxes across the date line. */
    lonWrap?: boolean;
  };
  space?: {
    /** Latitude stretch against longitude. */
    latStretch?: number;
  };
  time?: {
    speeds?: SpeedOption[];
    /** Index in `speeds` selected at start. */
    speed?: number;
  };
  display: {
    domain: [number, number];
    palettes?: string[];
    palette?: string;
    unit?: string;
    iso?: { value: number; step?: number; label?: Localized };
    /** Cells without data: drawn as dark land, or left clear (lakes). */
    land?: "solid" | "clear";
    /** Shade the boundary of the data (lake bed, sea floor). */
    bed?: boolean;
    cursor?: { lon: number; lat: number; depth: number };
    view?: string;
    depthStep?: number;
    /** Pick text over cells without data. */
    landLabel?: string;
    /** Particles of the vector field. */
    particles?: {
      /** On at start. */
      show?: boolean;
      count?: number;
      /** Visual pace: the fastest current moves 60 × flow device pixels a second (1 by default). */
      flow?: number;
      /** Particles drawn per device pixel of water on screen (0.05 by default). */
      density?: number;
      /** Share of the trails kept each frame, 0–1 (0.985 by default). */
      fade?: number;
      /** Alpha left at the far side of the cube from the viewer, 0–1 (0.3 by default). */
      depthCue?: number;
      /** Color: the shown scalar through the palette (default), or the speed. */
      tint?: "scalar" | "speed";
      /** m/s at the top of the speed colors. */
      speedMax?: number;
      /** Time steps of motion per second while paused. */
      idleSteps?: number;
    };
  };
  /** Header facts; computed from the store when missing. */
  facts?: { dataset?: Localized; grid?: Localized; region?: Localized };
  /** Left panel: a short note on the place. */
  panel?: { title: Localized; note?: Localized; detail?: Localized };
  overlays?: Overlay[];
  indicators?: Indicator[];
  state?: ContextState;
}

/** An entry of `contexts/index.json`. */
export interface ContextListing {
  id: string;
  title: Localized;
  description?: Localized;
  file: string;
}
