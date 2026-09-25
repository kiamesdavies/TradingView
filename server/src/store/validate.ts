// Input validation helpers shared by S2 routes (store, alerts) and the realtime hub.
// Every validator throws HttpError(400, message) so route handlers can simply call them.
import { HttpError } from "../http";
import type { Symbol } from "@eodview/shared";

const SYMBOL_RE = /^[A-Z0-9^][A-Z0-9._\-&^=+]{0,39}\.[A-Z0-9]{1,12}$/;

/** Canonical form (trimmed, upper-case) or null when the string is not a `TICKER.EXCHANGE` symbol. */
export function normalizeSymbol(v: unknown): Symbol | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

export function bad(message: string): never {
  throw new HttpError(400, message);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function requireObject(v: unknown, what = "body"): Record<string, unknown> {
  if (!isObject(v)) bad(`${what} must be a JSON object`);
  return v;
}

export function requireSymbol(v: unknown, field = "symbol"): Symbol {
  const s = normalizeSymbol(v);
  if (!s) bad(`${field} must be an EODHD symbol like AAPL.US (got ${JSON.stringify(v)?.slice(0, 60) ?? "undefined"})`);
  return s;
}

export function requireSymbols(v: unknown, field: string, max: number): Symbol[] {
  if (!Array.isArray(v)) bad(`${field} must be an array of symbols`);
  if (v.length > max) bad(`${field} may contain at most ${max} symbols`);
  const out: Symbol[] = [];
  const seen = new Set<Symbol>();
  v.forEach((x, i) => {
    const s = requireSymbol(x, `${field}[${i}]`);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  });
  return out;
}

export function requireFinite(v: unknown, field: string, opts: { min?: number; max?: number; positive?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${field} must be a finite number`);
  if (opts.positive && v <= 0) bad(`${field} must be > 0`);
  if (opts.min !== undefined && v < opts.min) bad(`${field} must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) bad(`${field} must be <= ${opts.max}`);
  return v;
}

export function requireBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") bad(`${field} must be a boolean`);
  return v;
}

export function requireString(v: unknown, field: string, opts: { min?: number; max: number; trim?: boolean }): string {
  if (typeof v !== "string") bad(`${field} must be a string`);
  const s = opts.trim === false ? v : v.trim();
  if (s.length < (opts.min ?? 0)) bad(opts.min === 1 ? `${field} must not be empty` : `${field} must be at least ${opts.min} characters`);
  if (s.length > opts.max) bad(`${field} must be at most ${opts.max} characters`);
  return s;
}

export function optionalString(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = requireString(v, field, { max });
  return s === "" ? undefined : s;
}

export function requireEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) bad(`${field} must be one of ${allowed.join(", ")}`);
  return v as T;
}

/** Parse a positive integer query parameter with default and clamp. */
export function intParam(raw: string | null, field: string, def: number, min: number, max: number): number {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) bad(`${field} must be an integer`);
  return Math.min(max, Math.max(min, n));
}
