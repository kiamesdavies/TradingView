// Pure formatting for screener cells, chips and custom-range inputs. Covered by format.test.ts.
import type { ScreenerColumnDef, ScreenerFilterDef, ScreenerFilterValue, StatFormat, UniverseStatus } from "@eodview/shared";
import { isCustom } from "./queryState";

export const NA = "-";
export type CustomUnit = NonNullable<ScreenerFilterDef["custom"]>["unit"];
export type CellValue = number | string | null | undefined;

const UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/** 2036000000 -> "2.04B", 7730000 -> "7.73M", 950 -> "950". */
export function compactNumber(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return NA;
  const abs = Math.abs(v);
  for (const [n, u] of UNITS) {
    if (abs >= n) return `${(v / n).toFixed(decimals)}${u}`;
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(decimals);
}

/** 11020 -> "11,020". */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : NA;
}

function fixed(v: number, d = 2): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Columns whose values are a per-share price (never compacted). */
function isPriceLike(id: string): boolean {
  return /(^|_)(price|open|prev_close|sma\d+|target_price|atr14|eps_ttm|high|low)$/.test(id) || id === "price";
}

/** Percent columns coloured green/red (Finviz colours change and performance). */
export function isTonedColumn(id: string): boolean {
  return /^(change|change_pct|change_from_open_pct|gap_pct|perf_|target_upside_pct|eps_surprise_pct|sma\d+_pct|sma\d+_vs_)/.test(id);
}

function toNumber(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && /^-?[\d.]+(e[+-]?\d+)?$/i.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function unixToDate(n: number): string {
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? NA : d.toISOString().slice(0, 10);
}

export function formatValue(value: CellValue, format: StatFormat, columnId = ""): string {
  if (value === null || value === undefined || value === "") return NA;
  if (format === "text") return String(value);
  if (format === "date") {
    if (typeof value === "number") return value > 1e8 ? unixToDate(value) : String(value);
    return value;
  }
  const n = toNumber(value);
  if (n === null) return String(value);
  switch (format) {
    case "money":
      if (isPriceLike(columnId) || Math.abs(n) < 1e5) return fixed(n);
      return compactNumber(n);
    case "volume":
      return compactNumber(n);
    case "pct":
      return `${fixed(n)}%`;
    case "ratio":
    case "days":
      return fixed(n);
    case "number":
    default:
      if (Number.isInteger(n)) return Math.abs(n) >= 1e7 ? compactNumber(n) : n.toLocaleString("en-US");
      return fixed(n);
  }
}

export function formatCell(value: CellValue, col: Pick<ScreenerColumnDef, "id" | "format">): string {
  return formatValue(value, col.format, col.id);
}

/** CSS tone for a cell: "up" / "down" for signed change/performance columns, "" otherwise. */
export function cellTone(value: CellValue, col: Pick<ScreenerColumnDef, "id" | "format">): "up" | "down" | "" {
  if (!isTonedColumn(col.id)) return "";
  const n = toNumber(value);
  if (n === null || n === 0) return "";
  return n > 0 ? "up" : "down";
}

// ---------------- custom ranges ----------------

/**
 * Parse a user-typed custom bound. "" -> undefined (open bound); invalid -> null.
 * number/money/volume accept K/M/B/T suffixes ("2B", "500k"); pct accepts a trailing "%"; date is YYYY-MM-DD.
 */
export function parseCustomBound(text: string, unit: CustomUnit): number | string | undefined | null {
  const t = text.trim();
  if (t === "") return undefined;
  if (unit === "date") return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([kmbt%]?)$/i.exec(t.replace(/[,_\s]/g, ""));
  if (!m) return null;
  const n = Number(m[1]);
  const suf = m[2].toLowerCase();
  if (suf === "%") return unit === "pct" ? n : null;
  const mult = suf === "k" ? 1e3 : suf === "m" ? 1e6 : suf === "b" ? 1e9 : suf === "t" ? 1e12 : 1;
  if (mult !== 1 && unit === "pct") return null;
  const v = n * mult;
  return Number.isFinite(v) ? v : null;
}

export function formatCustomBound(v: number | string | undefined, unit: CustomUnit): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "string") return v;
  if (unit === "pct") return `${v}%`;
  if (unit === "money" || unit === "volume") return Math.abs(v) >= 1e3 ? compactNumber(v).replace(/\.?0+([KMBT])$/, "$1") : String(v);
  return String(v);
}

/** "5 to 20", "Over 10%", "Under 2B". */
export function formatCustomRange(min: number | string | undefined, max: number | string | undefined, unit: CustomUnit): string {
  const a = formatCustomBound(min, unit);
  const b = formatCustomBound(max, unit);
  if (a && b) return `${a} to ${b}`;
  if (a) return unit === "date" ? `After ${a}` : `Over ${a}`;
  if (b) return unit === "date" ? `Before ${b}` : `Under ${b}`;
  return "Any";
}

/** Label shown in the select / chip for a filter value. */
export function filterValueLabel(def: ScreenerFilterDef | undefined, v: ScreenerFilterValue): string {
  if (isCustom(v)) return formatCustomRange(v.min, v.max, def?.custom?.unit ?? "number");
  return def?.options.find((o) => o.value === v.value)?.label ?? v.value;
}

// ---------------- status line ----------------

/** Denominator for "fundamentals x/y": every active symbol gets fundamentals eventually. (The fundamentals job's
 *  progress text is per slice, e.g. "24/80 this slice", so it is not a universe total.) */
export function fundamentalsTotal(u: UniverseStatus): number | null {
  return u.symbols > 0 ? u.symbols : null;
}

export const BUILD_JOBS = ["symbols", "prices", "backfill"];

/** True while the price universe is still being assembled (drives the progress banner and status polling). */
export function isUniverseBuilding(u: UniverseStatus | null | undefined): boolean {
  if (!u) return false;
  if (u.jobs.some((j) => BUILD_JOBS.includes(j.name) && j.state === "running")) return true;
  if (u.symbols === 0) return u.jobs.some((j) => j.state === "running");
  return u.withPrices < Math.min(500, u.symbols * 0.5);
}

export function resultRangeText(total: number, offset: number, rows: number): string {
  if (total <= 0 || rows <= 0) return "#0";
  return `#${formatInt(offset + 1)}–${formatInt(offset + rows)}`;
}
