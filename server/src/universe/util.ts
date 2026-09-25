// Small pure helpers shared by the universe pipeline (number parsing, percentages, dates).

/** Defensive number parse: EODHD sends numbers, numeric strings, "NA", "None", "", null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || /^(na|n\/a|none|null|nan|-)$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Positive number or null (for denominators / values where <= 0 is meaningless). */
export function pos(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

export function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && !/^(na|n\/a|none|null)$/i.test(s) ? s : null;
}

/** a / b, null when either is missing or b is 0. */
export function div(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

/** Percent change a vs base b. Negative bases use |b| so a move from -2 to -1 reads +50%. */
export function pctChange(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  const r = ((a - b) / Math.abs(b)) * 100;
  return Number.isFinite(r) ? r : null;
}

/** Compound annual growth in % over `years`; needs both ends positive. */
export function cagr(end: number | null, start: number | null, years: number): number | null {
  if (end === null || start === null || end <= 0 || start <= 0 || years <= 0) return null;
  const r = (Math.pow(end / start, 1 / years) - 1) * 100;
  return Number.isFinite(r) ? r : null;
}

export function times100(v: number | null): number | null {
  return v === null ? null : v * 100;
}

export function round(v: number | null, digits = 6): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** EODHD objects keyed "0","1",… or arrays → array of values. */
export function values<T = any>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") return Object.values(v as Record<string, T>);
  return [];
}

/** "YYYY-MM-DD" ± days (UTC calendar arithmetic). */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

export function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith("0000") ? s.slice(0, 10) : null;
}

export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
