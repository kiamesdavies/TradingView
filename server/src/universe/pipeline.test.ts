// End-to-end pipeline test against an in-memory SQLite db and a fake EODHD (no network): two markets (US + ST),
// per-ticker full-history backfill, FX, split repair via the US bulk split list and via the ST price-jump check.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import aapl from "./fixtures/aapl.fundamentals.json";
import spy from "./fixtures/spy.fundamentals.json";
import { recentSessions } from "./calendar";
import { CreditGuard } from "./credits";
import { UniversePipeline } from "./pipeline";
import { initUniverseSchema } from "./schema";
import { getSparklinesFrom } from "./metrics";
import { addDays } from "./util";

const N_STOCKS = 2100;
const N_ETFS = 200;
const N_ST = 400;

/** Weekdays from `from` to `to`, ascending (ST calendar: no holidays in the fake). */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) out.push(d);
  }
  return out;
}

/**
 * Fake market. US: SPLT does a 2:1 split on `splitDate` (reported in the bulk split list); AAPL peaked in 2020,
 * before the retention window. ST: SIVE does a 1:10 reverse split on `stSplitDate` (no split feed: detected
 * from the price jump). The S, E and X symbols only have the last 40 sessions of history.
 */
function fakeMarket(splitDate: string, stSplitDate = "2099-01-01") {
  const state = { asOf: "2026-09-25", calls: [] as string[] };
  type C = { code: string; type: string; ex: string; market: "US" | "ST"; long: boolean };
  const codes: C[] = [
    { code: "AAPL", type: "Common Stock", ex: "NASDAQ", market: "US", long: true },
    { code: "SPLT", type: "Common Stock", ex: "NYSE", market: "US", long: true },
    { code: "SPY", type: "ETF", ex: "NYSE ARCA", market: "US", long: true },
    { code: "SIVE", type: "Common Stock", ex: "ST", market: "ST", long: true },
  ];
  for (let i = 0; i < N_STOCKS; i++) codes.push({ code: `S${i}`, type: "Common Stock", ex: i % 2 ? "NYSE" : "NASDAQ", market: "US", long: false });
  for (let i = 0; i < N_ETFS; i++) codes.push({ code: `E${i}`, type: "ETF", ex: "BATS", market: "US", long: false });
  for (let i = 0; i < N_ST; i++) codes.push({ code: `X${i}`, type: "Common Stock", ex: "ST", market: "ST", long: false });
  const usDates = recentSessions("2026-12-31", 1900).reverse();
  const stDates = weekdays(usDates[0]!, "2026-12-31");
  const datesOf = (m: "US" | "ST") => (m === "US" ? usDates : stDates);
  const idx = { US: new Map(usDates.map((d, i) => [d, i])), ST: new Map(stDates.map((d, i) => [d, i])) };

  /** post-split ("true") price */
  const truePrice = (c: C, date: string) => {
    const i = idx[c.market].get(date)!;
    if (c.code === "AAPL") return i <= 300 ? 100 + i : 400 - (i - 300) * 0.1;
    if (c.code === "SPY") return 300 + i * 0.3;
    if (c.code === "SPLT") return 50 + i * 0.01;
    if (c.code === "SIVE") return 300 + 20 * Math.sin(i / 30);
    const k = c.code.charCodeAt(1) + c.code.length;
    return 20 + (k % 50) + 5 * Math.sin(i / 7 + k);
  };
  const row = (c: C, date: string, extended: boolean) => {
    const p = truePrice(c, date);
    let raw = p, restatedFactor = 1;
    if (c.code === "SPLT" && date < splitDate) { raw = p * 2; restatedFactor = state.asOf >= splitDate ? 1 : 2; }
    if (c.code === "SIVE" && date < stSplitDate) { raw = p / 10; restatedFactor = state.asOf >= stSplitDate ? 1 : 0.1; }
    const r: Record<string, unknown> = {
      code: c.code, exchange_short_name: c.market, date,
      open: raw * 0.995, high: raw * 1.01, low: raw * 0.99, close: raw, adjusted_close: p * restatedFactor,
      volume: c.code === "SPLT" ? 1000 * (date < splitDate ? 1 : 2) : 100000,
    };
    if (extended) Object.assign(r, { MarketCapitalization: c.type === "ETF" ? 0 : 1e9, Beta: 1.2, hi_250d: raw * 1.3, lo_250d: raw * 0.7, avgvol_50d: 90000 });
    return r;
  };
  const byCode = new Map(codes.map((c) => [`${c.code}.${c.market}`, c]));

  const api = {
    async raw(path: string, params: Record<string, string | number | undefined> = {}) {
      state.calls.push(`${path}${params.type ? `?type=${params.type}` : ""}${params.date ? `@${params.date}` : ""}`);
      const m = /^\/(exchange-symbol-list|eod-bulk-last-day|exchange-details)\/(US|ST)$/.exec(path);
      if (m && m[1] === "exchange-symbol-list") {
        return codes.filter((c) => c.market === m[2]).map((c) => ({ Code: c.code, Name: `${c.code} Inc`, Exchange: c.ex, Type: c.type, Isin: null, Currency: c.market === "US" ? "USD" : "SEK" }));
      }
      if (m && m[1] === "exchange-details") return { Timezone: m[2] === "US" ? "America/New_York" : "Europe/Stockholm", ExchangeHolidays: {} };
      if (m && m[1] === "eod-bulk-last-day") {
        const mk = m[2] as "US" | "ST";
        const date = (params.date as string | undefined) ?? state.asOf;
        if (params.type === "splits") return mk === "US" && date === splitDate ? [{ code: "SPLT", exchange: "US", date, split: "2.000000/1.000000" }] : [];
        if (params.type === "dividends") return [];
        const dates = datesOf(mk);
        const last = dates.filter((d) => d <= state.asOf).pop()!;
        return codes.filter((c) => c.market === mk).map((c) => row(c, last, params.filter === "extended"));
      }
      if (path.startsWith("/eod/")) {
        const sym = decodeURIComponent(path.slice(5));
        const c = byCode.get(sym);
        if (!c) throw Object.assign(new Error("not found"), { status: 404, upstreamStatus: 404 });
        let ds = datesOf(c.market).filter((d) => d >= String(params.from) && d <= state.asOf);
        if (!c.long) ds = ds.slice(-40);
        return ds.map((d) => row(c, d, false));
      }
      if (path.startsWith("/real-time/")) return [{ code: "SEKUSD.FOREX", close: 0.1, previousClose: 0.1 }];
      if (path === "/calendar/earnings") {
        return {
          earnings: [
            { code: "AAPL.US", report_date: "2026-10-29", before_after_market: "AfterMarket", actual: null },
            { code: "SIVE.ST", report_date: "2026-10-22", before_after_market: "BeforeMarket", actual: null },
            { code: "SAP.XETRA", report_date: "2026-10-22", before_after_market: "BeforeMarket", actual: null },
          ],
        };
      }
      if (path === "/fundamentals/GSPC.INDX") return Object.fromEntries(Array.from({ length: 450 }, (_, i) => [String(i), { Code: i ? `S${i}` : "AAPL", Exchange: "US" }]));
      if (path === "/fundamentals/OMXS30.INDX") return Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i), { Code: i ? `X${i}` : "SIVE", Exchange: "ST" }]));
      if (path.startsWith("/fundamentals/")) return {}; // other indices: too few → kept
      if (path === "/news") return params.offset ? [] : [{ date: "2026-09-25T20:00:00+00:00", symbols: ["AAPL.US", "SIVE.ST", "ZZZ.HM"] }];
      throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    },
  };
  return { state, api };
}

function makePipeline(
  db: Database, market: ReturnType<typeof fakeMarket>, clock: { now: number },
  opts: { budget?: number; usage?: number; markets?: string[]; fundCap?: number; backfillCap?: number | null; years?: number } = {},
) {
  let fundCalls = 0;
  const p = new UniversePipeline({
    db,
    api: market.api,
    getUsage: async () => ({ apiRequests: opts.usage ?? 0, dailyRateLimit: 100000 }),
    refreshFundamentals: async (sym) => {
      fundCalls++;
      if (sym === "AAPL.US") return aapl as any;
      if (sym === "SPY.US") return spy as any;
      if (sym === "S1.US") throw Object.assign(new Error("EODHD has no data"), { status: 404, upstreamStatus: 404 });
      if (sym.endsWith(".ST")) return { General: { Sector: "Technology", Type: "Common Stock", CurrencyCode: "SEK" }, SharesStats: { SharesOutstanding: 1e8 } };
      return { General: { Sector: "Industrials", Type: "Common Stock" }, SharesStats: { SharesOutstanding: 1e7 } };
    },
    getKey: () => "test-key",
    markets: () => opts.markets ?? ["US", "ST"],
    now: () => clock.now,
    historyYears: opts.years ?? 5,
    backfillMaxSymbols: opts.backfillCap ?? null,
    fundamentalsMaxPerRun: opts.fundCap ?? 100000,
    ratePerMin: 1e9,
    retry: { retries: 0 },
    dailyBudget: opts.budget ?? 40000,
    log: () => {},
  });
  return { p, fundCalls: () => fundCalls };
}

const metricsRow = (db: Database, sym: string) => db.query<Record<string, any>, [string]>("SELECT * FROM universe_metrics WHERE symbol = ?").get(sym)!;

describe("universe pipeline (fake EODHD, US + ST)", () => {
  const db = new Database(":memory:");
  const market = fakeMarket("2026-09-28", "2026-09-28");
  const clock = { now: Date.UTC(2026, 8, 25, 23, 0) }; // Fri 19:00 NY, Sat 01:00 Stockholm
  const { p } = makePipeline(db, market, clock);

  test("first run: per-market symbols/prices, fx, … then per-ticker backfill and fundamentals", async () => {
    const ran = await p.runPending(400);
    expect(ran.slice(0, 10)).toEqual([
      "symbols:US", "symbols:ST", "prices:US", "prices:ST", "fx", "earnings", "indices:US", "indices:ST", "news", "metrics",
    ]);
    expect(ran).toContain("backfill:US");
    expect(ran).toContain("backfill:ST");
    expect(ran).toContain("fundamentals");
    const st = p.status();
    expect(st.symbols).toBe(N_STOCKS + N_ETFS + 3 + N_ST + 1);
    expect(st.lastPriceDate).toBe("2026-09-25");
    expect(st.withPrices).toBe(st.symbols);
    expect(st.withFundamentals).toBe(st.symbols - 1); // S1 404
    expect(st.jobs.find((j) => j.name === "backfill:US")!.lastError).toBeNull();
    const us = st.markets.find((m) => m.code === "US")!;
    expect(us.histories).toBe(N_STOCKS + N_ETFS + 3);
    expect(us.historyDays).toBeGreaterThan(1200); // AAPL's 5 years of sessions
    expect(us.creditsToday).toBeGreaterThan(N_STOCKS); // one /eod call per symbol + bulk
    // one /eod call per symbol, full history (from=1900-01-01)
    expect(market.state.calls.filter((c) => c.startsWith("/eod/")).length).toBe(st.symbols);
    expect(market.state.calls.filter((c) => c.startsWith("/eod-bulk-last-day/US")).length).toBe(1); // no per-date bulk backfill
    expect(await p.runPending(5)).toEqual([]);
  });

  test("history kept only for the retention window; ATH from the full history", () => {
    const first = db.query<{ d: string }, []>("SELECT MIN(date) AS d FROM universe_bars WHERE symbol = 'AAPL.US'").get()!.d;
    expect(first >= addDays("2026-09-25", -Math.round(5 * 365.25) - 10)).toBe(true);
    const long = db.query<Record<string, any>, []>("SELECT * FROM universe_long WHERE symbol = 'AAPL.US'").get()!;
    expect(long.status).toBe("ok");
    expect(long.first_date < first).toBe(true); // stats saw rows that were not stored
    const r = metricsRow(db, "AAPL.US");
    expect(r.ath_date < first).toBe(true);
    expect(r.ath).toBeCloseTo(400 * 1.01, 6);
    expect(r.ath_pct).toBeLessThan(-30);
    expect(r.atl_pct).toBeGreaterThan(0);
    expect(r.first_trade_date).toBe(long.first_date);
    expect(r.perf_3y).toBeLessThan(0);
    expect(r.perf_5y).not.toBeNull();
    expect(r.history_at).toBeGreaterThan(0);
    // short histories: no 3Y return, still an ATH
    const s5 = metricsRow(db, "S5.US");
    expect(s5.perf_3y).toBeNull();
    expect(s5.ath_pct).toBeLessThanOrEqual(0);
  });

  test("metrics rows: market, FX, ranks, indices, earnings", () => {
    const a = metricsRow(db, "AAPL.US");
    expect(a.market).toBe("US");
    expect(a.currency).toBe("USD");
    expect(a.fx_to_usd).toBe(1);
    expect(a.price_usd).toBe(a.price);
    expect(a.market_cap_usd).toBeCloseTo(a.market_cap, 3);
    expect(a.market_cap).toBeCloseTo(a.price * 14594180000, -3);
    expect(a.pe).toBeCloseTo(a.price / 8.7, 6);
    expect(a.indices).toBe(",SP500,");
    expect(a.in_sp500).toBe(1);
    expect(a.earnings_date).toBe("2026-10-29");
    expect(a.rs_rank).toBeGreaterThanOrEqual(1);
    expect(a.perf_3m_rank_pct).not.toBeNull();
    const s = metricsRow(db, "SIVE.ST");
    expect(s.market).toBe("ST");
    expect(s.exchange).toBe("ST");
    expect(s.currency).toBe("SEK");
    expect(s.fx_to_usd).toBeCloseTo(0.1, 9);
    expect(s.price_usd).toBeCloseTo(s.price * 0.1, 9);
    expect(s.dollar_volume_usd).toBeCloseTo(s.dollar_volume * 0.1, 3);
    expect(s.market_cap_usd).toBeCloseTo(s.price * 1e8 * 0.1, 0);
    expect(s.indices).toBe(",OMXS30,");
    expect(s.earnings_date).toBe("2026-10-22");
    expect(s.earnings_timing).toBe("bmo");
    expect(s.latest_news_at).toBe(Date.parse("2026-09-25T20:00:00Z") / 1000);
    expect(s.ath).toBeGreaterThan(s.price);
    // ranks are per market
    const ranks = db.query<{ market: string; n: number; lo: number; hi: number }, []>(
      "SELECT market, COUNT(*) AS n, MIN(perf_3m_rank_pct) AS lo, MAX(perf_3m_rank_pct) AS hi FROM universe_metrics WHERE kind = 'stock' AND perf_3m_rank_pct IS NOT NULL GROUP BY market",
    ).all();
    expect(ranks.length).toBe(2);
    for (const r of ranks) { expect(r.lo).toBe(0); expect(r.hi).toBe(r.n > 1 ? 100 : 0); }
    const spyRow = metricsRow(db, "SPY.US");
    expect(spyRow.kind).toBe("etf");
    expect(spyRow.market_cap).toBeNull();
  });

  test("splits after the history was stored are repaired (US bulk list, ST price-jump check)", async () => {
    market.state.asOf = "2026-09-28";
    clock.now = Date.UTC(2026, 8, 28, 23, 0); // Mon 19:00 NY
    market.state.calls.length = 0;
    const ran = await p.runPending(50);
    expect(ran).toContain("prices:US");
    expect(ran).toContain("prices:ST");
    expect(market.state.calls).toContain("/eod-bulk-last-day/US?type=splits@2026-09-28");
    expect(market.state.calls).not.toContain("/eod-bulk-last-day/ST?type=splits@2026-09-28");
    expect(market.state.calls).toContain("/eod/SPLT.US");
    expect(market.state.calls).toContain("/eod/SIVE.ST");
    for (const sym of ["SPLT.US", "SIVE.ST"]) {
      const r = metricsRow(db, sym);
      expect(r.price_date).toBe("2026-09-28");
      expect(Math.abs(r.change_pct)).toBeLessThan(2); // not -50% / +900%
      expect(r.ath_pct).toBeLessThanOrEqual(0);
    }
    const pre = db.query<{ close: number; adj_close: number }, []>("SELECT close, adj_close FROM universe_bars WHERE symbol = 'SPLT.US' AND date = '2026-09-25'").get()!;
    expect(pre.adj_close / pre.close).toBeCloseTo(0.5, 9); // stored history restated after the re-fetch
    const spark = getSparklinesFrom(db, ["SPLT.US", "NOPE.US"], 10);
    expect(spark["SPLT.US"]!.length).toBe(10);
    expect(Math.max(...spark["SPLT.US"]!) / Math.min(...spark["SPLT.US"]!)).toBeLessThan(1.1);
    expect(spark["NOPE.US"]).toEqual([]);
  });

  test("after a gap (weekend check), prices is due to catch up", () => {
    clock.now = Date.UTC(2026, 9, 3, 16, 0); // Sat Oct 3
    market.state.asOf = "2026-10-02";
    expect(p.nextRun("prices:US")).toBeLessThanOrEqual(clock.now);
    expect(p.nextRun("prices:ST")).toBeLessThanOrEqual(clock.now);
  });

  test("markets list, manual job names", () => {
    const list = p.listMarkets();
    expect(list.find((m) => m.code === "ST")).toMatchObject({ enabled: true, symbols: N_ST + 1, currency: "SEK", timezone: "Europe/Stockholm" });
    expect(list.find((m) => m.code === "LSE")).toMatchObject({ enabled: false, symbols: 0 });
    expect(() => p.runJob("nope")).toThrow();
    expect(() => p.runJob("prices:LSE")).toThrow(); // not enabled
  });
});

describe("backfill cap and fundamentals run cap", () => {
  test("EODVIEW_BACKFILL_MAX_SYMBOLS limits histories per market, most liquid first", async () => {
    const db = new Database(":memory:");
    const market = fakeMarket("2099-01-01");
    const clock = { now: Date.UTC(2026, 8, 25, 23, 0) };
    const { p } = makePipeline(db, market, clock, { backfillCap: 25, fundCap: 100 });
    await p.runPending(200);
    const n = db.query<{ market: string; n: number }, []>("SELECT market, COUNT(*) AS n FROM universe_long GROUP BY market ORDER BY market").all();
    expect(n).toEqual([{ market: "ST", n: 25 }, { market: "US", n: 25 }]);
    const got = new Set(db.query<{ symbol: string }, []>("SELECT symbol FROM universe_long").all().map((r) => r.symbol));
    expect(got.has("SPY.US") && got.has("AAPL.US") && got.has("SIVE.ST")).toBe(true); // highest dollar volume first
    expect(p.status().jobs.find((j) => j.name === "backfill:US")!.progress).toContain("symbol cap 25 reached");
    // fundamentals: 100 per run, then a one-hour pause
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM universe_fund").get()!.n).toBe(100);
    const f = p.status().jobs.find((j) => j.name === "fundamentals")!;
    expect(f.progress).toContain("run cap of 100 reached");
    expect(f.nextRunAt).toBe(Math.floor(clock.now / 1000) + 3600);
  });
});

describe("budget", () => {
  test("pauses instead of failing, resumes at midnight UTC", async () => {
    const db = new Database(":memory:");
    const market = fakeMarket("2099-01-01");
    const clock = { now: Date.UTC(2026, 8, 25, 23, 0) };
    const { p } = makePipeline(db, market, clock, { budget: 150, markets: ["US"] });
    await p.runPending(10);
    const st = p.status();
    const prices = st.jobs.find((j) => j.name === "prices:US")!;
    expect(prices.lastError).toBeNull();
    expect(st.lastPriceDate).toBe("2026-09-25");
    const paused = st.jobs.filter((j) => j.progress?.includes("budget exhausted, resumes 2026-09-26 00:00 UTC"));
    expect(paused.length).toBeGreaterThan(0);
    expect(paused[0]!.nextRunAt).toBe(Date.UTC(2026, 8, 26) / 1000);
    expect(st.creditsUsedToday).toBeLessThanOrEqual(150);
  });

  test("account usage near the plan limit stops work", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    const g = new CreditGuard(db, { budget: 40000, reserve: 15000, getUsage: async () => ({ apiRequests: 84950, dailyRateLimit: 100000 }), now: () => 0 });
    await g.ensure(10);
    await expect(g.ensure(100)).rejects.toThrow("near the daily limit");
    g.record("prices:ST", 40);
    expect(g.usedToday()).toBe(40);
    expect(g.byMarketToday()).toEqual({ ST: 40 });
    await expect(g.ensure(20)).rejects.toThrow(); // 84950 + 40 + 20 > 85000
  });
});

describe("scheduling with a real (advancing) clock", () => {
  test("data-driven 'due now' jobs are picked even though the clock moves between reads", async () => {
    const db = new Database(":memory:");
    const market = fakeMarket("2099-01-01");
    const clock = { now: Date.UTC(2026, 8, 25, 23, 0) };
    const { p } = makePipeline(db, market, clock, { markets: ["US"] });
    // Every clock read advances 1 ms, like Date.now() does in production.
    (p as any).now = () => ++clock.now;
    const ran = await p.runPending(3);
    expect(ran).toEqual(["symbols:US", "prices:US", "fx"]);
  });
});

describe("v2 → v3 migration", () => {
  test("US-only state moves to the per-market tables", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE universe_symbols (symbol TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT, exchange TEXT, kind TEXT NOT NULL, isin TEXT,
      active INTEGER NOT NULL DEFAULT 1, first_seen INTEGER, updated_at INTEGER, in_sp500 INTEGER NOT NULL DEFAULT 0, in_ndx INTEGER NOT NULL DEFAULT 0,
      in_dji INTEGER NOT NULL DEFAULT 0, earnings_date TEXT, earnings_timing TEXT, last_earnings_date TEXT, latest_news_at INTEGER, bulk_date TEXT,
      bulk_mcap REAL, bulk_beta REAL, bulk_hi250 REAL, bulk_lo250 REAL, bulk_avgvol50 REAL)`);
    db.exec(`INSERT INTO universe_symbols (symbol, code, kind, in_sp500, in_ndx) VALUES ('AAPL.US', 'AAPL', 'stock', 1, 1)`);
    db.exec(`CREATE TABLE universe_dates (date TEXT PRIMARY KEY, rows INTEGER NOT NULL, fetched_at INTEGER NOT NULL)`);
    db.exec(`INSERT INTO universe_dates VALUES ('2026-09-24', 11000, 1)`);
    db.exec(`CREATE TABLE universe_holidays (date TEXT PRIMARY KEY)`);
    db.exec(`INSERT INTO universe_holidays VALUES ('2026-01-09')`);
    db.exec(`CREATE TABLE universe_kv (key TEXT PRIMARY KEY, value TEXT)`);
    db.exec(`INSERT INTO universe_kv VALUES ('actions_through', '2026-09-24')`);
    db.exec(`CREATE TABLE universe_jobs (name TEXT PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, last_error TEXT, progress TEXT, next_run_at INTEGER, next_mode TEXT)`);
    db.exec(`INSERT INTO universe_jobs (name, last_success_at) VALUES ('symbols', 123), ('news', 5)`);
    initUniverseSchema(db);
    initUniverseSchema(db); // idempotent
    expect(db.query("SELECT market, indices FROM universe_symbols").get()).toEqual({ market: "US", indices: ",SP500,NDX," });
    expect(db.query("SELECT * FROM universe_sessions").all()).toEqual([{ market: "US", date: "2026-09-24", rows: 11000, fetched_at: 1 }]);
    expect(db.query("SELECT market, date FROM universe_market_holidays").all()).toEqual([{ market: "US", date: "2026-01-09" }]);
    expect(db.query("SELECT value FROM universe_kv WHERE key = 'actions_through:US'").get()).toEqual({ value: "2026-09-24" });
    expect(db.query("SELECT name, last_success_at FROM universe_jobs ORDER BY name").all()).toEqual([
      { name: "news", last_success_at: 5 }, { name: "symbols:US", last_success_at: 123 },
    ]);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'universe_dates'").get()).toBeNull();
  });
});
