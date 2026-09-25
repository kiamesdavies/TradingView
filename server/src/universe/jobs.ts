// Universe pipeline jobs. Each job does a bounded slice of work and reports whether more remains;
// the scheduler (scheduler.ts) decides what runs when. All EODHD calls go through `call()`, which checks the
// credit budget first and records the spend in the ledger.
import type { Database } from "bun:sqlite";
import {
  expectedLatestSession,
  nextPriceAttemptAfter,
  nyParts,
  priceAttemptAt,
  recentSessions,
} from "./calendar";
import { BudgetExhausted, COST, type CreditGuard } from "./credits";
import { deriveFundamentals } from "./derive";
import { METRIC_LOOKBACK_SESSIONS, recomputeMetrics } from "./metrics";
import {
  dominantDate,
  earningsBySymbol,
  filterSymbolList,
  parseActions,
  parseBulk,
  parseEarningsCalendar,
  parseIndexComponents,
  parseNews,
} from "./parsers";
import { kvGet, kvSet } from "./schema";
import {
  activeCodeMap,
  addHoliday,
  firstBarDate,
  holidays,
  ingestBulk,
  latestDate,
  markAllDirty,
  markDirty,
  MIN_ROWS_PER_DATE,
  presentDates,
  replaceHistory,
  takeDirty,
  upsertSymbols,
  type EodRow,
} from "./store";
import { addDays, isoDate, num, values } from "./util";

export type JobName = "symbols" | "prices" | "backfill" | "fundamentals" | "indices" | "earnings" | "news" | "metrics";
export const JOB_NAMES: JobName[] = ["symbols", "prices", "earnings", "indices", "news", "metrics", "backfill", "fundamentals"];

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
  historyDays: number;
  progress(text: string | null): void;
  yieldNow(): Promise<void>;
  job: JobName;
}

export interface JobResult {
  /** More work is queued; run again soon. */
  more?: boolean;
  /** Explicit next run (ms); otherwise the scheduler's cadence applies. */
  nextRunAt?: number | null;
  note?: string;
}

const nySec = (ms: number) => Math.floor(ms / 1000);

async function call(ctx: JobCtx, cost: number, path: string, params: Record<string, string | number | undefined>, what: string): Promise<unknown> {
  await ctx.credits.ensure(cost);
  try {
    return await ctx.api.raw(path, params, what);
  } finally {
    ctx.credits.record(ctx.job, cost);
  }
}

function status(e: unknown): number | undefined {
  const s = (e as { upstreamStatus?: number; status?: number })?.upstreamStatus ?? (e as { status?: number })?.status;
  return typeof s === "number" ? s : undefined;
}

// ---------------------------------------------------------------- symbols
export async function runSymbols(ctx: JobCtx): Promise<JobResult> {
  ctx.progress("downloading symbol list");
  const raw = await call(ctx, COST.symbolList, "/exchange-symbol-list/US", {}, "US symbol list");
  const rows = filterSymbolList(raw);
  if (rows.length < 2000) throw new Error(`symbol list looks incomplete (${rows.length} listed stocks/ETFs); keeping the current universe`);
  const r = upsertSymbols(ctx.db, rows);
  markAllDirty(ctx.db);
  const stocks = rows.filter((x) => x.kind === "stock").length;
  return { note: `${stocks} stocks, ${rows.length - stocks} ETFs, ${r.deactivated} delisted` };
}

// ---------------------------------------------------------------- prices (latest session)
/** When the prices job should next run (ms), given the newest stored session and the last attempt. */
export function pricesNextRun(now: number, latest: string | null, hol: ReadonlySet<string>, lastAttempt: number | null): number {
  if (!latest) return now;
  const expected = expectedLatestSession(now, hol);
  if (latest >= expected) return nextPriceAttemptAfter(latest, hol);
  // Behind: attempt now (we are past the expected session's 18:30 NY), then hourly until it appears.
  if (!lastAttempt || lastAttempt < priceAttemptAt(expected)) return now;
  return Math.max(now, lastAttempt + 3600_000);
}

export async function runPrices(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const hol = holidays(db);
  const before = latestDate(db);
  const expected = expectedLatestSession(ctx.now(), hol);
  ctx.progress("downloading latest session (bulk)");
  const raw = await call(ctx, COST.bulk, "/eod-bulk-last-day/US", { filter: "extended" }, "US bulk EOD");
  const bars = parseBulk(raw);
  const date = dominantDate(bars);
  kvSet(db, "prices_last_attempt", String(ctx.now()));
  let note: string;
  if (!date || bars.length < MIN_ROWS_PER_DATE) {
    note = `bulk returned ${bars.length} rows`;
  } else {
    const n = ingestBulk(db, date, bars, activeCodeMap(db), true);
    markAllDirty(db);
    note = `${date}: ${n} symbols`;
    if (!kvGet(db, "actions_through")) kvSet(db, "actions_through", date);
    await applyCorporateActions(ctx, date);
    note += pruneOldBars(ctx, date);
  }
  const after = latestDate(db);
  if (date && after === date && isPartial(db, date)) {
    // EODHD sometimes publishes a session progressively: re-pull within the hour until it is complete.
    return { note: `${note} (partial, re-checking)`, nextRunAt: ctx.now() + 3600_000 };
  }
  if (after && after >= expected) {
    kvSet(db, "prices_attempts", null);
    return { note, nextRunAt: nextPriceAttemptAfter(after, hol) };
  }
  // Not published yet (or a market holiday): retry hourly; after 8 misses treat the session as a holiday.
  const [prevDate, prevN] = (kvGet(db, "prices_attempts") ?? "").split(":");
  const attempts = prevDate === expected ? Number(prevN || 0) + 1 : 1;
  kvSet(db, "prices_attempts", `${expected}:${attempts}`);
  if (attempts >= 8 && before !== null) {
    addHoliday(db, expected);
    kvSet(db, "prices_attempts", null);
    return { note: `${note}; ${expected} not published after ${attempts} attempts, treated as a holiday`, nextRunAt: nextPriceAttemptAfter(expected, holidays(db)) };
  }
  return { note: `${note}; waiting for ${expected}`, nextRunAt: ctx.now() + 3600_000 };
}

/** A session with clearly fewer rows than the previous stored one. */
function isPartial(db: Database, date: string): boolean {
  const rows = db.query<{ date: string; rows: number }, [string]>(
    "SELECT date, rows FROM universe_dates WHERE date <= ? ORDER BY date DESC LIMIT 2",
  ).all(date);
  return rows.length === 2 && rows[0]!.date === date && rows[0]!.rows < rows[1]!.rows * 0.9;
}

const REPULL_CONCURRENCY = 4;
/** Sessions of splits/dividends examined per catch-up; after a longer outage older actions are skipped. */
export const ACTIONS_CATCHUP_SESSIONS = 10;
/** A failed re-pull is retried on later prices runs, then dropped (delisted / no data). */
const REPULL_MAX_ATTEMPTS = 5;

type Pending = Record<string, { date: string; attempts: number }>;

function pendingRepulls(db: Database): Pending {
  try {
    const v = JSON.parse(kvGet(db, "repull_pending") ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Re-pull each symbol's stored history from /eod; returns the symbols whose re-pull failed (not budget). */
async function repullHistories(ctx: JobCtx, syms: string[], label: string): Promise<string[]> {
  const { db } = ctx;
  const todo = syms.map((sym) => ({ sym, first: firstBarDate(db, sym) })).filter((x) => x.first);
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i += REPULL_CONCURRENCY) {
    ctx.progress(`re-pulling history after ${label}: ${i}/${todo.length}`);
    await Promise.all(
      todo.slice(i, i + REPULL_CONCURRENCY).map(async ({ sym, first }) => {
        try {
          const rows = parseEod(await call(ctx, COST.eod, `/eod/${encodeURIComponent(sym)}`, { from: first! }, `${sym} history`));
          replaceHistory(db, sym, first!, rows);
          markDirty(db, [sym]);
        } catch (e) {
          if (e instanceof BudgetExhausted) throw e;
          console.warn(`[universe] history re-pull failed for ${sym}:`, (e as Error).message);
          failed.push(sym);
        }
      }),
    );
    await ctx.yieldNow();
  }
  return failed;
}

/**
 * Keep stored adjusted closes consistent across splits and dividends. For every session after the
 * `actions_through` watermark, read EODHD's split and dividend lists for that date; each affected universe
 * symbol with older stored rows gets its history re-pulled from /eod (1 credit), which returns
 * adjusted_close restated as of today. Rows fetched afterwards are already restated. A re-pull that fails
 * is queued in `repull_pending` and retried on later runs, so the watermark can still advance.
 */
export async function applyCorporateActions(ctx: JobCtx, latest: string): Promise<void> {
  const { db } = ctx;
  const active = new Set(activeCodeMap(db).values());

  // 1. retry earlier failed re-pulls
  const pending = pendingRepulls(db);
  const retry = Object.keys(pending).filter((s) => active.has(s));
  for (const s of Object.keys(pending)) if (!active.has(s)) delete pending[s];
  if (retry.length) {
    const failed = new Set(await repullHistories(ctx, retry, "earlier failures"));
    for (const s of retry) {
      if (!failed.has(s)) delete pending[s];
      else if (++pending[s]!.attempts >= REPULL_MAX_ATTEMPTS) {
        console.warn(`[universe] giving up on history re-pull for ${s} after ${pending[s]!.attempts} attempts`);
        delete pending[s];
      }
    }
    kvSet(db, "repull_pending", Object.keys(pending).length ? JSON.stringify(pending) : null);
  }

  // 2. new sessions since the watermark: the most recent ones, oldest first
  const through = kvGet(db, "actions_through");
  if (!through || through >= latest) return;
  const hol = holidays(db);
  const recent = recentSessions(latest, ACTIONS_CATCHUP_SESSIONS, hol).filter((d) => d > through).reverse();
  const codes = activeCodeMap(db);
  for (const d of recent) {
    ctx.progress(`checking splits/dividends ${d}`);
    const affected = new Set<string>();
    for (const kind of ["splits", "dividends"] as const) {
      const raw = await call(ctx, COST.bulk, "/eod-bulk-last-day/US", { type: kind, date: d }, `US ${kind} ${d}`);
      for (const a of parseActions(raw, kind === "splits" ? "split" : "dividend")) {
        const sym = codes.get(a.code);
        if (sym && a.date === d) affected.add(sym);
      }
    }
    const todo = [...affected].filter((sym) => {
      const first = firstBarDate(db, sym);
      return first && first < d;
    });
    const failed = await repullHistories(ctx, todo, `splits/dividends on ${d}`);
    if (failed.length) {
      const p = pendingRepulls(db);
      for (const s of failed) p[s] = { date: d, attempts: p[s]?.attempts ?? 0 };
      kvSet(db, "repull_pending", JSON.stringify(p));
    }
    kvSet(db, "actions_through", d);
  }
  kvSet(db, "actions_through", latest);
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

// ---------------------------------------------------------------- backfill
export const BACKFILL_DATES_PER_SLICE = 20;

export function missingSessions(db: Database, anchor: string, historyDays: number): string[] {
  const have = presentDates(db);
  return recentSessions(anchor, historyDays, holidays(db)).filter((d) => !have.has(d));
}

export async function runBackfill(ctx: JobCtx): Promise<JobResult> {
  const { db } = ctx;
  const anchor = latestDate(db) ?? expectedLatestSession(ctx.now(), holidays(db));
  const missing = missingSessions(db, anchor, ctx.historyDays);
  if (!missing.length) return { note: "history complete" };
  const codes = activeCodeMap(db);
  const slice = missing.slice(0, BACKFILL_DATES_PER_SLICE);
  let done = 0, holidaysFound = 0;
  for (const d of slice) {
    ctx.progress(`${ctx.historyDays - missing.length + done}/${ctx.historyDays} sessions (fetching ${d})`);
    const raw = await call(ctx, COST.bulk, "/eod-bulk-last-day/US", { date: d }, `US bulk EOD ${d}`);
    const bars = parseBulk(raw);
    const day = dominantDate(bars);
    if (bars.length < MIN_ROWS_PER_DATE || day !== d) {
      addHoliday(db, d);
      holidaysFound++;
    } else {
      ingestBulk(db, d, bars, codes, false);
    }
    done++;
    await ctx.yieldNow();
  }
  markAllDirty(db);
  const left = missingSessions(db, anchor, ctx.historyDays).length;
  return { more: left > 0, note: `${done} dates fetched${holidaysFound ? `, ${holidaysFound} holidays` : ""}, ${left} missing` };
}

/** Weekly: drop bars older than the history window (plus the metrics look-back). */
function pruneOldBars(ctx: JobCtx, anchor: string): string {
  const { db } = ctx;
  const last = Number(kvGet(db, "pruned_at") ?? 0);
  if (ctx.now() - last < 7 * 86400_000) return "";
  const keep = Math.max(ctx.historyDays, METRIC_LOOKBACK_SESSIONS) + 10;
  const sessions = recentSessions(anchor, keep, holidays(db));
  const cutoff = sessions[sessions.length - 1]!;
  const n = db.query("DELETE FROM universe_bars WHERE date < ?").run(cutoff).changes;
  db.query("DELETE FROM universe_dates WHERE date < ?").run(cutoff);
  kvSet(db, "pruned_at", String(ctx.now()));
  return n ? `, pruned ${n} rows before ${cutoff}` : "";
}

// ---------------------------------------------------------------- fundamentals
export const FUNDAMENTALS_PER_SLICE = 80;
const FUND_CONCURRENCY = 4;

/** Next symbols to refresh, in priority order. */
export function fundamentalsQueue(db: Database, nowMs: number, today: string, limit: number): string[] {
  const now = nySec(nowMs);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (sql: string, ...args: (string | number)[]) => {
    if (out.length >= limit) return;
    for (const r of db.query<{ symbol: string }, (string | number)[]>(sql).all(...args)) {
      if (out.length >= limit) break;
      if (!seen.has(r.symbol)) { seen.add(r.symbol); out.push(r.symbol); }
    }
  };
  // 1. stocks never fetched, most traded first
  take(
    `SELECT s.symbol FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol
     LEFT JOIN universe_metrics m ON m.symbol = s.symbol
     WHERE s.active = 1 AND s.kind = 'stock' AND f.symbol IS NULL
     ORDER BY m.dollar_volume IS NULL, m.dollar_volume DESC, s.symbol LIMIT ?`, limit);
  // 2. stocks that reported since their last fetch (EODHD updates the day after the report)
  take(
    `SELECT s.symbol FROM universe_symbols s JOIN universe_fund f ON f.symbol = s.symbol
     WHERE s.active = 1 AND s.kind = 'stock' AND s.last_earnings_date IS NOT NULL AND s.last_earnings_date < ?
       AND f.fundamentals_at < CAST(strftime('%s', s.last_earnings_date, '+1 day') AS INTEGER)
     ORDER BY s.last_earnings_date DESC LIMIT ?`, today, limit);
  // 3. stale stocks, oldest first
  take(
    `SELECT s.symbol FROM universe_symbols s JOIN universe_fund f ON f.symbol = s.symbol
     WHERE s.active = 1 AND s.kind = 'stock' AND f.fundamentals_at < ? ORDER BY f.fundamentals_at LIMIT ?`, now - 7 * 86400, limit);
  // 4. ETFs never fetched (most traded first) or older than 30 days
  take(
    `SELECT s.symbol FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol
     LEFT JOIN universe_metrics m ON m.symbol = s.symbol
     WHERE s.active = 1 AND s.kind = 'etf' AND (f.symbol IS NULL OR f.fundamentals_at < ?)
     ORDER BY f.symbol IS NOT NULL, f.fundamentals_at, m.dollar_volume IS NULL, m.dollar_volume DESC, s.symbol LIMIT ?`,
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

export async function runFundamentals(ctx: JobCtx, limit = FUNDAMENTALS_PER_SLICE): Promise<JobResult> {
  const { db } = ctx;
  const today = nyParts(ctx.now()).date;
  // Free: pick up fundamentals the details API fetched on demand.
  let picked = 0;
  for (const r of ctx.externallyRefreshed?.(500) ?? []) {
    storeDerived(db, r.symbol, r.data, r.fetchedAt, today, null);
    markDirty(db, [r.symbol]);
    picked++;
  }
  const queue = fundamentalsQueue(db, ctx.now(), today, limit);
  if (!queue.length) return { note: picked ? `${picked} picked up from cache` : "up to date" };
  let ok = 0, failed = 0;
  let stop: unknown = null;
  for (let i = 0; i < queue.length && !stop; i += FUND_CONCURRENCY) {
    const batch = queue.slice(i, i + FUND_CONCURRENCY);
    await ctx.credits.ensure(COST.fundamentals * batch.length);
    ctx.progress(`${i}/${queue.length} this slice (${batch[0]})`);
    await Promise.all(
      batch.map(async (sym) => {
        try {
          const data = await ctx.refreshFundamentals(sym);
          ctx.credits.record(ctx.job, COST.fundamentals);
          const valid = data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length > 0;
          storeDerived(db, sym, valid ? data : null, nySec(ctx.now()), today, valid ? null : "empty payload");
          markDirty(db, [sym]);
          ok++;
        } catch (e) {
          ctx.credits.record(ctx.job, COST.fundamentals);
          const st = status(e);
          if (st === 404 || st === 400 || st === 422) {
            storeDerived(db, sym, null, nySec(ctx.now()), today, (e as Error).message.slice(0, 200));
            failed++;
          } else {
            stop = e; // network / rate limit / key problems: end the slice
          }
        }
      }),
    );
    await ctx.yieldNow();
  }
  if (stop) throw stop;
  const left = fundamentalsQueue(db, ctx.now(), today, 1).length;
  return { more: left > 0, note: `${ok} refreshed${failed ? `, ${failed} unavailable` : ""}${picked ? `, ${picked} from cache` : ""}` };
}

// ---------------------------------------------------------------- indices
const INDICES: Array<{ code: string; col: "in_sp500" | "in_ndx" | "in_dji"; min: number }> = [
  { code: "GSPC.INDX", col: "in_sp500", min: 400 },
  { code: "NDX.INDX", col: "in_ndx", min: 80 },
  { code: "DJI.INDX", col: "in_dji", min: 25 },
];

export async function runIndices(ctx: JobCtx): Promise<JobResult> {
  const notes: string[] = [];
  for (const idx of INDICES) {
    ctx.progress(`components ${idx.code}`);
    const raw = await call(ctx, COST.indexComponents, `/fundamentals/${idx.code}`, { filter: "Components" }, `${idx.code} components`);
    const members = parseIndexComponents(raw);
    if (members.length < idx.min) {
      notes.push(`${idx.code}: only ${members.length} components, kept previous`);
      continue;
    }
    const set = new Set(members);
    const upd = ctx.db.query(`UPDATE universe_symbols SET ${idx.col} = ? WHERE symbol = ?`);
    ctx.db.transaction(() => {
      ctx.db.exec(`UPDATE universe_symbols SET ${idx.col} = 0`);
      for (const s of set) upd.run(1, s);
    })();
    notes.push(`${idx.code}: ${members.length}`);
  }
  markAllDirty(ctx.db);
  return { note: notes.join(", ") };
}

// ---------------------------------------------------------------- earnings calendar
export async function runEarnings(ctx: JobCtx): Promise<JobResult> {
  const today = nyParts(ctx.now()).date;
  const raw = await call(ctx, COST.calendar, "/calendar/earnings", { from: addDays(today, -7), to: addDays(today, 60) }, "earnings calendar");
  const bySym = earningsBySymbol(parseEarningsCalendar(raw), today);
  const { db } = ctx;
  const upd = db.query(
    `UPDATE universe_symbols SET earnings_date = ?, earnings_timing = ?,
       last_earnings_date = CASE WHEN ? IS NOT NULL AND (last_earnings_date IS NULL OR last_earnings_date < ?) THEN ? ELSE last_earnings_date END
     WHERE symbol = ?`,
  );
  let n = 0;
  db.transaction(() => {
    // Symbols absent from the window have no report in the next 60 days.
    db.exec("UPDATE universe_symbols SET earnings_date = NULL, earnings_timing = NULL WHERE earnings_date IS NOT NULL");
    for (const [sym, e] of bySym) {
      const last = e.last;
      if (upd.run(e.next?.date ?? null, e.next?.timing ?? null, last, last, last, sym).changes) n++;
    }
  })();
  markAllDirty(db);
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
  const nowS = nySec(ctx.now());
  const watermark = Number(kvGet(db, "news_watermark") ?? 0) || nowS - 3 * 86400;
  const from = new Date(watermark * 1000).toISOString().slice(0, 10);
  const universe = new Set(activeCodeMap(db).values());
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
      today: nyParts(ctx.now()).date,
      yieldFn: ctx.yieldNow,
      onProgress: (d, t) => ctx.progress(`${d}/${t}`),
    });
    return { note: `${n} rows${dirty === null ? " (full)" : ""}` };
  } catch (e) {
    if (dirty === null) markAllDirty(ctx.db);
    else markDirty(ctx.db, dirty);
    throw e;
  }
}

export const RUNNERS: Record<JobName, (ctx: JobCtx) => Promise<JobResult>> = {
  symbols: runSymbols,
  prices: runPrices,
  backfill: runBackfill,
  fundamentals: (ctx) => runFundamentals(ctx),
  indices: runIndices,
  earnings: runEarnings,
  news: runNews,
  metrics: runMetrics,
};
