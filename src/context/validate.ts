/**
 * A small JSON Schema validator for the subset `schema.json` uses: type,
 * required, properties, additionalProperties, items, min/maxItems, enum,
 * const, minimum, maximum, pattern, oneOf and local $ref. A `discriminator`
 * keyword on a oneOf picks the branch by that property, so errors name the
 * branch's fields rather than every branch failing.
 */

import schema from "./schema.json";
import type { StrataContext } from "./types";

type Schema = Record<string, unknown>;

export interface SchemaError {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return typeOf(value) === type;
}

export function validateWith(root: Schema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  const resolve = (node: Schema): Schema => {
    const ref = node.$ref as string | undefined;
    if (!ref) {
      return node;
    }
    const parts = ref.replace(/^#\//, "").split("/");
    let target: unknown = root;
    for (const part of parts) {
      target = (target as Record<string, unknown>)[part];
    }
    if (!target) {
      throw new Error(`Unresolved schema reference ${ref}`);
    }
    return resolve(target as Schema);
  };

  const check = (node: Schema, data: unknown, path: string): void => {
    const s = resolve(node);
    const fail = (message: string) =>
      errors.push({ path: path || "/", message });
    if ("const" in s && data !== s.const) {
      fail(`must be ${JSON.stringify(s.const)}`);
      return;
    }
    if (Array.isArray(s.enum) && !s.enum.includes(data as never)) {
      fail(`must be one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}`);
      return;
    }
    if (typeof s.type === "string" && !matchesType(data, s.type)) {
      fail(`must be ${s.type === "integer" ? "an integer" : `a ${s.type}`}`);
      return;
    }
    if (Array.isArray(s.oneOf)) {
      const branches = s.oneOf as Schema[];
      const key = s.discriminator as string | undefined;
      if (key && typeOf(data) === "object") {
        const tag = (data as Record<string, unknown>)[key];
        const branch = branches.find((b) => {
          const prop = (resolve(b).properties as Schema | undefined)?.[key] as
            | Schema
            | undefined;
          return prop?.const === tag;
        });
        if (!branch) {
          const tags = branches.map(
            (b) =>
              ((resolve(b).properties as Schema)[key] as Schema)
                .const as string,
          );
          errors.push({
            path: `${path}/${key}`,
            message: `must be one of ${tags.map((t) => JSON.stringify(t)).join(", ")}`,
          });
          return;
        }
        check(branch, data, path);
        return;
      }
      const passing = branches.filter((branch) => passes(branch, data));
      if (passing.length !== 1) {
        fail(
          passing.length
            ? "matches more than one allowed shape"
            : "does not match any allowed shape",
        );
      }
      return;
    }
    if (typeof data === "number") {
      if (typeof s.minimum === "number" && data < s.minimum) {
        fail(`must be ≥ ${s.minimum}`);
      }
      if (typeof s.maximum === "number" && data > s.maximum) {
        fail(`must be ≤ ${s.maximum}`);
      }
    }
    if (typeof data === "string" && typeof s.pattern === "string") {
      if (!new RegExp(s.pattern).test(data)) {
        fail(`must match ${s.pattern}`);
      }
    }
    if (Array.isArray(data)) {
      if (typeof s.minItems === "number" && data.length < s.minItems) {
        fail(`must have at least ${s.minItems} items`);
      }
      if (typeof s.maxItems === "number" && data.length > s.maxItems) {
        fail(`must have at most ${s.maxItems} items`);
      }
      if (s.items) {
        data.forEach((item, i) =>
          check(s.items as Schema, item, `${path}/${i}`),
        );
      }
    }
    if (typeOf(data) === "object") {
      const object = data as Record<string, unknown>;
      for (const key of (s.required as string[] | undefined) ?? []) {
        if (!(key in object)) {
          errors.push({ path: `${path}/${key}`, message: "is required" });
        }
      }
      const properties = (s.properties as Record<string, Schema>) ?? {};
      for (const [key, item] of Object.entries(object)) {
        if (key in properties) {
          check(properties[key], item, `${path}/${key}`);
        } else if (s.additionalProperties === false) {
          errors.push({ path: `${path}/${key}`, message: "is not allowed" });
        } else if (typeOf(s.additionalProperties) === "object") {
          check(s.additionalProperties as Schema, item, `${path}/${key}`);
        }
      }
    }
  };

  const passes = (node: Schema, data: unknown): boolean => {
    const before = errors.length;
    check(node, data, "");
    const ok = errors.length === before;
    errors.length = before;
    return ok;
  };

  check(root, value, "");
  return errors;
}

/** Errors of a context against the schema, also checking cross references. */
export function validateContext(value: unknown): SchemaError[] {
  const errors = validateWith(schema as Schema, value);
  if (errors.length) {
    return errors;
  }
  const context = value as StrataContext;
  const { extent } = context;
  if (extent.west >= extent.east) {
    errors.push({ path: "/extent/east", message: "must be east of west" });
  }
  if (extent.south >= extent.north) {
    errors.push({ path: "/extent/north", message: "must be north of south" });
  }
  if (context.display.domain[0] >= context.display.domain[1]) {
    errors.push({ path: "/display/domain", message: "must be increasing" });
  }
  const boxes = new Set(
    (context.overlays ?? []).flatMap((o) => (o.type === "box" ? [o.id] : [])),
  );
  (context.indicators ?? []).forEach((indicator, i) => {
    if (indicator.type === "box-index" && !boxes.has(indicator.box)) {
      errors.push({
        path: `/indicators/${i}/box`,
        message: `names no box overlay (${[...boxes].join(", ") || "none"})`,
      });
    }
  });
  (context.overlays ?? []).forEach((overlay, i) => {
    if (overlay.type === "geojson" && !overlay.url && !overlay.data) {
      errors.push({
        path: `/overlays/${i}`,
        message: "needs a url or inline data",
      });
    }
  });
  return errors;
}

export function formatErrors(errors: SchemaError[]): string {
  return errors.map((e) => `${e.path} ${e.message}`).join("\n");
}
