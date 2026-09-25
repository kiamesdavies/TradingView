// Pure helpers for the app shell (formatting, quote math, layout sanitising). Covered by format.test.ts.
import { TIMEFRAMES } from "@eodview/shared";
import type { ChartType, IndicatorConfig, Layout, Quote, Symbol, Timeframe } from "@eodview/shared";
import { sessionDayStart, sessionTimeZone } from "../chart/candles";

const DASH = "—";

/** Decimal places suited to an instrument / magnitude. */
export function priceDecimals(price: number, symbol?: Symbol): number {
  const abs = Math.abs(price);
  if (symbol?.toUpperCase().endsWith(".FOREX")) return abs >= 20 ? 3 : 5;
  if (abs === 0) return 2;
  if (abs < 0.01) return 6;
  if (abs < 1) return 4;
  return 2;
}

export function formatPrice(price: number | undefined, symbol?: Symbol): string {
  if (price === undefined || !Number.isFinite(price)) return DASH;
  const d = priceDecimals(price, symbol);
  return price.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatChange(change: number | undefined, symbol?: Symbol, refPrice?: number): string {
  if (change === undefined || !Number.isFinite(change)) return DASH;
  const d = priceDecimals(refPrice ?? change, symbol);
  const s = Math.abs(change).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${change > 0 ? "+" : change < 0 ? "−" : ""}${s}`;
}

export function formatPct(pct: number | undefined): string {
  if (pct === undefined || !Number.isFinite(pct)) return DASH;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(2)}%`;
}

export function formatVolume(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return DASH;
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [n, u] of units) {
    if (v >= n) {
      const x = v / n;
      return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}${u}`;
    }
  }
  return String(Math.round(v));
}

/** "up" / "down" / "flat" for colouring. Non-finite -> flat. */
export function direction(change: number | undefined): "up" | "down" | "flat" {
  if (change === undefined || !Number.isFinite(change) || change === 0) return "flat";
  return change > 0 ? "up" : "down";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Alert history timestamps: "14:32:05" today, "Sep 24 14:32" this year, else "2025-09-24 14:32" (local time). */
export function formatEventTime(unixSec: number, now: Date = new Date()): string {
  const d = new Date(unixSec * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `${hm}:${pad(d.getSeconds())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${hm}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** "5s ago", "3m ago", "2h ago", "4d ago". */
export function formatAgo(unixSec: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Fold a streamed price into the quote snapshot. `volumeAdd` is the summed trade size since the last fold.
 * Without a known quote the change fields stay NaN (rendered as a dash) until a real quote arrives.
 * When the tick falls on a later session date than the quote (a long-lived tab crossing midnight UTC, or the
 * New York date for US symbols), the day's volume restarts and the last known price becomes the reference close
 * until the next /api/quotes refresh supplies the official one.
 */
export function applyTickToQuote(prev: Quote | undefined, symbol: Symbol, price: number, volumeAdd: number, timeMs: number): Quote {
  const timeSec = Math.floor(timeMs / 1000);
  const add = Number.isFinite(volumeAdd) ? volumeAdd : 0;
  const tz = sessionTimeZone(symbol);
  const newDay = !!prev && prev.time > 0 && sessionDayStart(timeSec, tz) > sessionDayStart(prev.time, tz);
  let prevClose = prev?.prevClose ?? Number.NaN;
  if (newDay && Number.isFinite(prev!.price) && prev!.price > 0) prevClose = prev!.price;
  const hasPrev = Number.isFinite(prevClose) && prevClose !== 0;
  const change = hasPrev ? price - prevClose : Number.NaN;
  return {
    symbol,
    price,
    prevClose,
    change,
    changePct: hasPrev ? (change / prevClose) * 100 : Number.NaN,
    volume: (newDay ? 0 : prev?.volume ?? 0) + add,
    time: timeSec,
  };
}

/** Move `from` to position `to` (index in the resulting array). Out-of-range -> unchanged copy. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

export const TF_LABELS: Record<Timeframe, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "D", "1W": "W", "1M": "M",
};

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "candles", label: "Candles" },
  { value: "bars", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "heikin", label: "Heikin Ashi" },
];

const CHART_TYPE_SET = new Set<string>(CHART_TYPES.map((c) => c.value));
const INDICATOR_TYPES = new Set<string>(["sma", "ema", "vwap", "bb", "rsi", "macd", "atr", "volma"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeIndicator(v: unknown): IndicatorConfig | null {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.type !== "string" || !INDICATOR_TYPES.has(v.type)) return null;
  const params: Record<string, number | string> = {};
  if (isRecord(v.params)) {
    for (const [k, p] of Object.entries(v.params)) if (typeof p === "number" || typeof p === "string") params[k] = p;
  }
  return {
    id: v.id,
    type: v.type as IndicatorConfig["type"],
    params,
    ...(typeof v.color === "string" ? { color: v.color } : {}),
    visible: v.visible !== false,
  };
}

/** Merge a server-provided layout (possibly null, stale or partial) over the defaults. */
export function normalizeLayout(raw: unknown, defaults: Layout): Layout {
  if (!isRecord(raw)) return { ...defaults, indicators: [...defaults.indicators], recentSymbols: [...defaults.recentSymbols] };
  const symbol = typeof raw.symbol === "string" && raw.symbol.trim() ? raw.symbol.trim() : defaults.symbol;
  const tf = typeof raw.tf === "string" && (TIMEFRAMES as string[]).includes(raw.tf) ? (raw.tf as Timeframe) : defaults.tf;
  const chartType = typeof raw.chartType === "string" && CHART_TYPE_SET.has(raw.chartType) ? (raw.chartType as ChartType) : defaults.chartType;
  const theme = raw.theme === "light" || raw.theme === "dark" ? raw.theme : defaults.theme;
  const indicators = Array.isArray(raw.indicators)
    ? raw.indicators.map(sanitizeIndicator).filter((x): x is IndicatorConfig => x !== null)
    : [...defaults.indicators];
  const recentSymbols = Array.isArray(raw.recentSymbols)
    ? [...new Set(raw.recentSymbols.filter((s): s is string => typeof s === "string" && s.length > 0))].slice(0, 20)
    : [...defaults.recentSymbols];
  const out: Layout = {
    symbol,
    tf,
    chartType,
    theme,
    logScale: typeof raw.logScale === "boolean" ? raw.logScale : defaults.logScale,
    indicators,
    recentSymbols,
  };
  const wl = typeof raw.activeWatchlistId === "string" ? raw.activeWatchlistId : defaults.activeWatchlistId;
  if (wl) out.activeWatchlistId = wl;
  return out;
}

/** Split "AAPL.US" -> { code: "AAPL", exchange: "US" }. */
export function splitSymbol(symbol: Symbol): { code: string; exchange: string } {
  const i = symbol.lastIndexOf(".");
  return i > 0 ? { code: symbol.slice(0, i), exchange: symbol.slice(i + 1) } : { code: symbol, exchange: "" };
}

/** Parse a user-typed price ("1,234.5") -> number or null. */
export function parsePrice(text: string): number | null {
  const n = Number(text.replace(/[,\s]/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}
