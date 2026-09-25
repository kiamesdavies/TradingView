// End-to-end pipeline test against an in-memory SQLite db and a fake EODHD (no network).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import aapl from "./fixtures/aapl.fundamentals.json";
import spy from "./fixtures/spy.fundamentals.json";
import { recentSessions } from "./calendar";
import { CreditGuard } from "./credits";
import { UniversePipeline } from "./pipeline";
import { initUniverseSchema } from "./schema";
import { getSparklinesFrom } from "./metrics";

const N_STOCKS = 2100;
const N_ETFS = 200;

/** Fake market: deterministic prices; SPLT does a 2:1 split on `splitDate` (raw halves, history restated). */
function fakeMarket(splitDate: string) {
  const state = { asOf: "2026-09-25", calls: [] as string[], userRequests: 0 };
  const codes: Array<{ code: string; type: string; ex: string }> = [
    { code: "AAPL", type: "Common Stock", ex: "NASDAQ" },
    { code: "SPLT", type: "Common Stock", ex: "NYSE" },
    { code: "SPY", type: "ETF", ex: "NYSE ARCA" },
  ];
  for (let i = 0; i < N_STOCKS; i++) codes.push({ code: `S${i}`, type: "Common Stock", ex: i % 2 ? "NYSE" : "NASDAQ" });
  for (let i = 0; i < N_ETFS; i++) codes.push({ code: `E${i}`, type: "ETF", ex: "BATS" });
  const allDates = recentSessions("2026-12-31", 400).reverse();
  const dayIndex = new Map(allDates.map((d, i) => [d, i]));

  /** post-split ("true") price */
  const truePrice = (code: string, date: string) => {
    const i = dayIndex.get(date)!;
    if (code === "AAPL") return 300 + i * 0.2;
    if (code === "SPY") return 700 + i * 0.3;
    if (code === "SPLT") return 50 + i * 0.05;
    const k = code.charCodeAt(1) + code.length;
    return 20 + (k % 50) + 5 * Math.sin(i / 7 + k);
  };
  const row = (code: string, date: string, extended: boolean) => {
    const p = truePrice(code, date);
    const splitFactor = code === "SPLT" && date < splitDate ? 2 : 1;
    // adjusted_close is restated as of the market's current date
    const restated = code === "SPLT" && state.asOf >= splitDate ? 1 : splitFactor;
    const raw = p * splitFactor;
    const r: Record<string, unknown> = {
      code, exchange_short_name: "US", date,
      open: raw * 0.995, high: raw * 1.01, low: raw * 0.99, close: raw, adjusted_close: p * restated,
      volume: code === "SPLT" ? 1000 * (date < splitDate ? 1 : 2) : 100000,
    };
    if (extended) Object.assign(r, { MarketCapitalization: code === "SPY" ? 0 : 1e9, Beta: 1.2, hi_250d: raw * 1.3, lo_250d: raw * 0.7, avgvol_50d: 90000 });
    return r;
  };

  const api = {
    async raw(path: string, params: Record<string, string | number | undefined> = {}) {
      state.calls.push(`${path}${params.type ? `?type=${params.type}` : ""}${params.date ? `@${params.date}` : ""}`);
      if (path === "/exchange-symbol-list/US") return codes.map((c) => ({ Code: c.code, Name: `${c.code} Inc`, Exchange: c.ex, Type: c.type, Isin: null }));
      if (path === "/eod-bulk-last-day/US") {
        const date = (params.date as string | undefined) ?? state.asOf;
        if (params.type === "splits") return date === splitDate ? [{ code: "SPLT", exchange: "US", date, split: "2.000000/1.000000" }] : [];
        if (params.type === "dividends") return [];
        if (!dayIndex.has(date) || date > state.asOf) return [];
        return codes.map((c) => row(c.code, date, params.filter === "extended"));
      }
      if (path.startsWith("/eod/")) {
        const code = decodeURIComponent(path.slice(5)).replace(/\.US$/, "");
        return allDates.filter((d) => d >= String(params.from) && d <= state.asOf).map((d) => row(code, d, false));
      }
      if (path === "/calendar/earnings") {
        return { earnings: [{ code: "AAPL.US", report_date: "2026-10-29", before_after_market: "AfterMarket", actual: null }] };
      }
      if (path === "/fundamentals/GSPC.INDX") return Object.fromEntries(Array.from({ length: 450 }, (_, i) => [String(i), { Code: i ? `S${i}` : "AAPL", Exchange: "US" }]));
      if (path.startsWith("/fundamentals/")) return {}; // NDX/DJI: too few → kept
      if (path === "/news") return params.offset ? [] : [{ date: "2026-09-25T20:00:00+00:00", symbols: ["AAPL.US", "ZZZ.HM"] }];
      throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    },
  };
  return { state, api };
}

function makePipeline(db: Database, market: ReturnType<typeof fakeMarket>, clock: { now: number }, opts: { budget?: number; usage?: number } = {}) {
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
      return { General: { Sector: "Industrials", Type: "Common Stock" }, SharesStats: { SharesOutstanding: 1e7 } };
    },
    getKey: () => "test-key",
    now: () => clock.now,
    historyDays: 30,
    dailyBudget: opts.budget ?? 40000,
    log: () => {},
  });
  return { p, fundCalls: () => fundCalls };
}

describe("universe pipeline (fake EODHD)", () => {
  const db = new Database(":memory:");
  const market = fakeMarket("2026-09-28");
  const clock = { now: Date.UTC(2026, 8, 25, 23, 0) }; // Fri 19:00 NY
  const { p } = makePipeline(db, market, clock);

  test("first run: symbols → prices → earnings → indices → news → metrics → backfill → fundamentals", async () => {
    const ran = await p.runPending(400);
    expect(ran.slice(0, 6)).toEqual(["symbols", "prices", "earnings", "indices", "news", "metrics"]);
    expect(ran).toContain("backfill");
    expect(ran).toContain("fundamentals");
    const st = p.status();
    expect(st.symbols).toBe(N_STOCKS + N_ETFS + 3);
    expect(st.lastPriceDate).toBe("2026-09-25");
    expect(st.historyDays).toBe(30);
    expect(st.withPrices).toBe(st.symbols);
    expect(st.withFundamentals).toBe(st.symbols - 1); // S1 404
    expect(st.creditsUsedToday).toBeGreaterThan(30 * 100);
    expect(st.jobs.find((j) => j.name === "backfill")!.lastError).toBeNull();
    // nothing left to do right now
    expect(await p.runPending(5)).toEqual([]);
  });

  test("metrics rows look sane", () => {
    const aaplRow = db.query<Record<string, any>, []>("SELECT * FROM universe_metrics WHERE symbol = 'AAPL.US'").get()!;
    expect(aaplRow.kind).toBe("stock");
    expect(aaplRow.exchange).toBe("NASDAQ");
    expect(aaplRow.price_date).toBe("2026-09-25");
    expect(aaplRow.sector).toBe("Technology");
    expect(aaplRow.market_cap).toBeCloseTo(aaplRow.price * 14594180000, -3);
    expect(aaplRow.pe).toBeCloseTo(aaplRow.price / 8.7, 6);
    expect(aaplRow.sma20).toBeGreaterThan(0);
    expect(aaplRow.sma50).toBeNull(); // only 30 sessions stored
    expect(aaplRow.rsi14).toBe(100);
    expect(aaplRow.perf_1w).toBeGreaterThan(0);
    expect(aaplRow.in_sp500).toBe(1);
    expect(aaplRow.earnings_date).toBe("2026-10-29");
    expect(aaplRow.earnings_timing).toBe("amc");
    expect(aaplRow.latest_news_at).toBe(Date.parse("2026-09-25T20:00:00Z") / 1000);
    expect(aaplRow.high_52w_pct).toBeLessThan(0); // bulk 250d fallback
    expect(aaplRow.fundamentals_at).toBeGreaterThan(0);
    const spyRow = db.query<Record<string, any>, []>("SELECT * FROM universe_metrics WHERE symbol = 'SPY.US'").get()!;
    expect(spyRow.kind).toBe("etf");
    expect(spyRow.etf_expense_ratio).toBeCloseTo(0.095, 6);
    expect(spyRow.market_cap).toBeNull();
    const s5 = db.query<Record<string, any>, []>("SELECT * FROM universe_metrics WHERE symbol = 'S5.US'").get()!;
    expect(s5.market_cap).toBeCloseTo(s5.price * 1e7, 3);
    expect(s5.in_sp500).toBe(1);
  });

  test("a split after the history was stored is repaired", async () => {
    market.state.asOf = "2026-09-28";
    clock.now = Date.UTC(2026, 8, 28, 23, 0); // Mon 19:00 NY
    market.state.calls.length = 0;
    const ran = await p.runPending(50);
    expect(ran).toContain("prices");
    expect(market.state.calls).toContain("/eod-bulk-last-day/US?type=splits@2026-09-28");
    expect(market.state.calls).toContain("/eod/SPLT.US");
    const r = db.query<Record<string, any>, []>("SELECT * FROM universe_metrics WHERE symbol = 'SPLT.US'").get()!;
    expect(r.price_date).toBe("2026-09-28");
    expect(r.change_pct).toBeGreaterThan(0); // not -50%
    expect(r.change_pct).toBeLessThan(1);
    expect(r.perf_1w).toBeGreaterThan(0);
    const pre = db.query<{ close: number; adj_close: number }, []>("SELECT close, adj_close FROM universe_bars WHERE symbol = 'SPLT.US' AND date = '2026-09-25'").get()!;
    expect(pre.adj_close / pre.close).toBeCloseTo(0.5, 9); // stored history restated after the re-pull
    const spark = getSparklinesFrom(db, ["SPLT.US", "NOPE.US"], 10);
    expect(spark["SPLT.US"]!.length).toBe(10);
    expect(Math.max(...spark["SPLT.US"]!) / Math.min(...spark["SPLT.US"]!)).toBeLessThan(1.1);
    expect(spark["NOPE.US"]).toEqual([]);
  });

  test("after a gap (weekend check), prices is due to catch up", () => {
    clock.now = Date.UTC(2026, 9, 3, 16, 0); // Sat Oct 3
    market.state.asOf = "2026-10-02";
    expect(p.nextRun("prices")).toBeLessThanOrEqual(clock.now); // Tue..Fri missing → due
  });
});

describe("budget", () => {
  test("pauses instead of failing, resumes at midnight UTC", async () => {
    const db = new Database(":memory:");
    const market = fakeMarket("2099-01-01");
    const clock = { now: Date.UTC(2026, 8, 25, 23, 0) };
    const { p } = makePipeline(db, market, clock, { budget: 150 });
    await p.runPending(10);
    const st = p.status();
    const backfill = st.jobs.find((j) => j.name === "backfill")!;
    const prices = st.jobs.find((j) => j.name === "prices")!;
    expect(prices.lastError).toBeNull();
    expect(st.lastPriceDate).toBe("2026-09-25");
    expect(backfill.state).toBe("idle");
    expect(backfill.progress).toContain("budget exhausted, resumes 2026-09-26 00:00 UTC");
    expect(backfill.nextRunAt).toBe(Date.UTC(2026, 8, 26) / 1000);
    expect(st.creditsUsedToday).toBeLessThanOrEqual(150);
  });

  test("account usage near the plan limit stops work", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    const g = new CreditGuard(db, { budget: 40000, reserve: 15000, getUsage: async () => ({ apiRequests: 84950, dailyRateLimit: 100000 }), now: () => 0 });
    await g.ensure(10);
    await expect(g.ensure(100)).rejects.toThrow("near the daily limit");
    g.record("x", 40);
    expect(g.usedToday()).toBe(40);
    await expect(g.ensure(20)).rejects.toThrow(); // 84950 + 40 + 20 > 85000
  });
});

describe("scheduling with a real (advancing) clock", () => {
  test("data-driven 'due now' jobs are picked even though the clock moves between reads", async () => {
    const db = new Database(":memory:");
    const market = fakeMarket("2099-01-01");
    const clock = { now: Date.UTC(2026, 8, 25, 23, 0) };
    const { p } = makePipeline(db, market, clock);
    // Every clock read advances 1 ms, like Date.now() does in production.
    (p as any).now = () => ++clock.now;
    const ran = await p.runPending(3);
    expect(ran).toEqual(["symbols", "prices", "earnings"]);
  });
});
