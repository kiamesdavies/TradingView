// Database access for the universe pipeline (all functions take the Database so tests can use :memory:).
import type { Database } from "bun:sqlite";
import type { LongStats } from "./longstats";
import type { BulkBar, UniverseSymbolRow } from "./parsers";
import { kvGet, kvSet } from "./schema";

const nowSec = () => Math.floor(Date.now() / 1000);

export function upsertSymbols(db: Database, market: string, rows: UniverseSymbolRow[]): { total: number; deactivated: number } {
  const now = nowSec();
  const up = db.query(
    `INSERT INTO universe_symbols (symbol, code, name, exchange, kind, isin, active, first_seen, updated_at, market, currency)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET code = excluded.code, name = excluded.name, exchange = excluded.exchange,
       kind = excluded.kind, isin = excluded.isin, active = 1, updated_at = excluded.updated_at,
       market = excluded.market, currency = COALESCE(excluded.currency, universe_symbols.currency)`,
  );
  let deactivated = 0;
  db.transaction(() => {
    for (const r of rows) up.run(r.symbol, r.code, r.name, r.exchange, r.kind, r.isin, now, now, market, r.currency ?? null);
    // Anything of this market not refreshed now is gone from the exchange list → delisted.
    deactivated = db
      .query("UPDATE universe_symbols SET active = 0 WHERE market = ? AND active = 1 AND (updated_at IS NULL OR updated_at < ?)")
      .run(market, now).changes;
  })();
  return { total: rows.length, deactivated };
}

/** Active universe of one market: EODHD code ("BRK-B") → symbol ("BRK-B.US"). */
export function activeCodeMap(db: Database, market: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.query<{ code: string; symbol: string }, [string]>("SELECT code, symbol FROM universe_symbols WHERE active = 1 AND market = ?").all(market)) {
    m.set(r.code, r.symbol);
  }
  return m;
}

/** Active symbols of the given markets (all markets when omitted). */
export function activeSymbols(db: Database, markets?: string[]): Set<string> {
  const rows = markets
    ? db.query<{ symbol: string }, string[]>(`SELECT symbol FROM universe_symbols WHERE active = 1 AND market IN (${markets.map(() => "?").join(",") || "''"})`).all(...markets)
    : db.query<{ symbol: string }, []>("SELECT symbol FROM universe_symbols WHERE active = 1").all();
  return new Set(rows.map((r) => r.symbol));
}

export function countActive(db: Database, market?: string): number {
  return market
    ? db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM universe_symbols WHERE active = 1 AND market = ?").get(market)?.n ?? 0
    : db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM universe_symbols WHERE active = 1").get()?.n ?? 0;
}

/** Minimum stored rows for a bulk session to count as complete: 30% of the market's active symbols (≥ 1). */
export function minRowsFor(db: Database, market: string): number {
  return Math.max(1, Math.floor(countActive(db, market) * 0.3));
}

/** Store one bulk session (only universe symbols). Returns rows written for `date`. */
export function ingestBulk(db: Database, market: string, date: string, bars: BulkBar[], codes: Map<string, string>, extended: boolean): number {
  const ins = db.query(
    `INSERT INTO universe_bars (symbol, date, open, high, low, close, adj_close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, adj_close = excluded.adj_close, volume = excluded.volume`,
  );
  const ext = db.query(
    `UPDATE universe_symbols SET bulk_date = ?, bulk_mcap = ?, bulk_beta = ?, bulk_hi250 = ?, bulk_lo250 = ?, bulk_avgvol50 = ? WHERE symbol = ?`,
  );
  let n = 0;
  db.transaction(() => {
    for (const b of bars) {
      if (b.date !== date) continue;
      const symbol = codes.get(b.code);
      if (!symbol) continue;
      ins.run(symbol, b.date, b.open, b.high, b.low, b.close, b.adjClose, b.volume);
      if (extended) ext.run(b.date, b.marketCap, b.beta, b.hi250, b.lo250, b.avgVol50, symbol);
      n++;
    }
    // A bulk payload covers the whole session, so its row count is the date's count.
    db.query(
      `INSERT INTO universe_sessions (market, date, rows, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(market, date) DO UPDATE SET rows = excluded.rows, fetched_at = excluded.fetched_at`,
    ).run(market, date, n, nowSec());
  })();
  return n;
}

export interface EodRow { date: string; open: number; high: number; low: number; close: number; adjClose: number; volume: number }

/**
 * Replace a symbol's stored history with a freshly fetched one: rows on/after `cutoff` are written, stored rows
 * up to the fetched history's last date are dropped first (newer bulk rows are kept), and the dates are recorded
 * as sessions of `market`. Returns rows kept.
 */
export function storeHistory(db: Database, symbol: string, market: string, rows: EodRow[], cutoff: string): number {
  const keep = rows.filter((r) => r.date >= cutoff);
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const ins = db.query(
    `INSERT INTO universe_bars (symbol, date, open, high, low, close, adj_close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, adj_close = excluded.adj_close, volume = excluded.volume`,
  );
  const sess = db.query("INSERT OR IGNORE INTO universe_sessions (market, date, rows, fetched_at) VALUES (?, ?, NULL, NULL)");
  db.transaction(() => {
    if (last) db.query("DELETE FROM universe_bars WHERE symbol = ? AND date <= ?").run(symbol, last);
    for (const r of keep) {
      ins.run(symbol, r.date, r.open, r.high, r.low, r.close, r.adjClose, r.volume);
      sess.run(market, r.date);
    }
  })();
  return keep.length;
}

/** v2 name kept for the split re-pull path: replace history from `from` on. */
export function replaceHistory(db: Database, symbol: string, from: string, rows: EodRow[]): number {
  return storeHistory(db, symbol, db.query<{ market: string }, [string]>("SELECT market FROM universe_symbols WHERE symbol = ?").get(symbol)?.market ?? "US", rows, from);
}

export function firstBarDate(db: Database, symbol: string): string | null {
  return db.query<{ d: string | null }, [string]>("SELECT MIN(date) AS d FROM universe_bars WHERE symbol = ?").get(symbol)?.d ?? null;
}

/** Newest complete bulk session of a market. */
export function latestDate(db: Database, market: string): string | null {
  return db.query<{ d: string | null }, [string]>("SELECT MAX(date) AS d FROM universe_sessions WHERE market = ? AND rows > 0").get(market)?.d ?? null;
}

/** Newest complete session across the given markets. */
export function latestDateAny(db: Database, markets: string[]): string | null {
  let best: string | null = null;
  for (const m of markets) {
    const d = latestDate(db, m);
    if (d && (!best || d > best)) best = d;
  }
  return best;
}

/** Sessions stored for a market (from bulk files and per-ticker histories). */
export function sessionCount(db: Database, market: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM universe_sessions WHERE market = ?").get(market)?.n ?? 0;
}

/** The session before `date` that has bulk rows (for split detection). */
export function previousBulkDate(db: Database, market: string, date: string): string | null {
  return db.query<{ d: string | null }, [string, string]>("SELECT MAX(date) AS d FROM universe_sessions WHERE market = ? AND date < ? AND rows > 0").get(market, date)?.d ?? null;
}

/** Raw closes of a market's symbols on `date`. */
export function closesOn(db: Database, market: string, date: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of db
    .query<{ symbol: string; close: number }, [string, string]>(
      "SELECT b.symbol, b.close FROM universe_bars b JOIN universe_symbols s ON s.symbol = b.symbol WHERE s.market = ? AND b.date = ?",
    )
    .all(market, date)) out.set(r.symbol, r.close);
  return out;
}

export function holidays(db: Database, market: string): Set<string> {
  return new Set(db.query<{ date: string }, [string]>("SELECT date FROM universe_market_holidays WHERE market = ?").all(market).map((r) => r.date));
}

export function addHoliday(db: Database, market: string, date: string, source = "learned"): void {
  db.query("INSERT OR IGNORE INTO universe_market_holidays (market, date, source) VALUES (?, ?, ?)").run(market, date, source);
}

// ---------- full-history stats ----------
export interface LongRow {
  symbol: string; market: string; status: "ok" | "nodata" | "error" | "stale"; fetched_at: number; attempts: number; error: string | null;
  first_date: string | null; last_date: string | null; rows_total: number | null; rows_kept: number | null;
  ath: number | null; ath_date: string | null; atl: number | null; atl_date: string | null;
}

export function saveLongStats(db: Database, symbol: string, market: string, stats: LongStats | null, rowsKept: number, fetchedAt: number): void {
  db.query(
    `INSERT INTO universe_long (symbol, market, status, fetched_at, attempts, error, first_date, last_date, rows_total, rows_kept, ath, ath_date, atl, atl_date)
     VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET market = excluded.market, status = excluded.status, fetched_at = excluded.fetched_at, attempts = 0,
       error = NULL, first_date = excluded.first_date, last_date = excluded.last_date, rows_total = excluded.rows_total,
       rows_kept = excluded.rows_kept, ath = excluded.ath, ath_date = excluded.ath_date, atl = excluded.atl, atl_date = excluded.atl_date`,
  ).run(
    symbol, market, stats ? "ok" : "nodata", fetchedAt,
    stats?.firstDate ?? null, stats?.lastDate ?? null, stats?.rows ?? 0, rowsKept,
    stats?.ath ?? null, stats?.athDate ?? null, stats?.atl ?? null, stats?.atlDate ?? null,
  );
}

/** A failed fetch: earlier stats (if any) stay and are still used; counts the attempt. 404 → nodata. */
export function saveLongError(db: Database, symbol: string, market: string, error: string, fetchedAt: number, noData: boolean): void {
  db.query(
    `INSERT INTO universe_long (symbol, market, status, fetched_at, attempts, error) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(symbol) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at, attempts = universe_long.attempts + 1, error = excluded.error`,
  ).run(symbol, market, noData ? "nodata" : "error", fetchedAt, error.slice(0, 200));
}

/** Split/dividend: the stored history must be re-fetched (backfill handles 'stale' first). */
export function markStale(db: Database, symbols: Iterable<string>): number {
  const q = db.query("UPDATE universe_long SET status = 'stale', attempts = 0 WHERE symbol = ?");
  const ins = db.query(
    `INSERT OR IGNORE INTO universe_long (symbol, market, status, fetched_at, attempts)
     SELECT symbol, market, 'stale', 0, 0 FROM universe_symbols WHERE symbol = ?`,
  );
  let n = 0;
  db.transaction(() => {
    for (const s of symbols) {
      if (q.run(s).changes) n++;
      else if (ins.run(s).changes) n++;
    }
  })();
  return n;
}

// ---------- metrics dirty tracking ----------
export function markDirty(db: Database, symbols: Iterable<string>): void {
  const ins = db.query("INSERT OR IGNORE INTO universe_dirty (symbol) VALUES (?)");
  db.transaction(() => {
    for (const s of symbols) ins.run(s);
  })();
}

export function markAllDirty(db: Database): void {
  kvSet(db, "metrics_full", "1");
}

export function hasDirty(db: Database): boolean {
  return kvGet(db, "metrics_full") === "1" || !!db.query("SELECT 1 FROM universe_dirty LIMIT 1").get();
}

/** Returns null for "everything" or the dirty symbol list; clears the markers. */
export function takeDirty(db: Database): string[] | null {
  const full = kvGet(db, "metrics_full") === "1";
  const list = db.query<{ symbol: string }, []>("SELECT symbol FROM universe_dirty").all().map((r) => r.symbol);
  db.transaction(() => {
    kvSet(db, "metrics_full", null);
    db.exec("DELETE FROM universe_dirty");
  })();
  return full ? null : list;
}
