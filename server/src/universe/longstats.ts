// Full-history statistics and per-ticker backfill planning (pure; see longstats.test.ts).
//
// The backfill fetches each symbol's FULL daily history once (/eod/{SYM}, 1 credit regardless of range),
// derives all-time high/low from it, and keeps only the last EODVIEW_HISTORY_YEARS of rows in universe_bars.
//
// Basis: EODHD's /eod rows carry raw OHLC plus adjusted_close (splits + dividends, restated as of the fetch
// date). Highs/lows are scaled by adjusted_close/close, i.e. expressed on the adjusted basis at fetch time,
// which equals the raw price basis of the fetch day and of every later bar until the next split/dividend
// (after which the pipeline re-fetches the symbol). This matches the chart's default ADJ view.
import type { EodRow } from "./store";
import { addDays } from "./util";

export interface LongStats {
  firstDate: string;
  lastDate: string;
  rows: number;
  /** All-time high/low on the adjusted basis at fetch time. */
  ath: number;
  athDate: string;
  atl: number;
  atlDate: string;
}

/**
 * Bad-tick guard: a high more than 2× the bar's body top (or a low under half its body bottom) is an EODHD
 * data error far more often than a real print, so the bar's extreme is capped at the body.
 */
function sane(r: EodRow): { hi: number; lo: number } {
  const top = Math.max(r.open, r.close), bot = Math.min(r.open, r.close);
  const hi = r.high > 0 && r.high <= top * 2 ? Math.max(r.high, top) : top;
  const lo = r.low > 0 && r.low >= bot * 0.5 ? Math.min(r.low, bot) : bot;
  return { hi, lo };
}

export function computeLongStats(rows: EodRow[]): LongStats | null {
  let ath = -Infinity, atl = Infinity, athDate = "", atlDate = "", first = "", last = "", n = 0;
  for (const r of rows) {
    if (!(r.close > 0) || !Number.isFinite(r.close)) continue;
    const f = r.adjClose > 0 && Number.isFinite(r.adjClose) ? r.adjClose / r.close : 1;
    const { hi, lo } = sane(r);
    const h = hi * f, l = lo * f;
    if (h > ath) { ath = h; athDate = r.date; }
    if (l > 0 && l < atl) { atl = l; atlDate = r.date; }
    if (!first || r.date < first) first = r.date;
    if (!last || r.date > last) last = r.date;
    n++;
  }
  if (!n || !Number.isFinite(ath) || !Number.isFinite(atl)) return null;
  return { firstDate: first, lastDate: last, rows: n, ath, athDate, atl, atlDate };
}

/** First date kept in universe_bars: `years` back from `today`, plus a 10-day margin for 3Y/5Y look-ups. */
export function retentionCutoff(today: string, years: number): string {
  return addDays(today, -Math.round(years * 365.25) - 10);
}

/** Extremes after the stats' last date, from recent bars already on the stats' basis (h/l arrays). */
export function extendExtremes(
  stats: { ath: number; athDate: string; atl: number; atlDate: string; lastDate: string } | null,
  dates: string[], highs: number[], lows: number[], scale = 1,
): { ath: number; athDate: string; atl: number; atlDate: string } | null {
  let ath = stats ? stats.ath * scale : -Infinity, atl = stats ? stats.atl * scale : Infinity;
  let athDate = stats?.athDate ?? "", atlDate = stats?.atlDate ?? "";
  if (!stats) return null;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i]! <= stats.lastDate) continue;
    if (highs[i]! > ath) { ath = highs[i]!; athDate = dates[i]!; }
    if (lows[i]! > 0 && lows[i]! < atl) { atl = lows[i]!; atlDate = dates[i]!; }
  }
  return { ath, athDate, atl, atlDate };
}

// ---------- backfill planning ----------
export interface BackfillCandidate {
  symbol: string;
  /** USD dollar volume (priority); null sorts last. */
  dollarVolumeUsd: number | null;
  /** universe_long row, if any. */
  status: "ok" | "nodata" | "error" | "stale" | null;
  fetchedAt: number | null; // unix seconds
  attempts: number;
}

export interface BackfillPlanOptions {
  nowSec: number;
  /** Max symbols (ok + nodata) per market; null = unlimited (EODVIEW_BACKFILL_MAX_SYMBOLS). */
  cap: number | null;
  limit: number;
  /** Errors are retried after this long, at most maxAttempts times. */
  errorRetrySec?: number;
  maxAttempts?: number;
  /** Symbols without data are re-checked after this long (new listings get history later). */
  noDataRetrySec?: number;
  /**
   * Re-fetch 'ok' histories once per this period (markets without EODHD's bulk splits/dividends feed, so small
   * splits, stock dividends and cash dividends get restated). Each symbol has a fixed phase within the period
   * (hash of the symbol), so the load is spread evenly over the days. Undefined = never.
   */
  refreshSec?: number;
}

/** Default refresh period for markets without the bulk corporate-actions feed. */
export const HISTORY_REFRESH_SEC = 60 * 86400;

/** Stable fraction in [0, 1) from a symbol (FNV-1a). */
export function symbolPhase(symbol: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 2 ** 32;
}

/**
 * Start of the symbol's current refresh slot: slots are `period` long and offset by the symbol's phase, so every
 * symbol is due exactly once per period and 1/period of the market falls due each day.
 */
export function refreshSlotStart(symbol: string, nowSec: number, periodSec: number): number {
  const phase = Math.floor(symbolPhase(symbol) * periodSec);
  return nowSec - (((nowSec - phase) % periodSec) + periodSec) % periodSec;
}

/** An 'ok' history due for its periodic refresh. */
export function isRefreshDue(c: BackfillCandidate, o: BackfillPlanOptions): boolean {
  if (c.status !== "ok" || !o.refreshSec || o.refreshSec <= 0) return false;
  return (c.fetchedAt ?? 0) < refreshSlotStart(c.symbol, o.nowSec, o.refreshSec);
}

export interface BackfillPlan {
  todo: string[];
  /** Candidates still due after this slice (for `more`). */
  remaining: number;
  done: number;
  capped: boolean;
}

/** True when the symbol needs a (re-)fetch now. */
export function isDue(c: BackfillCandidate, o: BackfillPlanOptions): boolean {
  const retry = o.errorRetrySec ?? 6 * 3600, maxAttempts = o.maxAttempts ?? 5, noData = o.noDataRetrySec ?? 30 * 86400;
  switch (c.status) {
    case null:
    case "stale":
      return true;
    case "error":
      return c.attempts < maxAttempts && (c.fetchedAt ?? 0) <= o.nowSec - retry;
    case "nodata":
      return (c.fetchedAt ?? 0) <= o.nowSec - noData;
    case "ok":
      return isRefreshDue(c, o);
    default:
      return false;
  }
}

/**
 * Order: stale (split re-pulls) first, then new/error/nodata symbols, then periodic refreshes of 'ok' histories;
 * within a group by USD dollar volume desc, then symbol. The per-market cap counts symbols ever attempted (any
 * universe_long row); re-fetches of those never consume it.
 */
export function planBackfill(cands: BackfillCandidate[], o: BackfillPlanOptions): BackfillPlan {
  const done = cands.filter((c) => c.status === "ok" || c.status === "nodata").length;
  const attempted = cands.filter((c) => c.status !== null).length;
  const due = cands.filter((c) => isDue(c, o));
  due.sort((a, b) => {
    const rank = (c: BackfillCandidate) => (c.status === "stale" ? 0 : c.status === "ok" ? 2 : 1);
    const sa = rank(a), sb = rank(b);
    if (sa !== sb) return sa - sb;
    const va = a.dollarVolumeUsd ?? -1, vb = b.dollarVolumeUsd ?? -1;
    if (va !== vb) return vb - va;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  let room = o.cap === null ? Infinity : Math.max(0, o.cap - attempted);
  const todo: string[] = [];
  let capped = false, leftOld = 0, leftNew = 0;
  for (const c of due) {
    const isNew = c.status === null;
    if (isNew && room <= 0) { capped = true; continue; }
    if (todo.length >= o.limit) {
      if (isNew) leftNew++; else leftOld++;
      continue;
    }
    if (isNew) room--;
    todo.push(c.symbol);
  }
  const remaining = leftOld + Math.min(leftNew, room);
  return { todo, remaining, done, capped };
}

// ---------- split detection from the daily bulk ----------
export interface SuspectOptions {
  low?: number;
  high?: number;
  max?: number;
  /** Close ratios of common small splits (5:4, 4:3, 3:2 and their reverses) matched within `tolerance`. */
  factors?: number[];
  tolerance?: number;
}

/** 5-for-4, 4-for-3, 3-for-2 splits and the matching reverse splits. */
export const SMALL_SPLIT_FACTORS = [4 / 5, 3 / 4, 2 / 3, 5 / 4, 4 / 3, 3 / 2];
/** Minimum symbols with both closes before the market's median move is used to normalise ratios. */
const MIN_FOR_MEDIAN = 20;

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/**
 * Symbols whose close moved by a split-like ratio against the previous stored close (both raw). A split makes
 * EODHD restate history, so each suspect gets its full history re-fetched (1 credit): a false positive only costs
 * that credit. Used for markets without the bulk splits/dividends feed.
 *
 * Ratios are taken relative to the market's median move that day (a broad sell-off is not a split). Flagged:
 * any move beyond low/high (large splits, 2:1 and up), plus moves within `tolerance` of a small split factor
 * (3:2 ≈ 0.667, 5:4 = 0.8, …). A plain ±15–45% move only matches when it happens to land on a factor, which keeps
 * false positives rare; small stock dividends (≤ 10%) are indistinguishable from ordinary moves and are left to the
 * periodic history refresh (HISTORY_REFRESH_SEC).
 */
export function splitSuspects(prev: ReadonlyMap<string, number>, today: Array<{ symbol: string; close: number }>, o: SuspectOptions = {}): string[] {
  const lo = o.low ?? 0.55, hi = o.high ?? 1.8, max = o.max ?? 200;
  const factors = o.factors ?? SMALL_SPLIT_FACTORS, tol = o.tolerance ?? 0.015;
  const ratios: Array<{ symbol: string; r: number }> = [];
  for (const t of today) {
    const p = prev.get(t.symbol);
    if (!p || !(p > 0) || !(t.close > 0)) continue;
    ratios.push({ symbol: t.symbol, r: t.close / p });
  }
  const base = ratios.length >= MIN_FOR_MEDIAN ? median(ratios.map((x) => x.r)) : 1;
  const out: Array<{ symbol: string; dev: number }> = [];
  for (const { symbol, r: raw } of ratios) {
    const r = raw / base;
    const big = r < lo || r > hi;
    const small = !big && factors.some((f) => Math.abs(r / f - 1) <= tol);
    if (big || small) out.push({ symbol, dev: Math.abs(Math.log(r)) });
  }
  out.sort((a, b) => b.dev - a.dev);
  return out.slice(0, max).map((x) => x.symbol);
}
