// Recompute universe_metrics rows from stored bars + derived fundamentals + reference data.
import type { Database } from "bun:sqlite";
import { METRIC_COLUMNS, METRICS_TABLE } from "./metricsSchema";
import { priceDependent, STATIC_FUND_COLUMNS, type DerivedFundamentals } from "./derive";
import { computeTechnicals, type SymbolBars } from "./technicals";

/** Sessions of history read per symbol (SMA200 + 52-week window + YTD base + RSI warm-up). */
export const METRIC_LOOKBACK_SESSIONS = 320;
const CHUNK = 400;

interface SymRow {
  symbol: string; code: string; name: string | null; kind: string; exchange: string | null;
  in_sp500: number; in_ndx: number; in_dji: number;
  earnings_date: string | null; earnings_timing: string | null; last_earnings_date: string | null;
  latest_news_at: number | null;
  bulk_mcap: number | null; bulk_beta: number | null; bulk_hi250: number | null; bulk_lo250: number | null; bulk_avgvol50: number | null;
  fundamentals_at: number | null; fund: string | null;
}

type BarTuple = [string, string, number, number, number, number, number, number];

function emptyBars(): SymbolBars {
  return { date: [], open: [], high: [], low: [], close: [], adjClose: [], volume: [] };
}

export interface RecomputeOptions {
  /** null = all active symbols */
  symbols: string[] | null;
  today: string; // NY date, for "next earnings on/after today"
  yieldFn?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

export async function recomputeMetrics(db: Database, o: RecomputeOptions): Promise<number> {
  const cutoff =
    db.query<{ date: string }, [number]>("SELECT date FROM universe_dates ORDER BY date DESC LIMIT 1 OFFSET ?").get(METRIC_LOOKBACK_SESSIONS - 1)?.date ??
    "0000-00-00";
  const universeFirst = db.query<{ d: string | null }, []>("SELECT MIN(date) AS d FROM universe_dates").get()?.d ?? null;

  const baseSql = `SELECT s.symbol, s.code, s.name, s.kind, s.exchange, s.in_sp500, s.in_ndx, s.in_dji,
      s.earnings_date, s.earnings_timing, s.last_earnings_date, s.latest_news_at,
      s.bulk_mcap, s.bulk_beta, s.bulk_hi250, s.bulk_lo250, s.bulk_avgvol50,
      f.fundamentals_at, f.data AS fund
    FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol
    WHERE s.active = 1`;
  let syms: SymRow[];
  if (o.symbols === null) {
    syms = db.query<SymRow, []>(`${baseSql} ORDER BY s.symbol`).all();
  } else {
    const q = db.query<SymRow, [string]>(`${baseSql} AND s.symbol = ?`);
    syms = [...new Set(o.symbols)].sort().map((s) => q.get(s)).filter((r): r is SymRow => !!r);
  }

  const rangeQ = db.query<BarTuple, [string, string, string]>(
    `SELECT symbol, date, open, high, low, close, adj_close, volume FROM universe_bars
     WHERE symbol >= ? AND symbol <= ? AND date >= ? ORDER BY symbol, date`,
  );
  const oneQ = db.query<BarTuple, [string, string]>(
    `SELECT symbol, date, open, high, low, close, adj_close, volume FROM universe_bars WHERE symbol = ? AND date >= ? ORDER BY date`,
  );

  const rows: Record<string, number | string | null>[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < syms.length; i += CHUNK) {
    const chunk = syms.slice(i, i + CHUNK);
    const bars = new Map<string, SymbolBars>();
    const add = (t: BarTuple) => {
      let b = bars.get(t[0]);
      if (!b) bars.set(t[0], (b = emptyBars()));
      b.date.push(t[1]); b.open.push(t[2]); b.high.push(t[3]); b.low.push(t[4]); b.close.push(t[5]); b.adjClose.push(t[6]); b.volume.push(t[7]);
    };
    if (o.symbols === null) {
      for (const t of rangeQ.values(chunk[0]!.symbol, chunk[chunk.length - 1]!.symbol, cutoff) as BarTuple[]) add(t);
    } else {
      for (const s of chunk) for (const t of oneQ.values(s.symbol, cutoff) as BarTuple[]) add(t);
    }
    for (const s of chunk) rows.push(composeRow(s, bars.get(s.symbol) ?? emptyBars(), universeFirst, o.today, now));
    o.onProgress?.(Math.min(i + CHUNK, syms.length), syms.length);
    if (o.yieldFn) await o.yieldFn();
  }

  const cols = METRIC_COLUMNS.map((c) => c.col);
  const upsert = db.query(
    `INSERT OR REPLACE INTO ${METRICS_TABLE} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  );
  db.transaction(() => {
    if (o.symbols === null) {
      db.exec(`DELETE FROM ${METRICS_TABLE} WHERE symbol NOT IN (SELECT symbol FROM universe_symbols WHERE active = 1)`);
    }
    for (const r of rows) upsert.run(...(cols.map((c) => r[c] ?? null) as (string | number | null)[]));
  })();
  return rows.length;
}

export function composeRow(s: SymRow, bars: SymbolBars, universeFirst: string | null, today: string, now: number): Record<string, number | string | null> {
  const row: Record<string, number | string | null> = {};
  let fund: DerivedFundamentals | null = null;
  if (s.fund) {
    try { fund = JSON.parse(s.fund) as DerivedFundamentals; } catch { fund = null; }
  }
  row.symbol = s.symbol;
  row.code = s.code;
  row.name = s.name;
  row.kind = s.kind;
  row.exchange = s.exchange;
  row.in_sp500 = s.in_sp500 ? 1 : 0;
  row.in_ndx = s.in_ndx ? 1 : 0;
  row.in_dji = s.in_dji ? 1 : 0;

  if (fund?.cols) for (const c of STATIC_FUND_COLUMNS) row[c] = fund.cols[c] ?? null;

  const listedWithinHistory = !!(universeFirst && bars.date.length && bars.date[0]! > universeFirst);
  const tech = computeTechnicals(bars, {
    listedWithinHistory,
    bulk: { hi250: s.bulk_hi250, lo250: s.bulk_lo250, avgVol50: s.bulk_avgvol50 },
  });
  Object.assign(row, tech);

  const price = typeof tech.price === "number" ? tech.price : null;
  if (fund?.inputs) Object.assign(row, priceDependent(fund.inputs, price));
  if (row.market_cap == null && s.kind === "stock" && s.bulk_mcap && s.bulk_mcap > 0) row.market_cap = s.bulk_mcap;
  if (row.beta == null && s.bulk_beta !== null && s.kind === "stock" && s.bulk_beta !== 0) row.beta = s.bulk_beta;

  // Earnings: the calendar job is authoritative; fundamentals' Earnings.History fills gaps.
  const fNext = fund?.earnings?.next && fund.earnings.next.date >= today ? fund.earnings.next : null;
  if (s.earnings_date && s.earnings_date >= today) {
    row.earnings_date = s.earnings_date;
    row.earnings_timing = s.earnings_timing;
  } else if (fNext) {
    row.earnings_date = fNext.date;
    row.earnings_timing = fNext.timing;
  } else {
    row.earnings_date = null;
    row.earnings_timing = null;
  }
  const lasts = [s.last_earnings_date, fund?.earnings?.last ?? null].filter((d): d is string => !!d && d <= today).sort();
  row.last_earnings_date = lasts.pop() ?? null;
  row.latest_news_at = s.latest_news_at;
  row.fundamentals_at = s.fundamentals_at;
  row.updated_at = now;
  return row;
}

/** Adjusted closes (on the latest bar's basis), ascending, for the last `days` sessions of each symbol. */
export function getSparklinesFrom(db: Database, symbols: string[], days: number): Record<string, number[]> {
  const n = Math.max(2, Math.min(Math.floor(days) || 60, 400));
  const q = db.query<{ close: number; adj_close: number }, [string, number]>(
    "SELECT close, adj_close FROM universe_bars WHERE symbol = ? ORDER BY date DESC LIMIT ?",
  );
  const out: Record<string, number[]> = {};
  for (const sym of [...new Set(symbols)].slice(0, 1000)) {
    const rows = q.all(sym, n);
    if (!rows.length) { out[sym] = []; continue; }
    const last = rows[0]!;
    const k = last.adj_close > 0 ? last.close / last.adj_close : 1;
    out[sym] = rows.reverse().map((r) => {
      const adj = r.adj_close > 0 ? r.adj_close : r.close;
      return Math.round(adj * k * 10000) / 10000;
    });
  }
  return out;
}
