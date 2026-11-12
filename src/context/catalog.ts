/**
 * Catalog entries of a context, by uuid or alias, from the live zartigl
 * catalog (entries added since this build) or the bundled one.
 */

import {
  loadCatalog,
  type Catalog,
  type CatalogEntry,
} from "@fxi/zartigl/catalog";
import type { StoreLayout } from "./types";

let pending: Promise<Catalog> | null = null;

export function currentCatalog(): Promise<Catalog> {
  pending ??= loadCatalog(undefined, { timeoutMs: 4000 }).then(
    (loaded) => loaded.catalog,
  );
  return pending;
}

export function findEntry(catalog: Catalog, ref: string): CatalogEntry {
  const entry = catalog.layers.find(
    (layer) => layer.id === ref || (layer.aliases ?? []).includes(ref),
  );
  if (!entry) {
    throw new Error(`Unknown zartigl catalog entry: ${ref}`);
  }
  return entry;
}

/** The entry's Zarr store for a layout: point-series (geo-chunked) or field (time-chunked). */
export function storeUrl(entry: CatalogEntry, layout: StoreLayout): string {
  for (const source of entry.sources) {
    if (source.type === "zarr" && "endpoints" in source) {
      const url =
        layout === "pointSeries"
          ? source.endpoints.pointSeries
          : source.endpoints.field;
      if (url) {
        return url;
      }
    }
  }
  throw new Error(`${entry.id} has no ${layout} Zarr store`);
}
