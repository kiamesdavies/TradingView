// Shared per-ticker fundamentals cache (EODHD /fundamentals, 10 API credits per call).
// Used by the details API (on demand) and the universe pipeline (rolling refresh).
import { db } from "../db";
import { eodhd } from "../eodhd/client";

db.exec(`CREATE TABLE IF NOT EXISTS fundamentals (
  symbol TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
)`);

/** Raw EODHD fundamentals JSON (General, Highlights, Valuation, SharesStats, Technicals, SplitsDividends,
 *  AnalystRatings, Holders, InsiderTransactions, Earnings{History,Trend,Annual}, Financials, ETF_Data…). */
export type RawFundamentals = Record<string, any>;

const selectStmt = db.query<{ data: string; fetched_at: number }, [string]>(
  "SELECT data, fetched_at FROM fundamentals WHERE symbol = ?",
);
const upsertStmt = db.query(
  "INSERT INTO fundamentals (symbol, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at",
);

const nowSec = () => Math.floor(Date.now() / 1000);
const inflight = new Map<string, Promise<RawFundamentals>>();

export function getCachedFundamentals(symbol: string): { data: RawFundamentals; fetchedAt: number } | null {
  const row = selectStmt.get(symbol);
  return row ? { data: JSON.parse(row.data), fetchedAt: row.fetched_at } : null;
}

/** Fetch from EODHD and store. Returns the fresh JSON. */
export async function refreshFundamentals(symbol: string): Promise<RawFundamentals> {
  const pending = inflight.get(symbol);
  if (pending) return pending;
  const p = (async () => {
    const data = (await eodhd.raw(`/fundamentals/${encodeURIComponent(symbol)}`, {}, `${symbol} fundamentals`)) as RawFundamentals;
    upsertStmt.run(symbol, JSON.stringify(data), nowSec());
    return data;
  })().finally(() => inflight.delete(symbol));
  inflight.set(symbol, p);
  return p;
}

/** Cached fundamentals if younger than maxAgeSec, else refetch. Falls back to stale cache when EODHD fails. */
export async function getFundamentals(symbol: string, maxAgeSec = 24 * 3600): Promise<RawFundamentals> {
  const cached = getCachedFundamentals(symbol);
  if (cached && nowSec() - cached.fetchedAt < maxAgeSec) return cached.data;
  try {
    return await refreshFundamentals(symbol);
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
}
