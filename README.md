# strata

Pacific Thermocline Data-Cube: the monthly GODAS ocean temperature of the
equatorial Pacific (120° E–80° W, 14.5° S–15° N, 0–300 m) since 1980 as an
interactive 3D volume, at [`fxi.io/strata`](https://fxi.io/strata/).

- slice planes and 2D sections;
- the 20 °C isotherm (thermocline depth) and its depth contours;
- an anomaly mode against 1991–2020 (`pottmp_anom`);
- a Niño 3.4 timeline with El Niño and La Niña episodes;
- a DATA panel for the five-year blocks kept in the browser cache.

`#t=YYYY-MM` opens a month; the cursors and view preset are shared in the URL.

## Data

strata reads its store from the GODAS entries of the
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
`ghcr.io/fxi/strata` on each push to `main` (`latest`, commit sha) and on
`v*` tags (semver).

```bash
docker compose up --build        # http://localhost:8080/
docker run -p 8080:8080 ghcr.io/fxi/strata:latest
```
