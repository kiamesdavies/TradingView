// Test helpers: an AgentBackend over a seeded in-memory universe DB and stubbed per-symbol data.
import { Database } from "bun:sqlite";
import type { MarketInfo, ScreenerQuery, UniverseStatus } from "@eodview/shared";
// Direct module imports: the screener index also wires the app database and the universe pipeline.
import { createScreenerEngine } from "../screener/query";
import { parseFinvizFilters, parseOrder } from "../screener/finviz";
import { METRIC_COLUMNS, METRICS_TABLE } from "../universe/metricsSchema";
import { createLocalSearch } from "./search";
import type { AgentBackend } from "./service";

type R = Record<string, string | number | null>;
const BASE: R = { kind: "stock", exchange: "NASDAQ", country: "USA", price_date: "2026-09-24" };

export const TEST_ROWS: R[] = [
  { symbol: "AAPL.US", code: "AAPL", name: "Apple Inc", sector: "Technology", market_cap: 3.5e12, price: 230, change_pct: 1.2, avg_volume: 5e7, volume: 4e7, sma50_pct: 4, sma200_pct: 12, perf_3m: 25, rsi14: 55 },
  { symbol: "MSFT.US", code: "MSFT", name: "Microsoft Corp", sector: "Technology", market_cap: 3.1e12, price: 420, change_pct: -0.5, avg_volume: 2e7, volume: 1.5e7, sma50_pct: -3, sma200_pct: 2, perf_3m: 5, rsi14: 28 },
  { symbol: "MID.US", code: "MID", name: "Mid Inc, \"The\"", sector: "Industrials", market_cap: 5e9, price: 55, change_pct: 2, avg_volume: 6e5, volume: 5e5, sma50_pct: 1, sma200_pct: 3, perf_3m: 40, rsi14: 62 },
  { symbol: "TINY.US", code: "TINY", name: "=Tiny Corp", sector: "Healthcare", market_cap: 4e7, price: 2.5, change_pct: 12, avg_volume: 3e5, volume: 2e6, sma50_pct: 35, perf_3m: 60, rsi14: 81 },
  { symbol: "SPY.US", code: "SPY", name: "SPDR S&P 500", kind: "etf", exchange: "NYSE ARCA", price: 560, change_pct: 0.4, avg_volume: 6e7, volume: 5e7, etf_category: "Large Blend" },
];

export function seedUniverse(db: Database, rows: R[] = TEST_ROWS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (${METRIC_COLUMNS.map((c) => `"${c.col}" ${c.type}${c.col === "symbol" ? " PRIMARY KEY" : ""}`).join(", ")})`);
  for (const r of rows) {
    const row = { ...BASE, ...r };
    const cols = Object.keys(row);
    db.query(`INSERT INTO ${METRICS_TABLE} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...(cols.map((c) => row[c]) as (string | number | null)[]));
  }
}

export const TEST_STATUS: UniverseStatus = {
  symbols: 5, withPrices: 5, withFundamentals: 4, lastPriceDate: "2026-09-24", historyDays: 300,
  creditsUsedToday: 12, dailyCreditBudget: 40000, jobs: [],
};

export const TEST_MARKETS: MarketInfo[] = [{
  code: "US", name: "US exchanges", country: "USA", currency: "USD", timezone: "America/New_York", enabled: true,
  symbols: 5, withPrices: 5, withFundamentals: 4, lastPriceDate: "2026-09-24",
}];

/** `screenerParsers`: use the screener module's Finviz parsers (as production does) instead of the agent API's fallback. */
export function createTestBackend(db = new Database(":memory:"), screenerParsers = true): { db: Database; backend: AgentBackend; calls: string[] } {
  seedUniverse(db);
  const engine = createScreenerEngine(db, { now: () => new Date("2026-09-24T14:00:00Z"), markets: () => TEST_MARKETS });
  const calls: string[] = [];
  const search = createLocalSearch(db);
  const backend: AgentBackend = {
    meta: (market) => engine.meta(TEST_STATUS, market),
    runScreen: (q: ScreenerQuery) => engine.query(q),
    markets: () => TEST_MARKETS,
    ...(screenerParsers ? { parseFilters: (f: string) => parseFinvizFilters(f), parseOrder: (o: string | null) => parseOrder(o) } : {}),
    status: () => TEST_STATUS,
    overview: async (symbol) => {
      calls.push(`overview ${symbol}`);
      return {
        profile: { symbol, name: "Apple Inc", exchange: "NASDAQ", type: "Common Stock", isEtf: false },
        quote: { symbol, price: 230, change: 2, changePct: 0.9, volume: 1, prevClose: 228, time: 1_790_000_000 },
        extended: null, stats: [], nextEarnings: null, earnings: [], revenue: [], analyst: null, latestNews: null, fundamentalsAsOf: null,
      };
    },
    bars: async (symbol, tf, limit, to) => {
      calls.push(`bars ${symbol} ${tf} ${limit} ${to ?? ""}`);
      const day = 86400;
      const start = Date.UTC(2026, 8, 21) / 1000;
      const bars = [0, 1, 2].map((i) => ({ time: start + i * day, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 * (i + 1) }));
      return { symbol, tf, bars: bars.slice(-limit), hasMore: false };
    },
    news: async (symbol, limit) => { calls.push(`news ${symbol} ${limit}`); return []; },
    events: async (symbol) => { calls.push(`events ${symbol}`); return []; },
    searchLocal: search,
    searchRemote: async (q) => {
      calls.push(`remote ${q}`);
      return [{ symbol: "EURUSD.FOREX", code: "EURUSD", exchange: "FOREX", name: "Euro/USD", type: "Currency", assetClass: "forex", streamable: true }];
    },
  };
  return { db, backend, calls };
}
