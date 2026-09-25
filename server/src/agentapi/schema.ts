// Minimal JSON Schema subset validator for MCP tool arguments (type, enum, min/max, required, properties,
// additionalProperties:false, items, oneOf). Returns the first error message, or null.
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  maxItems?: number;
  oneOf?: readonly JsonSchema[];
  examples?: readonly unknown[];
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

export function validate(v: unknown, s: JsonSchema, path = "arguments"): string | null {
  if (s.oneOf) {
    for (const alt of s.oneOf) if (validate(v, alt, path) === null) return null;
    return `${path}: does not match any allowed form`;
  }
  if (s.type) {
    const t = typeOf(v);
    const ok = t === s.type || (s.type === "number" && t === "integer");
    if (!ok) return `${path}: expected ${s.type}, got ${t}`;
  }
  if (s.enum && !s.enum.includes(v as string | number)) return `${path}: must be one of ${s.enum.join(", ")}`;
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) return `${path}: must be >= ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${path}: must be <= ${s.maximum}`;
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) return `${path}: must have at least ${s.minLength} characters`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${path}: must have at most ${s.maxLength} characters`;
  }
  if (Array.isArray(v)) {
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${path}: at most ${s.maxItems} items`;
    if (s.items) for (let i = 0; i < v.length; i++) {
      const e = validate(v[i], s.items, `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (s.type === "object" && typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (o[r] === undefined) return `${path}.${r}: required`;
    for (const [k, val] of Object.entries(o)) {
      const ps = s.properties?.[k];
      if (!ps) {
        if (s.additionalProperties === false) return `${path}: unknown property "${k.slice(0, 40)}"`;
        continue;
      }
      if (val === undefined) continue;
      const e = validate(val, ps, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}
