// Recompute universe_metrics rows from stored bars + full-history stats + derived fundamentals + FX + reference data.
import type { Database } from "bun:sqlite";
import { tzDate } from "./calendar";
import { priceDependent, STATIC_FUND_COLUMNS, type DerivedFundamentals } from "./derive";
import { majorOf, quoteCurrency, rateToUsd, toUsd } from "./fx";
import { extendExtremes } from "./longstats";
import { getMarket, MARKETS, type MarketDef } from "./markets";
import { METRIC_COLUMNS, METRICS_TABLE } from "./metricsSchema";
import { adjustedSeries, computeTechnicals, type SymbolBars } from "./technicals";
import { addDays } from "./util";

/** Sessions of history the technicals need (SMA200 + 52-week window + YTD base + RSI warm-up). */
export const METRIC_LOOKBACK_SESSIONS = 320;
/** Calendar days read per symbol for the technicals (≥ METRIC_LOOKBACK_SESSIONS sessions in every market). */
export const METRIC_LOOKBACK_DAYS = 500;
const CHUNK = 400;

// ---------- metrics version (bumped after every metrics run; invalidates coverage caches) ----------
let metricsVersion = 0;
export const bumpMetricsVersion = (): number => ++metricsVersion;
export const getMetricsVersion = (): number => metricsVersion;

/** Stored USD rates per major currency. */
export function loadFxRates(db: Database): Map<string, number> {
  return new Map(db.query<{ currency: string; rate: number }, []>("SELECT currency, rate FROM universe_fx").all().map((r) => [r.currency, r.rate]));
}

interface SymRow {
  symbol: string; code: string; name: string | null; kind: string; exchange: string | null; market: string;
  list_currency: string | null; indices: string | null;
  in_sp500: number; in_ndx: number; in_dji: number;
  earnings_date: string | null; earnings_timing: string | null; last_earnings_date: string | null;
  latest_news_at: number | null;
  bulk_mcap: number | null; bulk_beta: number | null; bulk_hi250: number | null; bulk_lo250: number | null; bulk_avgvol50: number | null;
  fundamentals_at: number | null; fund: string | null;
  l_status: string | null; l_fetched_at: number | null; first_date: string | null; last_date: string | null;
  ath: number | null; ath_date: string | null; atl: number | null; atl_date: string | null;
}

type BarTuple = [string, string, number, number, number, number, number, number];

function emptyBars(): SymbolBars {
  return { date: [], open: [], high: [], low: [], close: [], adjClose: [], volume: [] };
}

export interface RecomputeOptions {
  /** null = all active symbols of the enabled markets */
  symbols: string[] | null;
  /** Enabled markets; on a full recompute rows of other markets are removed. */
  markets: MarketDef[];
  nowMs: number;
  /** Major currency → USD. */
  fx: ReadonlyMap<string, number>;
  yieldFn?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** Adjusted close on/before `date` within ±10 days (for 3Y/5Y returns). */
export interface Anchor { date: string; adj: number }

export async function recomputeMetrics(db: Database, o: RecomputeOptions): Promise<number> {
  const codes = o.markets.map((m) => m.code);
  const utcToday = new Date(o.nowMs).toISOString().slice(0, 10);
  const cutoff = addDays(utcToday, -METRIC_LOOKBACK_DAYS);
  const todayOf = new Map(MARKETS.map((m) => [m.code, tzDate(o.nowMs, m.timezone)]));

  const mk = codes.map(() => "?").join(",") || "''";
  const baseSql = `SELECT s.symbol, s.code, s.name, s.kind, s.exchange, s.market, s.currency AS list_currency, s.indices,
      s.in_sp500, s.in_ndx, s.in_dji,
      s.earnings_date, s.earnings_timing, s.last_earnings_date, s.latest_news_at,
      s.bulk_mcap, s.bulk_beta, s.bulk_hi250, s.bulk_lo250, s.bulk_avgvol50,
      f.fundamentals_at, f.data AS fund,
      l.status AS l_status, l.fetched_at AS l_fetched_at, l.first_date, l.last_date, l.ath, l.ath_date, l.atl, l.atl_date
    FROM universe_symbols s LEFT JOIN universe_fund f ON f.symbol = s.symbol LEFT JOIN universe_long l ON l.symbol = s.symbol
    WHERE s.active = 1 AND s.market IN (${mk})`;
  let syms: SymRow[];
  if (o.symbols === null) {
    syms = db.query<SymRow, string[]>(`${baseSql} ORDER BY s.symbol`).all(...codes);
  } else {
    const q = db.query<SymRow, string[]>(`${baseSql} AND s.symbol = ?`);
    syms = [...new Set(o.symbols)].sort().map((s) => q.get(...codes, s)).filter((r): r is SymRow => !!r);
  }

  const rangeQ = db.query<BarTuple, [string, string, string]>(
    `SELECT symbol, date, open, high, low, close, adj_close, volume FROM universe_bars
     WHERE symbol >= ? AND symbol <= ? AND date >= ? ORDER BY symbol, date`,
  );
  const oneQ = db.query<BarTuple, [string, string]>(
    `SELECT symbol, date, open, high, low, close, adj_close, volume FROM universe_bars WHERE symbol = ? AND date >= ? ORDER BY date`,
  );
  const anchorQ = db.query<{ date: string; adj_close: number; close: number }, [string, string]>(
    "SELECT date, adj_close, close FROM universe_bars WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1",
  );
  const anchor = (symbol: string, target: string): Anchor | null => {
    const r = anchorQ.get(symbol, target);
    if (!r || r.date < addDays(target, -10)) return null;
    const adj = r.adj_close > 0 ? r.adj_close : r.close;
    return adj > 0 ? { date: r.date, adj } : null;
  };

  const rows: Record<string, number | string | null>[] = [];
  const now = Math.floor(o.nowMs / 1000);
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
    for (const s of chunk) {
      const b = bars.get(s.symbol) ?? emptyBars();
      const lastDate = b.date[b.date.length - 1];
      const anchors = lastDate
        ? { y3: anchor(s.symbol, addDays(lastDate, -1096)), y5: anchor(s.symbol, addDays(lastDate, -1826)) }
        : { y3: null, y5: null };
      rows.push(composeRow(s, b, { today: todayOf.get(s.market) ?? utcToday, readCutoff: cutoff, now, fx: o.fx, anchors }));
    }
    o.onProgress?.(Math.min(i + CHUNK, syms.length), syms.length);
    if (o.yieldFn) await o.yieldFn();
  }

  const cols = METRIC_COLUMNS.map((c) => c.col);
  const upsert = db.query(
    `INSERT OR REPLACE INTO ${METRICS_TABLE} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  );
  db.transaction(() => {
    if (o.symbols === null) {
      db.query(
        `DELETE FROM ${METRICS_TABLE} WHERE symbol NOT IN (SELECT symbol FROM universe_symbols WHERE active = 1 AND market IN (${mk}))`,
      ).run(...codes);
    }
    for (const r of rows) upsert.run(...(cols.map((c) => r[c] ?? null) as (string | number | null)[]));
  })();
  updateRanks(db);
  return rows.length;
}

/** Percentile ranks within (market, kind): perf_3m_rank_pct 0..100 and rs_rank 1..99. */
export function updateRanks(db: Database): void {
  db.transaction(() => {
    db.exec(`UPDATE ${METRICS_TABLE} SET perf_3m_rank_pct = NULL, rs_rank = NULL WHERE perf_3m_rank_pct IS NOT NULL OR rs_rank IS NOT NULL`);
    db.exec(`WITH r AS (SELECT symbol, PERCENT_RANK() OVER (PARTITION BY market, kind ORDER BY perf_3m) AS pr
               FROM ${METRICS_TABLE} WHERE perf_3m IS NOT NULL)
             UPDATE ${METRICS_TABLE} SET perf_3m_rank_pct = ROUND(r.pr * 100, 2) FROM r WHERE r.symbol = ${METRICS_TABLE}.symbol`);
    db.exec(`WITH r AS (SELECT symbol, PERCENT_RANK() OVER (PARTITION BY market, kind ORDER BY rs_score) AS pr
               FROM ${METRICS_TABLE} WHERE rs_score IS NOT NULL)
             UPDATE ${METRICS_TABLE} SET rs_rank = CAST(ROUND(r.pr * 98) AS INTEGER) + 1 FROM r WHERE r.symbol = ${METRICS_TABLE}.symbol`);
  })();
}

export interface ComposeContext {
  /** The market's local date (earnings "next" is on/after it). */
  today: string;
  /** First date read for the technicals (a symbol whose whole history is newer counts as a recent listing). */
  readCutoff: string;
  now: number;
  fx: ReadonlyMap<string, number>;
  anchors: { y3: Anchor | null; y5: Anchor | null };
}

const pct = (a: number | null, b: number | null): number | null =>
  a === null || b === null || !(b > 0) || !Number.isFinite(a) ? null : (a / b - 1) * 100;

export function composeRow(s: SymRow, bars: SymbolBars, c: ComposeContext): Record<string, number | string | null> {
  const row: Record<string, number | string | null> = {};
  let fund: DerivedFundamentals | null = null;
  if (s.fund) {
    try { fund = JSON.parse(s.fund) as DerivedFundamentals; } catch { fund = null; }
  }
  const market = getMarket(s.market) ?? MARKETS[0]!;
  row.symbol = s.symbol;
  row.code = s.code;
  row.name = s.name;
  row.kind = s.kind;
  row.market = market.code;
  row.exchange = s.exchange;
  row.in_sp500 = s.in_sp500 ? 1 : 0;
  row.in_ndx = s.in_ndx ? 1 : 0;
  row.in_dji = s.in_dji ? 1 : 0;
  row.indices = s.indices && s.indices !== "," ? s.indices : null;

  if (fund?.cols) for (const col of STATIC_FUND_COLUMNS) row[col] = fund.cols[col] ?? null;
  const currency = quoteCurrency(s.list_currency, typeof fund?.cols?.currency === "string" ? fund.cols.currency : null, market.currency);
  row.currency = currency;

  const hasHistory = s.first_date !== null && (s.l_status === "ok" || s.l_status === "stale" || s.l_status === "error");
  const listedWithinHistory = hasHistory && s.first_date! >= c.readCutoff;
  const tech = computeTechnicals(bars, {
    listedWithinHistory,
    bulk: { hi250: s.bulk_hi250, lo250: s.bulk_lo250, avgVol50: s.bulk_avgvol50 },
  });
  Object.assign(row, tech);

  const price = typeof tech.price === "number" ? tech.price : null;
  const unit = majorOf(currency).factor;
  if (fund?.inputs) Object.assign(row, priceDependent(fund.inputs, price, unit));
  if (row.market_cap == null && s.kind === "stock" && s.bulk_mcap && s.bulk_mcap > 0) row.market_cap = s.bulk_mcap;
  if (row.beta == null && s.bulk_beta !== null && s.kind === "stock" && s.bulk_beta !== 0) row.beta = s.bulk_beta;

  // ---- USD conversions
  const fx = rateToUsd(currency, c.fx);
  row.fx_to_usd = fx;
  row.price_usd = toUsd(price, fx);
  row.dollar_volume_usd = toUsd(typeof row.dollar_volume === "number" ? row.dollar_volume : null, fx);
  row.market_cap_usd = toUsd(typeof row.market_cap === "number" ? row.market_cap : null, rateToUsd(majorOf(currency).currency, c.fx));

  // ---- full history: all-time high/low (stats basis → latest raw basis), 3Y/5Y returns
  const n = bars.close.length;
  const lastAdj = n ? (bars.adjClose[n - 1]! > 0 ? bars.adjClose[n - 1]! : bars.close[n - 1]!) : null;
  if (hasHistory && s.ath !== null && s.atl !== null && s.last_date && price !== null) {
    const series = adjustedSeries(bars);
    const k = lastAdj && lastAdj > 0 ? bars.close[n - 1]! / lastAdj : 1;
    const ext = extendExtremes(
      { ath: s.ath, athDate: s.ath_date ?? "", atl: s.atl, atlDate: s.atl_date ?? "", lastDate: s.last_date },
      series.date, series.h, series.l, k,
    );
    if (ext) {
      row.ath = ext.ath;
      row.ath_date = ext.athDate || null;
      row.atl = ext.atl;
      row.atl_date = ext.atlDate || null;
      const ap = pct(price, ext.ath), lp = pct(price, ext.atl);
      row.ath_pct = ap === null ? null : Math.min(0, ap);
      row.atl_pct = lp === null ? null : Math.max(0, lp);
    }
  }
  if (!("ath" in row)) { row.ath = null; row.ath_date = null; row.ath_pct = null; row.atl = null; row.atl_date = null; row.atl_pct = null; }
  row.first_trade_date = hasHistory ? s.first_date : null;
  row.history_at = hasHistory ? s.l_fetched_at : null;
  const listedBefore = (a: Anchor | null) => a !== null && (!hasHistory || s.first_date! <= a.date);
  row.perf_3y = lastAdj !== null && listedBefore(c.anchors.y3) ? pct(lastAdj, c.anchors.y3!.adj) : null;
  row.perf_5y = lastAdj !== null && listedBefore(c.anchors.y5) ? pct(lastAdj, c.anchors.y5!.adj) : null;

  // Earnings: the calendar job is authoritative; fundamentals' Earnings.History fills gaps.
  const today = c.today;
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
  row.updated_at = c.now;
  // Ranks are filled by updateRanks() after the upsert.
  row.perf_3m_rank_pct = null;
  row.rs_rank = null;
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
