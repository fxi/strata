/**
 * Which context to open and loading it:
 * - `/strata/<id>`: a context of `contexts/index.json`;
 * - `?ctx=<id>`: the same, for hosts without path fallback;
 * - `?config=<url>`: a context file elsewhere (validated the same way);
 * - `/strata/imported`: the file last imported in this tab (session storage);
 * - otherwise the first context of the index.
 */

import { formatErrors, validateContext } from "./validate";
import type { ContextListing, Localized, StrataContext } from "./types";

export const DEFAULT_CONTEXT = "enso-nino-3-4";
export const IMPORTED = "imported";
const IMPORT_KEY = "strata:imported-context";

const base = () => import.meta.env.BASE_URL;
/** Absolute URL of the bundled contexts folder. */
export const contextsUrl = () =>
  new URL(`${base()}contexts/`, location.href).href;

export function localize(text: Localized | undefined, locale = "en"): string {
  if (text === undefined) {
    return "";
  }
  if (typeof text === "string") {
    return text;
  }
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? "";
}

export class ContextError extends Error {}

export interface ContextRequest {
  kind: "listed" | "url" | "imported";
  id: string;
  url?: string;
}

/** The context the page's URL asks for. */
export function requestedContext(
  loc: Location = location,
  root: string = base(),
): ContextRequest {
  const params = new URLSearchParams(loc.search);
  const config = params.get("config");
  if (config) {
    return { kind: "url", id: config, url: config };
  }
  const path = loc.pathname.startsWith(root)
    ? loc.pathname.slice(root.length)
    : loc.pathname.replace(/^\//, "");
  const segment = decodeURIComponent(path.split("/").filter(Boolean)[0] ?? "");
  const id = params.get("ctx") || (segment === "index.html" ? "" : segment);
  if (id === IMPORTED) {
    return { kind: "imported", id };
  }
  return { kind: "listed", id: id || DEFAULT_CONTEXT };
}

/** Page URL of a listed context (hash state is per context, so dropped). */
export function contextHref(id: string): string {
  return `${base()}${id === DEFAULT_CONTEXT ? "" : encodeURIComponent(id)}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ContextError(`${url}: HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ContextError(`${url} is not JSON`);
  }
}

export async function listContexts(): Promise<ContextListing[]> {
  return (await fetchJson(`${contextsUrl()}index.json`)) as ContextListing[];
}

/** Validates parsed JSON as a context, or throws the schema errors. */
export function parseContext(value: unknown, origin: string): StrataContext {
  const errors = validateContext(value);
  if (errors.length) {
    throw new ContextError(
      `${origin} is not a valid strata context:\n${formatErrors(errors)}`,
    );
  }
  return value as StrataContext;
}

export interface LoadedContext {
  context: StrataContext;
  /** Base for relative URLs inside the context (GeoJSON). */
  baseUrl: string;
  request: ContextRequest;
}

export async function loadContext(
  request: ContextRequest = requestedContext(),
): Promise<LoadedContext> {
  if (request.kind === "imported") {
    let text: string | null = null;
    try {
      text = sessionStorage.getItem(IMPORT_KEY);
    } catch {
      // Storage blocked: nothing was imported.
    }
    if (!text) {
      throw new ContextError(
        "No imported context in this tab: import a file from the context menu.",
      );
    }
    return {
      context: parseContext(JSON.parse(text), "The imported file"),
      baseUrl: contextsUrl(),
      request,
    };
  }
  if (request.kind === "url") {
    const url = new URL(request.url!, location.href).href;
    return {
      context: parseContext(await fetchJson(url), url),
      baseUrl: url,
      request,
    };
  }
  const listing = (await listContexts()).find((c) => c.id === request.id);
  if (!listing) {
    throw new ContextError(`Unknown context "${request.id}"`);
  }
  const url = new URL(listing.file, contextsUrl()).href;
  return {
    context: parseContext(await fetchJson(url), listing.file),
    baseUrl: url,
    request,
  };
}

/** Keeps an imported context for this tab, to open it at `/strata/imported`. */
export function storeImported(context: StrataContext): void {
  sessionStorage.setItem(IMPORT_KEY, JSON.stringify(context));
}
