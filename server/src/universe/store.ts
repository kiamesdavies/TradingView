// Database access for the universe pipeline (all functions take the Database so tests can use :memory:).
import type { Database } from "bun:sqlite";
import type { BulkBar, UniverseSymbolRow } from "./parsers";
import { kvGet, kvSet } from "./schema";

const nowSec = () => Math.floor(Date.now() / 1000);

/** Minimum stored rows for a session date to count as present (a real US session has ~10k universe rows). */
export const MIN_ROWS_PER_DATE = 1000;

export function upsertSymbols(db: Database, rows: UniverseSymbolRow[]): { total: number; deactivated: number } {
  const now = nowSec();
  const up = db.query(
    `INSERT INTO universe_symbols (symbol, code, name, exchange, kind, isin, active, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET code = excluded.code, name = excluded.name, exchange = excluded.exchange,
       kind = excluded.kind, isin = excluded.isin, active = 1, updated_at = excluded.updated_at`,
  );
  let deactivated = 0;
  db.transaction(() => {
    for (const r of rows) up.run(r.symbol, r.code, r.name, r.exchange, r.kind, r.isin, now, now);
    // Anything not refreshed now is gone from the exchange list → delisted.
    deactivated = db.query("UPDATE universe_symbols SET active = 0 WHERE active = 1 AND (updated_at IS NULL OR updated_at < ?)").run(now).changes;
  })();
  return { total: rows.length, deactivated };
}

/** Active universe: EODHD code ("BRK-B") → symbol ("BRK-B.US"). */
export function activeCodeMap(db: Database): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of db.query<{ code: string; symbol: string }, []>("SELECT code, symbol FROM universe_symbols WHERE active = 1").all()) {
    m.set(r.code, r.symbol);
  }
  return m;
}

export function countActive(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM universe_symbols WHERE active = 1").get()?.n ?? 0;
}

/** Store one bulk session (only universe symbols). Returns rows written for `date`. */
export function ingestBulk(db: Database, date: string, bars: BulkBar[], codes: Map<string, string>, extended: boolean): number {
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
      `INSERT INTO universe_dates (date, rows, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET rows = excluded.rows, fetched_at = excluded.fetched_at`,
    ).run(date, n, nowSec());
  })();
  return n;
}

export interface EodRow { date: string; open: number; high: number; low: number; close: number; adjClose: number; volume: number }

/** Replace a symbol's stored history from `from` on (after a split/dividend re-pull). */
export function replaceHistory(db: Database, symbol: string, from: string, rows: EodRow[]): number {
  const ins = db.query(
    `INSERT INTO universe_bars (symbol, date, open, high, low, close, adj_close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, adj_close = excluded.adj_close, volume = excluded.volume`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (r.date < from) continue;
      ins.run(symbol, r.date, r.open, r.high, r.low, r.close, r.adjClose, r.volume);
      n++;
    }
  })();
  return n;
}

export function firstBarDate(db: Database, symbol: string): string | null {
  return db.query<{ d: string | null }, [string]>("SELECT MIN(date) AS d FROM universe_bars WHERE symbol = ?").get(symbol)?.d ?? null;
}

export function latestDate(db: Database): string | null {
  return db.query<{ d: string | null }, [number]>("SELECT MAX(date) AS d FROM universe_dates WHERE rows >= ?").get(MIN_ROWS_PER_DATE)?.d ?? null;
}

export function presentDates(db: Database): Set<string> {
  return new Set(
    db.query<{ date: string }, [number]>("SELECT date FROM universe_dates WHERE rows >= ?").all(MIN_ROWS_PER_DATE).map((r) => r.date),
  );
}

export function holidays(db: Database): Set<string> {
  return new Set(db.query<{ date: string }, []>("SELECT date FROM universe_holidays").all().map((r) => r.date));
}

export function addHoliday(db: Database, date: string): void {
  db.query("INSERT OR IGNORE INTO universe_holidays (date) VALUES (?)").run(date);
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
