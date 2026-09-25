// Universe pipeline jobs. Each job does a bounded slice of work and reports whether more remains; the scheduler
// (pipeline.ts) decides what runs when. Market-scoped jobs (symbols, prices, backfill, indices) run once per
// enabled market ("prices:ST"); fx, earnings, news, metrics and fundamentals are global. Every EODHD call goes
// through `call()`: credit budget check, shared rate limiter (token bucket + concurrency), retries with
// back-off on 429/5xx/network errors, and a ledger entry under the job instance ("backfill:US").
import type { Database } from "bun:sqlite";
import {
  calendarFor,
  marketExpectedLatest,
  marketNextAttemptAfter,
  marketAttemptAt,
  marketRecentSessions,
  tzDate,
} from "./calendar";
import { BudgetExhausted, COST, type CreditGuard } from "./credits";
import { deriveFundamentals } from "./derive";
import { fxSymbols, parseFxQuotes } from "./fx";
import { computeLongStats, HISTORY_REFRESH_SEC, planBackfill, retentionCutoff, splitSuspects, type BackfillCandidate } from "./longstats";
import { getMarket, MARKETS, marketOfSymbol, type MarketDef } from "./markets";
import { bumpMetricsVersion, loadFxRates, recomputeMetrics } from "./metrics";
import {
  dominantDate,
  earningsBySymbol,
  filterSymbolList,
  parseActions,
  parseBulk,
  parseEarningsCalendar,
  parseExchangeDetails,
  parseIndexComponents,
  parseNews,
} from "./parsers";
import { errorStatus, Limiter, withRetry, type RetryOptions } from "./ratelimit";
import { kvGet, kvSet } from "./schema";
import {
  activeCodeMap,
  activeSymbols,
  addHoliday,
  closesOn,
  firstBarDate,
  holidays,
  ingestBulk,
  latestDate,
  markAllDirty,
  markDirty,
  markStale,
  minRowsFor,
  previousBulkDate,
  saveLongError,
  saveLongStats,
  storeHistory,
  takeDirty,
  upsertSymbols,
  type EodRow,
} from "./store";
import { addDays, isoDate, num, utcDate, values } from "./util";

export type JobName = "symbols" | "prices" | "fx" | "backfill" | "fundamentals" | "indices" | "earnings" | "news" | "metrics";
/** Priority order (market-scoped jobs expand to one instance per enabled market, in registry order). */
export const JOB_NAMES: JobName[] = ["symbols", "prices", "fx", "earnings", "indices", "news", "metrics", "backfill", "fundamentals"];
export const MARKET_JOBS: ReadonlySet<JobName> = new Set<JobName>(["symbols", "prices", "backfill", "indices"]);

export interface Api {
  raw(path: string, params?: Record<string, string | number | undefined>, what?: string): Promise<unknown>;
}

export interface JobCtx {
  db: Database;
  api: Api;
  credits: CreditGuard;
  /** Fetch + cache raw fundamentals (fundamentals/store.ts refreshFundamentals). */
  refreshFundamentals(symbol: string): Promise<Record<string, any>>;
  /** Cached raw fundamentals newer than our derived copy (fetched by the details API): [symbol, data, fetchedAt]. */
  externallyRefreshed?(limit: number): Array<{ symbol: string; data: Record<string, any>; fetchedAt: number }>;
  now(): number;
  /** Enabled markets, registry order. */
  markets: MarketDef[];
  /** Market of a market-scoped job instance; null for global jobs. */
  market: MarketDef | null;
  /** Years of daily rows kept in universe_bars (EODVIEW_HISTORY_YEARS). */
  historyYears: number;
  /** Per-market cap on symbols the backfill fetches (EODVIEW_BACKFILL_MAX_SYMBOLS, testing); null = all. */
  backfillMaxSymbols: number | null;
  /** Fundamentals fetched per run before pausing (EODVIEW_FUNDAMENTALS_MAX_PER_RUN). */
  fundamentalsMaxPerRun: number;
  /**
   * Credits of the daily budget the low-priority jobs (backfill, fundamentals) must leave unused, so the daily
   * prices / corporate-actions / FX jobs never starve (EODVIEW_JOB_CREDIT_RESERVE, default 3000).
   */
  lowPriorityReserve?: number;
  /** Markets whose splits/dividends come from EODHD's bulk lists (100 credits each per session). */
  bulkActionMarkets: ReadonlySet<string>;
  limiter: Limiter;
  retry?: RetryOptions;
  progress(text: string | null): void;
  yieldNow(): Promise<void>;
  job: JobName;
  /** Ledger key of this instance: "prices:ST", "fx", ... */
  jobKey: string;
}

export interface JobResult {
  /** More work is queued; run again soon. */
  more?: boolean;
  /** Explicit next run (ms); otherwise the scheduler's cadence applies. */
  nextRunAt?: number | null;
  note?: string;
}

const sec = (ms: number) => Math.floor(ms / 1000);
const US = MARKETS[0]!;

/** Jobs that must leave `lowPriorityReserve` credits of the daily budget for the others. */
export const LOW_PRIORITY_JOBS: ReadonlySet<JobName> = new Set<JobName>(["backfill", "fundamentals"]);
export const DEFAULT_LOW_PRIORITY_RESERVE = 3000;

/** Credits the current job must leave unused (backfill/fundamentals only; re-fetches run by prices keep none). */
export function creditKeep(ctx: Pick<JobCtx, "job" | "lowPriorityReserve">): number {
  return LOW_PRIORITY_JOBS.has(ctx.job) ? ctx.lowPriorityReserve ?? DEFAULT_LOW_PRIORITY_RESERVE : 0;
}

/** Budget-checked, rate-limited, retried EODHD call. Each attempt is recorded in the ledger under `key`. */
async function call(
  ctx: JobCtx, cost: number, path: string, params: Record<string, string | number | undefined>, what: string, key = ctx.jobKey,
): Promise<unknown> {
  await ctx.credits.ensure(cost, creditKeep(ctx));
  return withRetry(
    async () => {
      try {
        return await ctx.limiter.run(() => ctx.api.raw(path, params, what));
      } finally {
        ctx.credits.record(key, cost);
      }
    },
    ctx.retry,
  );
}

/** Market of a symbol: the stored row, else the suffix. */
function marketFor(db: Database, symbol: string): MarketDef {
  const code = db.query<{ market: string }, [string]>("SELECT market FROM universe_symbols WHERE symbol = ?").get(symbol)?.market ?? marketOfSymbol(symbol) ?? "US";
  return getMarket(code) ?? US;
}

export const marketToday = (m: MarketDef, nowMs: number): string => tzDate(nowMs, m.timezone);

const kvKey = (base: string, m: MarketDef) => `${base}:${m.code}`;

// ---------------------------------------------------------------- symbols (weekly per market)
export async function runSymbols(ctx: JobCtx): Promise<JobResult> {
  const m = ctx.market!;
  ctx.progress(`downloading ${m.code} symbol list`);
  const raw = await call(ctx, COST.symbolList, `/exchange-symbol-list/${m.code}`, {}, `${m.code} symbol list`);
  const rows = filterSymbolList(raw, m);
  if (rows.length < m.minSymbols) {
    throw new Error(`${m.code} symbol list looks incomplete (${rows.length} listed symbols, expected ≥ ${m.minSymbols}); keeping the current universe`);
  }
  const r = upsertSymbols(ctx.db, m.code, rows);
  markDirty(ctx.db, rows.map((x) => x.symbol));
  const stocks = rows.filter((x) => x.kind === "stock").length;
  let note = `${stocks} stocks${rows.length - stocks ? `, ${rows.length - stocks} ETFs` : ""}, ${r.deactivated} delisted`;
  // Exchange holidays for the calendar (best effort; the prices job also learns missing sessions).
  try {
    const today = marketToday(m, ctx.now());
    const d = parseExchangeDetails(
      await call(ctx, COST.exchangeDetails, `/exchange-details/${m.code}`, { from: addDays(today, -30), to: addDays(today, 200) }, `${m.code} exchange details`),
    );
    for (const h of d.holidays) addHoliday(ctx.db, m.code, h, "exchange");
    note += `, ${d.holidays.length} holidays`;
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    note += `, holidays unavailable (${(e as Error).message})`;
  }
  return { note };
}

// ---------------------------------------------------------------- prices (latest session per market)
/** When a market's prices job should next run (ms), given its newest stored session and the last attempt. */
export function pricesNextRun(now: number, latest: string | null, hol: ReadonlySet<string>, lastAttempt: number | null, market: MarketDef = US): number {
  if (!latest) return now;
  const cal = calendarFor(market, hol);
  const expected = marketExpectedLatest(cal, now);
  if (latest >= expected) return marketNextAttemptAfter(cal, latest);
  // Behind: attempt now (the expected session's attempt time has passed), then hourly until it appears.
  if (!lastAttempt || lastAttempt < marketAttemptAt(cal, expected)) return now;
  return Math.max(now, lastAttempt + 3600_000);
}

export async function runPrices(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const m = ctx.market!;
  const cal = calendarFor(m, holidays(db, m.code));
  const before = latestDate(db, m.code);
  const expected = marketExpectedLatest(cal, ctx.now());
  ctx.progress(`downloading ${m.code} latest session (bulk)`);
  const raw = await call(ctx, COST.bulk, `/eod-bulk-last-day/${m.code}`, { filter: "extended" }, `${m.code} bulk EOD`);
  const bars = parseBulk(raw);
  const date = dominantDate(bars);
  kvSet(db, kvKey("prices_last_attempt", m), String(ctx.now()));
  const codes = activeCodeMap(db, m.code);
  const matched = date ? bars.filter((b) => b.date === date && codes.has(b.code)).length : 0;
  let note: string;
  if (!date || matched < minRowsFor(db, m.code)) {
    note = `bulk returned ${bars.length} rows (${matched} in the universe)`;
  } else {
    const prevDate = previousBulkDate(db, m.code, date);
    const prevCloses = prevDate ? closesOn(db, m.code, prevDate) : new Map<string, number>();
    const n = ingestBulk(db, m.code, date, bars, codes, true);
    markDirty(db, codes.values());
    note = `${date}: ${n} symbols`;
    if (!kvGet(db, kvKey("actions_through", m))) kvSet(db, kvKey("actions_through", m), date);
    if (ctx.bulkActionMarkets.has(m.code)) {
      await applyCorporateActions(ctx, date);
    } else {
      // No bulk split feed for this market: re-fetch symbols whose close jumped by a split-like ratio.
      const today = bars.filter((b) => b.date === date && codes.has(b.code)).map((b) => ({ symbol: codes.get(b.code)!, close: b.close }));
      const suspects = splitSuspects(prevCloses, today).filter((s) => (firstBarDate(db, s) ?? date) < date);
      if (suspects.length) {
        markStale(db, suspects);
        const r = await backfillSymbols(ctx, suspects, `split check ${date}`);
        note += `, ${suspects.length} split suspects re-fetched (${r.failed} failed)`;
      }
    }
  }
  const after = latestDate(db, m.code);
  if (date && after === date && isPartial(db, m.code, date)) {
    // EODHD sometimes publishes a session progressively: re-pull hourly, at most PARTIAL_RECHECKS times per
    // session (a session can also be genuinely smaller, e.g. thin trading or delistings).
    const [pDate, pN] = (kvGet(db, kvKey("prices_partial", m)) ?? "").split(":");
    const n = pDate === date ? Number(pN || 0) : 0;
    if (n < PARTIAL_RECHECKS) {
      kvSet(db, kvKey("prices_partial", m), `${date}:${n + 1}`);
      return { note: `${note} (partial, re-check ${n + 1}/${PARTIAL_RECHECKS})`, nextRunAt: ctx.now() + 3600_000 };
    }
    note += ` (smaller than the previous session after ${PARTIAL_RECHECKS} re-checks, accepted)`;
  }
  if (after && after >= expected) {
    kvSet(db, kvKey("prices_attempts", m), null);
    return { note, nextRunAt: marketNextAttemptAfter(cal, after) };
  }
  // Not published yet (or an unknown holiday): retry hourly; after 8 misses treat the session as a holiday.
  const [prevDate, prevN] = (kvGet(db, kvKey("prices_attempts", m)) ?? "").split(":");
  const attempts = prevDate === expected ? Number(prevN || 0) + 1 : 1;
  kvSet(db, kvKey("prices_attempts", m), `${expected}:${attempts}`);
  if (attempts >= 8 && before !== null) {
    addHoliday(db, m.code, expected);
    kvSet(db, kvKey("prices_attempts", m), null);
    return {
      note: `${note}; ${expected} not published after ${attempts} attempts, treated as a holiday`,
      nextRunAt: marketNextAttemptAfter(calendarFor(m, holidays(db, m.code)), expected),
    };
  }
  return { note: `${note}; waiting for ${expected}`, nextRunAt: ctx.now() + 3600_000 };
}

/** Hourly re-pulls of a session that looks partial before it is accepted as is. */
export const PARTIAL_RECHECKS = 3;

/** A session with clearly fewer rows than the previous stored one. */
function isPartial(db: Database, market: string, date: string): boolean {
  const rows = db.query<{ date: string; rows: number }, [string, string]>(
    "SELECT date, rows FROM universe_sessions WHERE market = ? AND date <= ? AND rows > 0 ORDER BY date DESC LIMIT 2",
  ).all(market, date);
  return rows.length === 2 && rows[0]!.date === date && rows[0]!.rows < rows[1]!.rows * 0.9;
}

/** Sessions of splits/dividends examined per catch-up; after a longer outage older actions are skipped. */
export const ACTIONS_CATCHUP_SESSIONS = 10;

/**
 * Keep stored adjusted closes and all-time highs consistent across splits and dividends (bulk-list markets).
 * For every session after the market's `actions_through` watermark, read EODHD's split and dividend lists for
 * that date; each affected universe symbol with older stored rows is marked stale and its full history is
 * re-fetched right away (1 credit; EODHD restates adjusted_close as of today). A failed re-fetch stays 'error'
 * in universe_long and the backfill job retries it.
 */
export async function applyCorporateActions(ctx: JobCtx, latest: string): Promise<void> {
  const { db } = ctx;
  const m = ctx.market ?? US;
  const through = kvGet(db, kvKey("actions_through", m));
  if (!through || through >= latest) return;
  const cal = calendarFor(m, holidays(db, m.code));
  const recent = marketRecentSessions(cal, latest, ACTIONS_CATCHUP_SESSIONS).filter((d) => d > through).reverse();
  const codes = activeCodeMap(db, m.code);
  for (const d of recent) {
    ctx.progress(`checking ${m.code} splits/dividends ${d}`);
    const affected = new Set<string>();
    for (const kind of ["splits", "dividends"] as const) {
      const raw = await call(ctx, COST.bulk, `/eod-bulk-last-day/${m.code}`, { type: kind, date: d }, `${m.code} ${kind} ${d}`);
      for (const a of parseActions(raw, kind === "splits" ? "split" : "dividend")) {
        const sym = codes.get(a.code);
        if (sym && a.date === d) affected.add(sym);
      }
    }
    const todo = [...affected].filter((sym) => {
      const first = firstBarDate(db, sym);
      return first && first < d;
    });
    if (todo.length) {
      markStale(db, todo);
      await backfillSymbols(ctx, todo, `splits/dividends on ${d}`);
    }
    kvSet(db, kvKey("actions_through", m), d);
  }
  kvSet(db, kvKey("actions_through", m), latest);
}

export function parseEod(raw: unknown): EodRow[] {
  const out: EodRow[] = [];
  for (const r of values<Record<string, unknown>>(raw)) {
    const date = isoDate(r?.date);
    const close = num(r?.close);
    if (!date || close === null || close <= 0) continue;
    const adj = num(r?.adjusted_close);
    out.push({
      date,
      open: num(r?.open) ?? close,
      high: num(r?.high) ?? close,
      low: num(r?.low) ?? close,
      close,
      adjClose: adj !== null && adj > 0 ? adj : close,
      volume: num(r?.volume) ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------- backfill (per-ticker full history)
/** Symbols per backfill slice (~30 s at 800 requests/min), so price updates and metrics interleave. */
export const BACKFILL_SLICE = 400;
/** `from` for /eod: the whole history (EODHD charges 1 credit per call regardless of range). */
export const HISTORY_FROM = "1900-01-01";
/** Consecutive non-404 failures after which a backfill slice stops (network / key problems). */
const MAX_CONSECUTIVE_FAILURES = 20;

export function backfillCandidates(db: Database, market: string): BackfillCandidate[] {
  return db
    .query<{ symbol: string; dv: number | null; status: BackfillCandidate["status"]; fetched_at: number | null; attempts: number | null }, [string]>(
      `SELECT s.symbol, COALESCE(m.dollar_volume_usd, m.dollar_volume) AS dv, l.status, l.fetched_at, l.attempts
       FROM universe_symbols s LEFT JOIN universe_long l ON l.symbol = s.symbol LEFT JOIN universe_metrics m ON m.symbol = s.symbol
       WHERE s.active = 1 AND s.market = ?`,
    )
    .all(market)
    .map((r) => ({ symbol: r.symbol, dollarVolumeUsd: r.dv, status: r.status ?? null, fetchedAt: r.fetched_at, attempts: r.attempts ?? 0 }));
}

/**
 * Next backfill slice of a market. Markets without the bulk splits/dividends feed also re-fetch every 'ok' history
 * once per HISTORY_REFRESH_SEC (spread evenly), so undetected splits, stock and cash dividends get restated.
 */
export function backfillPlan(ctx: Pick<JobCtx, "db" | "now" | "backfillMaxSymbols" | "bulkActionMarkets">, market: string, limit = BACKFILL_SLICE) {
  const refreshSec = ctx.bulkActionMarkets.has(market) ? undefined : HISTORY_REFRESH_SEC;
  return planBackfill(backfillCandidates(ctx.db, market), { nowSec: sec(ctx.now()), cap: ctx.backfillMaxSymbols, limit, refreshSec });
}

/**
 * Fetch each symbol's full daily history (/eod/{SYM}?from=1900-01-01, 1 credit), store the retention window in
 * universe_bars, the all-time stats in universe_long. Runs `limiter.concurrency` workers. 404 → 'nodata'.
 * Throws BudgetExhausted (after recording progress) and aborts after repeated non-404 failures.
 */
export async function backfillSymbols(ctx: JobCtx, symbols: string[], label: string): Promise<{ ok: number; nodata: number; failed: number }> {
  const { db } = ctx;
  let next = 0, done = 0, ok = 0, nodata = 0, failed = 0, streak = 0;
  let stop: unknown = null;
  const worker = async () => {
    while (!stop && next < symbols.length) {
      const sym = symbols[next++]!;
      const m = marketFor(db, sym);
      try {
        const raw = await call(ctx, COST.eod, `/eod/${encodeURIComponent(sym)}`, { from: HISTORY_FROM }, `${sym} history`, `backfill:${m.code}`);
        const rows = parseEod(raw);
        const stats = computeLongStats(rows);
        const kept = stats ? storeHistory(db, sym, m.code, rows, retentionCutoff(marketToday(m, ctx.now()), ctx.historyYears)) : 0;
        saveLongStats(db, sym, m.code, stats, kept, sec(ctx.now()));
        markDirty(db, [sym]);
        if (stats) ok++; else nodata++;
        streak = 0;
      } catch (e) {
        if (e instanceof BudgetExhausted) { stop = e; break; }
        const st = errorStatus(e);
        const isNoData = st === 404;
        saveLongError(db, sym, m.code, (e as Error)?.message ?? String(e), sec(ctx.now()), isNoData);
        if (isNoData) nodata++;
        else {
          failed++;
          if (++streak >= MAX_CONSECUTIVE_FAILURES || st === 401 || st === 402 || st === 403) stop = e;
        }
      }
      done++;
      if (done % 20 === 0) {
        ctx.progress(`${label}: ${done}/${symbols.length}`);
        await ctx.yieldNow();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(ctx.limiter.o.concurrency, symbols.length)) }, worker));
  if (stop) throw stop;
  return { ok, nodata, failed };
}

export async function runBackfill(ctx: JobCtx): Promise<JobResult> {
  const m = ctx.market!;
  const plan = backfillPlan(ctx, m.code);
  if (!plan.todo.length) {
    return { note: plan.capped ? `symbol cap ${ctx.backfillMaxSymbols} reached (${plan.done} histories)` : `history complete (${plan.done} symbols)` };
  }
  const r = await backfillSymbols(ctx, plan.todo, `${m.code} histories`);
  return {
    more: plan.remaining > 0,
    note: `${r.ok} histories, ${r.nodata} without data, ${r.failed} failed; ${plan.remaining} to go${plan.capped ? ` (symbol cap ${ctx.backfillMaxSymbols} reached)` : ""}`,
  };
}

/** Weekly: drop bars (and session rows) older than the retention window. */
export function pruneOldBars(ctx: Pick<JobCtx, "db" | "now" | "historyYears">): string {
  const { db } = ctx;
  const last = Number(kvGet(db, "pruned_at") ?? 0);
  if (ctx.now() - last < 7 * 86400_000) return "";
  const cutoff = retentionCutoff(utcDate(ctx.now()), ctx.historyYears);
  const n = db.query("DELETE FROM universe_bars WHERE date < ?").run(cutoff).changes;
  db.query("DELETE FROM universe_sessions WHERE date < ?").run(cutoff);
  kvSet(db, "pruned_at", String(ctx.now()));
  return n ? `, pruned ${n} rows before ${cutoff}` : "";
}

// ---------------------------------------------------------------- fundamentals (global, USD-liquidity priority)
export const FUNDAMENTALS_PER_SLICE = 80;
const FUND_CONCURRENCY = 4;
/** Pause after a run fetched EODVIEW_FUNDAMENTALS_MAX_PER_RUN symbols. */
export const FUNDAMENTALS_RUN_PAUSE_MS = 3600_000;

/** Next symbols to refresh across the enabled markets, in priority order. */
export function fundamentalsQueue(db: Database, nowMs: number, today: string, limit: number, markets: string[] = ["US"]): string[] {
  const now = sec(nowMs);
  const out: string[] = [];
  const seen = new Set<string>();
  const mk = markets.map((m) => `'${m.replace(/[^A-Z]/g, "")}'`).join(",") || "''";
  const take = (sql: string, ...args: (string | number)[]) => {
    if (out.length >= limit) return;
    for (const r of db.query<{ symbol: string }, (string | number)[]>(sql).all(...args)) {
      if (out.length >= limit) break;
      if (!seen.has(r.symbol)) { seen.add(r.symbol); out.push(r.symbol); }
    }
  };
  const liq = `m.dollar_volume_usd IS NULL, m.dollar_volume_usd DESC`;
  // Symbols backing off after a failure (universe_fund_retry) are skipped until their retry time.
  const ready = `NOT EXISTS (SELECT 1 FROM universe_fund_retry r WHERE r.symbol = s.symbol AND r.retry_at > ${Math.floor(now)})`;
  // 1. stocks never fetched, most traded (USD) first
  take(
    `SELECT s.symbol FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol
     LEFT JOIN universe_metrics m ON m.symbol = s.symbol
     WHERE s.active = 1 AND ${ready} AND s.market IN (${mk}) AND s.kind = 'stock' AND f.symbol IS NULL
     ORDER BY ${liq}, s.symbol LIMIT ?`, limit);
  // 2. stocks that reported since their last fetch (EODHD updates the day after the report)
  take(
    `SELECT s.symbol FROM universe_symbols s JOIN universe_fund f ON f.symbol = s.symbol
     WHERE s.active = 1 AND ${ready} AND s.market IN (${mk}) AND s.kind = 'stock' AND s.last_earnings_date IS NOT NULL AND s.last_earnings_date < ?
       AND f.fundamentals_at < CAST(strftime('%s', s.last_earnings_date, '+1 day') AS INTEGER)
     ORDER BY s.last_earnings_date DESC LIMIT ?`, today, limit);
  // 3. stale stocks, oldest first
  take(
    `SELECT s.symbol FROM universe_symbols s JOIN universe_fund f ON f.symbol = s.symbol
     WHERE s.active = 1 AND ${ready} AND s.market IN (${mk}) AND s.kind = 'stock' AND f.fundamentals_at < ? ORDER BY f.fundamentals_at LIMIT ?`, now - 7 * 86400, limit);
  // 4. ETFs never fetched (most traded first) or older than 30 days
  take(
    `SELECT s.symbol FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol
     LEFT JOIN universe_metrics m ON m.symbol = s.symbol
     WHERE s.active = 1 AND ${ready} AND s.market IN (${mk}) AND s.kind = 'etf' AND (f.symbol IS NULL OR f.fundamentals_at < ?)
     ORDER BY f.symbol IS NOT NULL, f.fundamentals_at, ${liq}, s.symbol LIMIT ?`,
    now - 30 * 86400, limit);
  return out;
}

export function storeDerived(db: Database, symbol: string, data: Record<string, any> | null, fetchedAt: number, today: string, error: string | null): void {
  const derived = data ? JSON.stringify(deriveFundamentals(data, today)) : null;
  db.query(
    `INSERT INTO universe_fund (symbol, fundamentals_at, data, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET fundamentals_at = excluded.fundamentals_at,
       data = COALESCE(excluded.data, universe_fund.data), error = excluded.error`,
  ).run(symbol, fetchedAt, derived, error);
}

/** First retry delay after a per-symbol fundamentals failure; doubles per attempt up to FUND_RETRY_MAX_SEC. */
export const FUND_RETRY_BASE_SEC = 3600;
export const FUND_RETRY_MAX_SEC = 7 * 86400;
/** Consecutive per-symbol failures after which a slice stops anyway (an outage that looks per-symbol). */
const FUND_MAX_CONSECUTIVE_FAILURES = 12;

/**
 * Errors that affect every request, not one symbol: the key is rejected (401/403), EODHD keeps rate limiting us
 * (429 after retries), no key, or EODHD cannot be reached. These end the slice; anything else (5xx, timeouts,
 * 402 plan limits, malformed payloads) is recorded against the symbol, which backs off.
 */
export function isGlobalFundamentalsError(e: unknown): boolean {
  const x = e as { code?: string; status?: number; upstreamStatus?: number } | null;
  const st = errorStatus(e);
  if (st === 401 || st === 403 || st === 429) return true;
  if (x?.code === "no_key" || x?.code === "unauthorized" || x?.code === "rate_limited") return true;
  // "network" covers both unreachable (502) and timed out (504); a timeout can be one oversized payload.
  return x?.code === "network" && x?.status !== 504;
}

/** Record a per-symbol fundamentals failure; returns the retry time (unix seconds). */
export function recordFundamentalsFailure(db: Database, symbol: string, nowSec: number, error: string): number {
  const prev = db.query<{ attempts: number }, [string]>("SELECT attempts FROM universe_fund_retry WHERE symbol = ?").get(symbol)?.attempts ?? 0;
  const attempts = prev + 1;
  const retryAt = nowSec + Math.min(FUND_RETRY_MAX_SEC, FUND_RETRY_BASE_SEC * 2 ** (attempts - 1));
  db.query(
    `INSERT INTO universe_fund_retry (symbol, attempts, retry_at, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET attempts = excluded.attempts, retry_at = excluded.retry_at, error = excluded.error`,
  ).run(symbol, attempts, retryAt, error.slice(0, 200));
  return retryAt;
}

export async function runFundamentals(ctx: JobCtx, limit = FUNDAMENTALS_PER_SLICE): Promise<JobResult> {
  const { db } = ctx;
  const codes = ctx.markets.map((m) => m.code);
  const todayOf = (sym: string) => marketToday(marketFor(db, sym), ctx.now());
  // Free: pick up fundamentals the details API fetched on demand.
  let picked = 0;
  const enabled = activeSymbols(db, codes);
  for (const r of ctx.externallyRefreshed?.(500) ?? []) {
    if (!enabled.has(r.symbol)) continue;
    storeDerived(db, r.symbol, r.data, r.fetchedAt, todayOf(r.symbol), null);
    markDirty(db, [r.symbol]);
    picked++;
  }
  // Per-run cap: a "run" is a chain of slices; after the cap the job pauses for an hour.
  const runCount = Number(kvGet(db, "fundamentals_run_count") ?? 0);
  const room = Math.max(0, ctx.fundamentalsMaxPerRun - runCount);
  const queue = room > 0 ? fundamentalsQueue(db, ctx.now(), utcDate(ctx.now()), Math.min(limit, room), codes) : [];
  if (!queue.length) {
    kvSet(db, "fundamentals_run_count", null);
    if (room === 0) return { note: `run cap of ${ctx.fundamentalsMaxPerRun} reached, pausing`, nextRunAt: ctx.now() + FUNDAMENTALS_RUN_PAUSE_MS };
    return { note: picked ? `${picked} picked up from cache` : "up to date" };
  }
  let ok = 0, failed = 0, deferred = 0, streak = 0;
  let stop: unknown = null;
  const clearRetry = db.query("DELETE FROM universe_fund_retry WHERE symbol = ?");
  for (let i = 0; i < queue.length && !stop; i += FUND_CONCURRENCY) {
    const batch = queue.slice(i, i + FUND_CONCURRENCY);
    await ctx.credits.ensure(COST.fundamentals * batch.length, creditKeep(ctx));
    ctx.progress(`${i}/${queue.length} this slice (${batch[0]})`);
    await Promise.all(
      batch.map(async (sym) => {
        const key = `fundamentals:${marketFor(db, sym).code}`;
        try {
          const data = await withRetry(async () => {
            try {
              return await ctx.limiter.run(() => ctx.refreshFundamentals(sym));
            } finally {
              ctx.credits.record(key, COST.fundamentals);
            }
          }, ctx.retry);
          const valid = data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0;
          storeDerived(db, sym, valid ? data : null, sec(ctx.now()), todayOf(sym), valid ? null : "empty payload");
          clearRetry.run(sym);
          markDirty(db, [sym]);
          ok++;
          streak = 0;
        } catch (e) {
          const st = errorStatus(e);
          const msg = ((e as Error)?.message ?? String(e)).slice(0, 200);
          if (st === 404 || st === 400 || st === 422) {
            // No fundamentals for this symbol: stored as empty, re-checked with the normal staleness cadence.
            storeDerived(db, sym, null, sec(ctx.now()), todayOf(sym), msg);
            clearRetry.run(sym);
            failed++;
            streak = 0;
          } else if (isGlobalFundamentalsError(e)) {
            stop = e; // key / rate limit / connectivity: end the slice, the scheduler backs off
          } else {
            // This symbol only (5xx, timeout, 402, bad payload): back off it and carry on with the queue.
            recordFundamentalsFailure(db, sym, sec(ctx.now()), msg);
            deferred++;
            if (++streak >= FUND_MAX_CONSECUTIVE_FAILURES) stop = e;
          }
        }
      }),
    );
    await ctx.yieldNow();
  }
  const count = runCount + ok + failed + deferred;
  if (stop) {
    kvSet(db, "fundamentals_run_count", String(count));
    throw stop;
  }
  const left = fundamentalsQueue(db, ctx.now(), utcDate(ctx.now()), 1, codes).length;
  const note = `${ok} refreshed${failed ? `, ${failed} unavailable` : ""}${deferred ? `, ${deferred} failed (retry later)` : ""}${picked ? `, ${picked} from cache` : ""}`;
  if (left > 0 && count >= ctx.fundamentalsMaxPerRun) {
    kvSet(db, "fundamentals_run_count", null);
    return { note: `${note}; run cap of ${ctx.fundamentalsMaxPerRun} reached, pausing`, nextRunAt: ctx.now() + FUNDAMENTALS_RUN_PAUSE_MS };
  }
  kvSet(db, "fundamentals_run_count", left > 0 ? String(count) : null);
  return { more: left > 0, note };
}

// ---------------------------------------------------------------- indices (weekly per market)
export async function runIndices(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const m = ctx.market!;
  if (!m.indices.length) return { note: "no index membership data for this market" };
  const notes: string[] = [];
  for (const idx of m.indices) {
    ctx.progress(`components ${idx.code}`);
    const raw = await call(ctx, COST.indexComponents, `/fundamentals/${idx.code}`, { filter: "Components" }, `${idx.code} components`);
    const members = parseIndexComponents(raw);
    if (members.length < idx.min) {
      notes.push(`${idx.code}: only ${members.length} components, kept previous`);
      continue;
    }
    const ins = db.query("INSERT OR IGNORE INTO universe_index_members (index_id, symbol) VALUES (?, ?)");
    db.transaction(() => {
      db.query("DELETE FROM universe_index_members WHERE index_id = ?").run(idx.id);
      for (const s of members) ins.run(idx.id, s);
      if (idx.col) {
        db.query(`UPDATE universe_symbols SET ${idx.col} = 0 WHERE market = ?`).run(m.code);
        db.query(`UPDATE universe_symbols SET ${idx.col} = 1 WHERE symbol IN (SELECT symbol FROM universe_index_members WHERE index_id = ?)`).run(idx.id);
      }
    })();
    notes.push(`${idx.id}: ${members.length}`);
  }
  // Rebuild the comma-wrapped membership list (",FTSE,FTMC,") of this market's symbols.
  db.query(
    `UPDATE universe_symbols SET indices = (SELECT ',' || group_concat(index_id, ',') || ',' FROM
       (SELECT index_id FROM universe_index_members WHERE symbol = universe_symbols.symbol ORDER BY index_id))
     WHERE market = ?`,
  ).run(m.code);
  markDirty(db, activeCodeMap(db, m.code).values());
  return { note: notes.join(", ") };
}

// ---------------------------------------------------------------- FX (daily)
/** Currencies whose USD rate the enabled markets need (quote currencies of active symbols + market defaults). */
export function neededFxSymbols(db: Database, markets: MarketDef[]): string[] {
  const codes = markets.map((m) => m.code);
  const curs = new Set<string>(markets.map((m) => m.currency));
  if (codes.length) {
    for (const r of db
      .query<{ currency: string | null }, string[]>(
        `SELECT DISTINCT currency FROM universe_symbols WHERE active = 1 AND market IN (${codes.map(() => "?").join(",")})`,
      )
      .all(...codes)) if (r.currency) curs.add(r.currency);
  }
  return fxSymbols(curs);
}

export async function runFx(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const syms = neededFxSymbols(db, ctx.markets);
  if (!syms.length) return { note: "USD only, no rates needed" };
  ctx.progress(`FX ${syms.join(", ")}`);
  const [first, ...rest] = syms;
  const raw = await call(ctx, COST.realtime * syms.length, `/real-time/${first}`, { s: rest.length ? rest.join(",") : undefined }, "FX rates");
  const rates = parseFxQuotes(raw);
  const up = db.query(
    "INSERT INTO universe_fx (currency, rate, fetched_at) VALUES (?, ?, ?) ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at",
  );
  db.transaction(() => {
    for (const [cur, rate] of rates) up.run(cur, rate, sec(ctx.now()));
  })();
  markAllDirty(db);
  const missing = syms.filter((s) => !rates.has(s.slice(0, 3)));
  return { note: `${rates.size} rates${missing.length ? `; missing ${missing.join(", ")}` : ""}` };
}

/** True when an enabled market's currency has no stored rate yet. */
export function fxMissing(db: Database, markets: MarketDef[]): boolean {
  const have = loadFxRates(db);
  return neededFxSymbols(db, markets).some((s) => !have.has(s.slice(0, 3)));
}

// ---------------------------------------------------------------- earnings calendar (worldwide, daily)
export async function runEarnings(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const codes = ctx.markets.map((m) => m.code);
  const universe = activeSymbols(db, codes);
  const utcToday = utcDate(ctx.now());
  const raw = await call(ctx, COST.calendar, "/calendar/earnings", { from: addDays(utcToday, -7), to: addDays(utcToday, 60) }, "earnings calendar");
  const tzToday = new Map(ctx.markets.map((m) => [m.code, marketToday(m, ctx.now())]));
  const bySym = earningsBySymbol(
    parseEarningsCalendar(raw, (s) => universe.has(s)),
    (s) => tzToday.get(marketOfSymbol(s) ?? "US") ?? utcToday,
  );
  const upd = db.query(
    `UPDATE universe_symbols SET earnings_date = ?, earnings_timing = ?,
       last_earnings_date = CASE WHEN ? IS NOT NULL AND (last_earnings_date IS NULL OR last_earnings_date < ?) THEN ? ELSE last_earnings_date END
     WHERE symbol = ?`,
  );
  let n = 0;
  db.transaction(() => {
    // Symbols absent from the window have no report in the next 60 days.
    db.query(
      `UPDATE universe_symbols SET earnings_date = NULL, earnings_timing = NULL WHERE earnings_date IS NOT NULL AND market IN (${codes.map(() => "?").join(",") || "''"})`,
    ).run(...codes);
    for (const [sym, e] of bySym) {
      const last = e.last;
      if (upd.run(e.next?.date ?? null, e.next?.timing ?? null, last, last, last, sym).changes) n++;
    }
  })();
  markDirty(db, universe);
  return { note: `${n} symbols with earnings in the window` };
}

// ---------------------------------------------------------------- news
// EODHD /news takes ~21s for 1000 articles (over the 20s request timeout) and ~10s for 250, so page small.
const NEWS_PAGE = 250;
const NEWS_MAX_PAGES = 8;

/**
 * EODHD /news works without s= (verified: returns the latest articles across all tickers, 5 credits per call).
 * Pages newest→older until the previous watermark, at most NEWS_MAX_PAGES per run.
 */
export async function runNews(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const nowS = sec(ctx.now());
  const watermark = Number(kvGet(db, "news_watermark") ?? 0) || nowS - 3 * 86400;
  const from = new Date(watermark * 1000).toISOString().slice(0, 10);
  const universe = activeSymbols(db, ctx.markets.map((m) => m.code));
  const latest = new Map<string, number>();
  let newest = watermark, articles = 0;
  for (let page = 0; page < NEWS_MAX_PAGES; page++) {
    ctx.progress(`news page ${page + 1}`);
    const raw = await call(ctx, COST.news, "/news", { from, limit: NEWS_PAGE, offset: page * NEWS_PAGE }, "latest news");
    const r = parseNews(raw);
    articles += r.count;
    for (const [s, t] of r.latest) {
      if (!universe.has(s) || t > nowS + 3600) continue;
      if ((latest.get(s) ?? 0) < t) latest.set(s, t);
      if (t > newest) newest = t;
    }
    if (r.count < NEWS_PAGE || (r.oldest !== null && r.oldest <= watermark)) break;
  }
  const upd = db.query("UPDATE universe_symbols SET latest_news_at = ? WHERE symbol = ? AND (latest_news_at IS NULL OR latest_news_at < ?)");
  const changed: string[] = [];
  db.transaction(() => {
    for (const [s, t] of latest) if (upd.run(t, s, t).changes) changed.push(s);
  })();
  markDirty(db, changed);
  kvSet(db, "news_watermark", String(newest));
  kvSet(db, "news_available", "1");
  return { note: `${articles} articles, ${changed.length} symbols updated` };
}

// ---------------------------------------------------------------- metrics
export async function runMetrics(ctx: JobCtx): Promise<JobResult> {
  const dirty = takeDirty(ctx.db);
  try {
    const n = await recomputeMetrics(ctx.db, {
      symbols: dirty,
      markets: ctx.markets,
      nowMs: ctx.now(),
      fx: loadFxRates(ctx.db),
      yieldFn: ctx.yieldNow,
      onProgress: (d, t) => ctx.progress(`${d}/${t}`),
    });
    bumpMetricsVersion();
    return { note: `${n} rows${dirty === null ? " (full)" : ""}${pruneOldBars(ctx)}` };
  } catch (e) {
    if (dirty === null) markAllDirty(ctx.db);
    else markDirty(ctx.db, dirty);
    throw e;
  }
}

export const RUNNERS: Record<JobName, (ctx: JobCtx) => Promise<JobResult>> = {
  symbols: runSymbols,
  prices: runPrices,
  fx: runFx,
  backfill: runBackfill,
  fundamentals: (ctx) => runFundamentals(ctx),
  indices: runIndices,
  earnings: runEarnings,
  news: runNews,
  metrics: runMetrics,
};
