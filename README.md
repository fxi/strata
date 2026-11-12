# zarcube

4D data cubes from the [zartigl](https://github.com/fxi/zartigl) catalog as
interactive volumes, at [`fxi.io/zarcube`](https://fxi.io/zarcube/). Each cube
is a **context**: a JSON file naming the catalog entries, the extent, display
defaults, reference boxes, GeoJSON and places.

- `/zarcube/` (`enso-nino-3-4`): monthly GODAS ocean temperature of the
  equatorial Pacific (120° E–80° W, 14.5° S–15° N, 0–300 m) since 1980, the
  20 °C isotherm, an anomaly mode against 1991–2020 and a Niño 3.4 timeline;
- `/zarcube/leman-lake`: Lake Geneva every 3 hours since December 2018
  (Alplakes, Eawag), surface to bed, with particles in the currents.

Across contexts:

- slice planes and 2D sections, an isotherm and its depth contours;
- particles advected on the GPU through the eastward and northward currents
  of a vector entry, with the slices as a cut-away corner;
- a DATA panel for the blocks of time steps kept in the browser cache;
- VIDEO: MP4 clips (vertical, square, landscape) rendered frame by frame and
  encoded in the browser (WebCodecs, [mediabunny](https://mediabunny.dev));
- `#t=…` opens a time step; the cursors and view preset are shared in the URL.

## Contexts

`src/public/contexts/index.json` lists the prepared contexts; each one is a
file validated against `src/context/schema.json` (served at
`/zarcube/contexts/schema.json`, see `src/context/types.ts` for the fields).
The CONTEXT button opens them, imports a file (`/zarcube/imported`, kept for
the tab) and exports the current context with its view. `?config=<url>`
opens a context file elsewhere.

A context reads either a point-series store in time blocks (`"store":
"pointSeries"`, GODAS) or a field store with one chunk per time step
(`"store": "field"`, Alplakes). Overlays: `coastline` (Natural Earth),
`mask-outline` (the data's surface cells), `geojson`, `box` and `poi`.
Indicators under the timeline: `box-index` (the Niño 3.4 bars) or
`cursor-series` (the scalar at the cursor, every step, from the
point-series store). Particles are set in `display.particles` (`count`,
`flow`, `speedMax`).

Chunks are read and decoded in a worker; each step goes to the GPU on the
store's own levels (one float texture per field, a static mask, and a depth
table for uneven levels), so playback does no resampling on the CPU.

## Data

The ENSO context reads its store from the GODAS entries of the
[zartigl](https://github.com/fxi/zartigl) catalog (`@fxi/zartigl/catalog`):
five-year blocks of the point-series Zarr store, about 42 MB each, read with
zartigl's `ZarrSource` and kept across sessions by its Cache Storage chunk
store (`@fxi/zartigl/engine`). The conversion of NOAA GODAS to Zarr, its
nightly updates and the catalog entries live in zartigl
(`scripts/to_zarr/noaa/godas`).

GODAS data are provided by the NOAA PSL, Boulder, Colorado, USA, from their
website at https://psl.noaa.gov.

## Development

zartigl is cloned next to this repository; during development
`@fxi/zartigl` resolves to `file:../zartigl`, so rebuild it
(`npm run build:lib` in zartigl) after changing it.

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

## Docker

The image serves the built app with nginx at `/` on port 8080
(`/healthz` for health checks). `.github/workflows/docker.yml` publishes
`ghcr.io/fxi/zarcube` on each push to `main` (`latest`, commit sha) and on
`v*` tags (semver).

```bash
docker compose up --build        # http://localhost:8080/
docker run -p 8080:8080 ghcr.io/fxi/zarcube:latest
```
