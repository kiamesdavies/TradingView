import type { Bar, RangePreset, Symbol, Timeframe, UnixSeconds } from "@eodview/shared";
import { isIntraday, tfSeconds } from "./candles";
import { zonedDate, zonedMidnight } from "./timezone";

// Pure helpers for the range bar: preset → timeframe, range start computation, go-to-date timeframe choice and
// time → logical-index mapping.

const DAY = 86_400;

export const RANGE_PRESETS: RangePreset[] = ["1D", "5D", "1M", "3M", "6M", "YTD", "1Y", "5Y", "All"];

/** TradingView's interval for each range preset. */
export const PRESET_TIMEFRAME: Record<RangePreset, Timeframe> = {
  "1D": "1m",
  "5D": "5m",
  "1M": "30m",
  "3M": "1h",
  "6M": "4h",
  YTD: "1D",
  "1Y": "1D",
  "5Y": "1W",
  All: "1M",
};

export const PRESET_TITLE: Record<RangePreset, string> = {
  "1D": "1 day in 1 minute intervals",
  "5D": "5 days in 5 minute intervals",
  "1M": "1 month in 30 minute intervals",
  "3M": "3 months in 1 hour intervals",
  "6M": "6 months in 4 hour intervals",
  YTD: "Year to day in 1 day intervals",
  "1Y": "1 year in 1 day intervals",
  "5Y": "5 years in 1 week intervals",
  All: "All data in 1 month intervals",
};

/** Approximate EODHD intraday history depth per interval (15m/30m are built from 5m, 4h from 1h). */
export const INTRADAY_HISTORY_DAYS: Partial<Record<Timeframe, number>> = {
  "1m": 120,
  "5m": 600,
  "15m": 600,
  "30m": 600,
  "1h": 7200,
  "4h": 7200,
};

/** Markets that trade 24/7 (no weekend gaps): session-based presets use rolling windows there. */
export function isAlwaysOpen(symbol: Symbol): boolean {
  return /\.CC$/i.test(symbol);
}

export interface RangeStartOptions {
  /** Zone whose calendar days define sessions (intraday presets). Defaults to UTC. */
  tz?: string;
  /** Rolling 24h days instead of weekday sessions (crypto). */
  alwaysOpen?: boolean;
}

/**
 * Start time of `preset` ending at the last loaded bar `lastTime`. Returns null for "All".
 * - 1D: start of the last bar's session day (in `tz`); 5D: 5 weekday sessions back (holidays not modelled).
 *   For always-open markets: the last 24h / 5×24h.
 * - 1M…5Y: calendar months back from the last bar's date (day clamped to the target month).
 * - YTD: January 1st of the last bar's year.
 */
export function rangeStart(preset: RangePreset, lastTime: UnixSeconds, opts: RangeStartOptions = {}): UnixSeconds | null {
  const tz = opts.tz ?? "UTC";
  switch (preset) {
    case "All":
      return null;
    case "1D":
    case "5D": {
      const sessions = preset === "1D" ? 1 : 5;
      if (opts.alwaysOpen) return lastTime - sessions * DAY;
      const z = zonedDate(lastTime, tz);
      let d = Date.UTC(z.getUTCFullYear(), z.getUTCMonth(), z.getUTCDate()) / 1000;
      // If the last bar is on a weekend (e.g. forex Sunday open), count it as a session anyway.
      for (let counted = 1; counted < sessions; ) {
        d -= DAY;
        const dow = new Date(d * 1000).getUTCDay();
        if (dow !== 0 && dow !== 6) counted++;
      }
      const dd = new Date(d * 1000);
      return zonedMidnight(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), tz);
    }
    case "YTD": {
      const y = new Date(lastTime * 1000).getUTCFullYear();
      return Date.UTC(y, 0, 1) / 1000;
    }
    default: {
      const months = preset === "1M" ? 1 : preset === "3M" ? 3 : preset === "6M" ? 6 : preset === "1Y" ? 12 : 60;
      return subtractMonths(lastTime, months);
    }
  }
}

/** Same wall time `months` calendar months earlier (UTC), day clamped to the month length. */
export function subtractMonths(t: UnixSeconds, months: number): UnixSeconds {
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

const INTRADAY_ORDER: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h"];

/** Max bar pages a go-to-date may fetch before we switch to a coarser interval. */
export const GOTO_MAX_PAGES = 40;

/**
 * Timeframe to use for jumping back to `from`: the current one when EODHD has intraday history that deep and it
 * can be reached in a reasonable number of pages (≈50% time coverage for sessions with gaps), else the next coarser
 * intraday interval that can, else 1D.
 */
export function goToTimeframe(tf: Timeframe, from: UnixSeconds, now: UnixSeconds, pageSize = 500): Timeframe {
  if (!isIntraday(tf)) return tf;
  const days = Math.max(0, (now - from) / DAY);
  for (let i = INTRADAY_ORDER.indexOf(tf); i >= 0 && i < INTRADAY_ORDER.length; i++) {
    const cand = INTRADAY_ORDER[i]!;
    const limit = INTRADAY_HISTORY_DAYS[cand] ?? 0;
    if (days > limit) continue;
    const pages = (days * DAY * 0.5) / tfSeconds(cand) / pageSize;
    if (pages <= GOTO_MAX_PAGES) return cand;
  }
  return "1D";
}

/** First index with time >= t (bars ascending); bars.length when none. */
export function lowerBound(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface LogicalSpan {
  from: number;
  to: number;
}

/**
 * Logical range showing bars in [from, to] with a little right padding (≈4% of the span, min 2 bars).
 * `to` defaults to the last bar. Null when no bar falls in the range.
 */
export function logicalRangeForTimes(bars: readonly Bar[], from: UnixSeconds, to?: UnixSeconds): LogicalSpan | null {
  const n = bars.length;
  if (n === 0) return null;
  const fromIdx = lowerBound(bars, from);
  const toIdx = to === undefined ? n - 1 : lowerBound(bars, to + 1) - 1;
  if (fromIdx > toIdx || fromIdx >= n || toIdx < 0) return null;
  const span = toIdx - fromIdx;
  const padBars = Math.max(2, Math.round(span * 0.04));
  return { from: fromIdx - 0.5, to: toIdx + padBars };
}

/** Logical range of `width` bars centred on the bar at/after `t` (clamped to the data). */
export function centeredRange(bars: readonly Bar[], t: UnixSeconds, width: number): LogicalSpan | null {
  const n = bars.length;
  if (n === 0) return null;
  const idx = Math.min(n - 1, lowerBound(bars, t));
  const w = Math.max(10, width);
  return { from: idx - w / 2, to: idx + w / 2 };
}

/** Parse an <input type="date"> value ("2024-03-15") to 00:00 UTC of that date, or null. */
export function parseDateInput(v: string): UnixSeconds | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  return Number.isFinite(t) ? t : null;
}

/** 00:00 UTC date → "YYYY-MM-DD". */
export function toDateInput(t: UnixSeconds): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/**
 * Convert a picked calendar date (00:00 UTC) to the chart time to seek: daily+ bars are stamped with the date
 * itself; intraday bars use real instants, so use midnight of that date in the display zone.
 */
export function dateToChartTime(date: UnixSeconds, tf: Timeframe, tz: string): UnixSeconds {
  if (!isIntraday(tf)) return date;
  const d = new Date(date * 1000);
  return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), tz);
}
