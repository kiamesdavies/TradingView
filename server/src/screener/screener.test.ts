import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HttpError } from "../http";
import { METRIC_COLUMNS, METRICS_TABLE } from "../universe/metricsSchema";
import { COLUMNS, VIEWS } from "./columns";
import { addDays, nyToday, nyWallToUnix, weekStart } from "./dates";
import { FILTERS, getFilter } from "./filters";
import { createPresetStore, DEFAULT_PRESETS } from "./presets";
import { buildQuery, compileFilter, createScreenerEngine, normalizeQuery } from "./query";
import { parseSparklineParams } from "./sparklines";
import { makeColResolver, SCREENER_COLUMN_SET, type CompileCtx } from "./sql";

// Thursday 2026-09-24, 10:00 New York
const NOW = new Date("2026-09-24T14:00:00Z");

function expect400(fn: () => unknown, msg?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    if (msg) expect((e as HttpError).message).toMatch(msg);
    return;
  }
  throw new Error("expected HttpError 400");
}

type R = Record<string, string | number | null>;
const BASE: R = { kind: "stock", exchange: "NASDAQ", country: "USA", price_date: "2026-09-23" };
const ROWS: R[] = [
  { symbol: "AAPL.US", code: "AAPL", name: "Apple", sector: "Technology", industry: "Consumer Electronics", market_cap: 3.5e12, pe: 34, price: 230, change_pct: 1.2, avg_volume: 5e7, volume: 4e7, rsi14: 55, sma50_pct: 4, sma200_pct: 12, perf_3m: 25, high_52w_pct: -2, in_sp500: 1, in_ndx: 1, earnings_date: "2026-09-24", earnings_timing: "amc", sma50_200_cross: "above", latest_news_at: 0 },
  { symbol: "MSFT.US", code: "MSFT", name: "Microsoft", sector: "Technology", industry: "Software - Infrastructure", market_cap: 3.1e12, pe: 36, price: 420, change_pct: -0.5, avg_volume: 2e7, volume: 1.5e7, rsi14: 28, sma50_pct: -3, sma200_pct: 2, perf_3m: 5, high_52w_pct: -8, in_sp500: 1, earnings_date: "2026-09-24", earnings_timing: "bmo", sma50_200_cross: "cross_above" },
  { symbol: "JPM.US", code: "JPM", name: "JPMorgan", exchange: "NYSE", sector: "Financial Services", industry: "Banks - Diversified", market_cap: 6e11, pe: 12, price: 200, change_pct: 0.1, avg_volume: 9e6, volume: 8e6, rsi14: 25, sma50_pct: -6, sma200_pct: -1, perf_3m: -4, high_52w_pct: -15, earnings_date: "2026-10-13", last_earnings_date: "2026-09-23", earnings_timing: "bmo", dividend_yield: 2.1 },
  { symbol: "TINY.US", code: "TINY", name: "Tiny Corp", exchange: "AMEX", sector: "Healthcare", industry: "Biotechnology", country: "Israel", market_cap: 4e7, pe: -3, price: 2.5, change_pct: 12, avg_volume: 3e5, volume: 2e6, rsi14: 81, sma50_pct: 35, perf_3m: 60, high_52w_pct: 0, earnings_date: "2026-09-25", earnings_timing: "bmo", new_high: "52w" },
  { symbol: "MID.US", code: "MID", name: "Mid Inc", exchange: "NYSE", sector: "Industrials", industry: "Machinery", market_cap: 5e9, pe: null, price: 55, change_pct: null, avg_volume: 6e5, volume: 5e5, rsi14: null, sma50_pct: 1, sma200_pct: 3, perf_3m: 21, high_52w_pct: -4, earnings_date: "2026-09-29", last_earnings_date: "2026-09-21" },
  { symbol: "SPY.US", code: "SPY", name: "SPDR S&P 500", kind: "etf", exchange: "NYSE ARCA", market_cap: null, price: 560, change_pct: 0.4, avg_volume: 6e7, volume: 5e7, etf_category: "Large Blend", etf_sponsor: "SPDR State Street", etf_aum: 5.5e11, etf_expense_ratio: 0.09 },
  { symbol: "TLT.US", code: "TLT", name: "iShares 20+ Year Treasury", kind: "etf", exchange: "NASDAQ", price: 90, change_pct: -0.2, avg_volume: 3e7, volume: 2e7, etf_category: "Long Government", etf_sponsor: "iShares", etf_aum: 5e10, etf_expense_ratio: 0.15 },
  { symbol: "SQQQ.US", code: "SQQQ", name: "ProShares UltraPro Short QQQ", kind: "etf", exchange: "NASDAQ", price: 8, change_pct: -3, avg_volume: 8e7, volume: 9e7, etf_category: "Trading--Inverse Equity", etf_sponsor: "ProShares" },
];

function seed(db: Database, rows = ROWS) {
  db.exec(`CREATE TABLE ${METRICS_TABLE} (${METRIC_COLUMNS.map((c) => `"${c.col}" ${c.type}${c.col === "symbol" ? " PRIMARY KEY" : ""}`).join(", ")})`);
  for (const r of rows) {
    const row = { ...BASE, ...r };
    const cols = Object.keys(row);
    db.query(`INSERT INTO ${METRICS_TABLE} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...(cols.map((c) => row[c]) as (string | number | null)[]));
  }
}

let db: Database;
let engine: ReturnType<typeof createScreenerEngine>;
beforeEach(() => {
  db = new Database(":memory:");
  seed(db);
  engine = createScreenerEngine(db, { now: () => NOW });
});

const tickers = (filters: unknown[], extra: Record<string, unknown> = {}) =>
  engine.query({ filters, universe: "all", view: "overview", sort: { column: "ticker", dir: "asc" }, offset: 0, limit: 500, ...extra })
    .rows.map((r) => r.ticker);

describe("registry", () => {
  const ctx: CompileCtx = { col: makeColResolver(), today: "2026-09-24", now: NOW };
  test("ids unique, every option compiles against whitelisted columns", () => {
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(FILTERS.length);
    for (const f of FILTERS) {
      const values = f.options.map((o) => o.value);
      expect({ id: f.id, dupes: values.filter((v, i) => values.indexOf(v) !== i) }).toEqual({ id: f.id, dupes: [] });
      for (const o of f.options) {
        const p = o.build(ctx);
        expect((p.sql.match(/\?/g) ?? []).length).toBe(p.params.length);
      }
      if (f.custom) expect(SCREENER_COLUMN_SET.has(f.custom.col)).toBe(true);
      if (f.dynamic) expect(SCREENER_COLUMN_SET.has(f.dynamic.col)).toBe(true);
      if (!f.available) expect(f.unavailableReason).toBeTruthy();
    }
  });
  test("views reference known columns; columns reference metric columns", () => {
    const ids = new Set(COLUMNS.map((c) => c.id));
    for (const v of VIEWS) for (const c of v.columns) expect(ids.has(c)).toBe(true);
    for (const c of COLUMNS) for (const col of c.cols) expect(SCREENER_COLUMN_SET.has(col)).toBe(true);
    expect(VIEWS.map((v) => v.id)).toEqual(["overview", "valuation", "financial", "ownership", "performance", "technical", "etf", "charts"]);
  });
  test("finviz vocabulary samples", () => {
    const labels = (id: string) => getFilter(id)!.options.map((o) => o.label);
    expect(labels("cap")).toContain("Mega ($200bln and more)");
    expect(labels("cap")).toContain("+Mid (over $2bln)");
    expect(labels("fa_pe")).toEqual(expect.arrayContaining(["Low (<15)", "Profitable (>0)", "High (>50)", "Under 5", "Over 50"]));
    expect(labels("ta_rsi")).toEqual(expect.arrayContaining(["Overbought (90)", "Oversold (30)", "Not Overbought (<60)", "Not Oversold (>40)"]));
    expect(labels("ta_sma50")).toEqual(expect.arrayContaining(["Price above SMA50", "Price 10% below SMA50", "Price crossed SMA50 above", "SMA50 crossed SMA200 above"]));
    expect(labels("earningsdate")).toEqual(expect.arrayContaining(["Today Before Market Open", "Yesterday After Market Close", "Next 5 Days", "This Month"]));
    expect(labels("ta_highlow52w")).toEqual(expect.arrayContaining(["New High", "0-5% below High", "0-3% above Low"]));
    expect(labels("ta_perf")).toEqual(expect.arrayContaining(["Today Up", "Week +10%", "Quarter -50%", "Year +500%", "YTD Down"]));
    expect(getFilter("ta_pattern")!.available).toBe(false);
    expect(getFilter("sh_opt")!.available).toBe(false);
  });
});

describe("predicate compilation", () => {
  const ctx: CompileCtx = { col: makeColResolver(), today: "2026-09-24", now: NOW };
  const none = () => null;
  test("sql shape and bound params", () => {
    expect(compileFilter({ id: "cap", value: "largeover" }, ctx, none)).toEqual({ sql: `"market_cap" >= ?`, params: [1e10] });
    expect(compileFilter({ id: "cap", value: "mid" }, ctx, none)).toEqual({ sql: `"market_cap" >= ? AND "market_cap" < ?`, params: [2e9, 1e10] });
    expect(compileFilter({ id: "fa_pe", value: "o20" }, ctx, none)).toEqual({ sql: `"pe" > ?`, params: [20] });
    expect(compileFilter({ id: "ta_rsi", value: "os30" }, ctx, none)).toEqual({ sql: `"rsi14" < ?`, params: [30] });
    expect(compileFilter({ id: "sh_avgvol", value: "o500" }, ctx, none)).toEqual({ sql: `"avg_volume" > ?`, params: [500000] });
    expect(compileFilter({ id: "ta_sma200", value: "pa" }, ctx, none)).toEqual({ sql: `"sma200_pct" > ?`, params: [0] });
    expect(compileFilter({ id: "fa_pe", min: 10, max: 20 }, ctx, none)).toEqual({ sql: `"pe" >= ? AND "pe" <= ?`, params: [10, 20] });
    const multi = compileFilter({ id: "cap", value: "mega|nano" }, ctx, none);
    expect(multi.sql).toBe(`("market_cap" >= ?) OR ("market_cap" >= ? AND "market_cap" < ?)`);
    expect(compileFilter({ id: "sec", value: "technology" }, ctx, () => ["Technology"])).toEqual({ sql: `"sector" IN (?)`, params: ["Technology"] });
  });
  test("missing table columns resolve to NULL", () => {
    const c2: CompileCtx = { ...ctx, col: makeColResolver(new Set(["symbol"])) };
    expect(compileFilter({ id: "fa_pe", value: "o20" }, c2, none).sql).toBe("NULL > ?");
  });
  test("results over seeded DB", () => {
    expect(tickers([{ id: "cap", value: "mega" }])).toEqual(["AAPL", "JPM", "MSFT"]);
    expect(tickers([{ id: "cap", value: "nano" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "fa_pe", value: "low" }])).toEqual(["JPM"]);
    expect(tickers([{ id: "fa_pe", value: "u15" }])).toEqual(["JPM"]); // negative P/E excluded like Finviz
    expect(tickers([{ id: "ta_rsi", value: "os30" }])).toEqual(["JPM", "MSFT"]);
    expect(tickers([{ id: "ta_rsi", value: "ob80" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "idx", value: "ndx" }])).toEqual(["AAPL"]);
    expect(tickers([{ id: "ta_sma50", value: "cross200a" }])).toEqual(["MSFT"]);
    expect(tickers([{ id: "ta_sma50", value: "pa10" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "ta_highlow52w", value: "nh" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "ta_highlow52w", value: "b0to5h" }])).toEqual(["AAPL", "MID", "TINY"]);
    expect(tickers([{ id: "ta_highlow20d", value: "nh" }])).toEqual(["TINY"]); // 52w new high implies 20d new high
    expect(tickers([{ id: "ta_perf", value: "13w20" }])).toEqual(["AAPL", "MID", "TINY"]);
    expect(tickers([{ id: "div", value: "none" }], { universe: "stocks" })).toEqual(["AAPL", "MID", "MSFT", "TINY"]);
    expect(tickers([{ id: "geo", value: "notusa" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "geo", value: "asia" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "sec", value: "financialservices" }])).toEqual(["JPM"]);
    expect(tickers([{ id: "sec", value: "technology|healthcare" }])).toEqual(["AAPL", "MSFT", "TINY"]);
    expect(tickers([{ id: "exch", value: "nysearca" }])).toEqual(["SPY"]);
    expect(tickers([{ id: "ind", value: "exchangetradedfund" }])).toEqual(["SPY", "SQQQ", "TLT"]);
    expect(tickers([{ id: "etf_assettype", value: "fixedincome" }])).toEqual(["TLT"]);
    expect(tickers([{ id: "etf_assettype", value: "equities" }])).toEqual(["SPY"]);
    expect(tickers([{ id: "etf_leverage", value: "inverse" }])).toEqual(["SQQQ"]);
    expect(tickers([{ id: "etf_netexpense", value: "u0.1" }])).toEqual(["SPY"]);
    expect(tickers([{ id: "sh_price", value: "1to5" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "fa_pe", min: "30", max: 35 }])).toEqual(["AAPL"]);
    expect(tickers([{ id: "fa_pe", min: "", max: "" }]).length).toBe(ROWS.length); // empty custom = Any
    expect(tickers([{ id: "fa_pe", value: "" }]).length).toBe(ROWS.length);
    expect(tickers([{ id: "ta_rsi", value: "os30" }, { id: "cap", value: "largeover" }])).toEqual(["JPM", "MSFT"]);
  });
});

describe("date-relative filters (fixed clock)", () => {
  test("NY calendar helpers", () => {
    expect(nyToday(NOW)).toBe("2026-09-24");
    expect(nyToday(new Date("2026-09-25T02:30:00Z"))).toBe("2026-09-24"); // 22:30 EDT
    expect(nyToday(new Date("2026-09-25T04:30:00Z"))).toBe("2026-09-25");
    expect(weekStart("2026-09-24")).toBe("2026-09-21");
    expect(weekStart("2026-09-27")).toBe("2026-09-21");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(nyWallToUnix("2026-09-24", 16)).toBe(Date.UTC(2026, 8, 24, 20) / 1000);
    expect(nyWallToUnix("2026-01-15", 0)).toBe(Date.UTC(2026, 0, 15, 5) / 1000);
    expect(nyWallToUnix("2026-03-08", 12)).toBe(Date.UTC(2026, 2, 8, 16) / 1000); // DST start day
  });
  const ed = (value: string) => tickers([{ id: "earningsdate", value }]);
  test("earnings date options", () => {
    expect(ed("today")).toEqual(["AAPL", "MSFT"]);
    expect(ed("todaybefore")).toEqual(["MSFT"]);
    expect(ed("todayafter")).toEqual(["AAPL"]);
    expect(ed("tomorrow")).toEqual(["TINY"]);
    expect(ed("tomorrowbefore")).toEqual(["TINY"]);
    expect(ed("tomorrowafter")).toEqual([]);
    expect(ed("yesterday")).toEqual(["JPM"]);
    expect(ed("yesterdaybefore")).toEqual(["JPM"]);
    expect(ed("nextdays5")).toEqual(["MID", "TINY"]);
    expect(ed("prevdays5")).toEqual(["JPM", "MID"]);
    expect(ed("thisweek")).toEqual(["AAPL", "JPM", "MID", "MSFT", "TINY"]);
    expect(ed("nextweek")).toEqual(["MID"]);
    expect(ed("thismonth")).toEqual(["AAPL", "JPM", "MID", "MSFT", "TINY"]);
    expect(tickers([{ id: "earningsdate", min: "2026-10-01", max: "2026-10-31" }])).toEqual(["JPM"]);
    expect400(() => engine.query({ filters: [{ id: "earningsdate", min: "2026-13-01" }] }), /date/);
  });
  test("clock drives 'today'", () => {
    const later = createScreenerEngine(db, { now: () => new Date("2026-09-25T13:00:00Z") });
    const q = (value: string) => later.query({ filters: [{ id: "earningsdate", value }], universe: "all", view: "overview", sort: { column: "ticker", dir: "asc" } }).rows.map((r) => r.ticker);
    expect(q("today")).toEqual(["TINY"]);
    expect(q("yesterday")).toEqual(["AAPL", "MSFT"]);
  });
  test("latest news and IPO date", () => {
    db.query(`UPDATE ${METRICS_TABLE} SET latest_news_at = ? WHERE symbol = 'MSFT.US'`).run(nyWallToUnix("2026-09-24", 8));
    db.query(`UPDATE ${METRICS_TABLE} SET latest_news_at = ? WHERE symbol = 'JPM.US'`).run(nyWallToUnix("2026-09-23", 17));
    db.query(`UPDATE ${METRICS_TABLE} SET ipo_date = '2026-09-20' WHERE symbol = 'TINY.US'`).run();
    db.query(`UPDATE ${METRICS_TABLE} SET ipo_date = '1980-12-12' WHERE symbol = 'AAPL.US'`).run();
    expect(tickers([{ id: "news_date", value: "today" }])).toEqual(["MSFT"]);
    expect(tickers([{ id: "news_date", value: "yesterdayafter" }])).toEqual(["JPM"]);
    expect(tickers([{ id: "news_date", value: "sinceyesterday" }])).toEqual(["JPM", "MSFT"]);
    expect(tickers([{ id: "ipodate", value: "prevweek" }])).toEqual(["TINY"]);
    expect(tickers([{ id: "ipodate", value: "more25" }])).toEqual(["AAPL"]);
  });
});

describe("query building", () => {
  const base = { filters: [], universe: "stocks", view: "overview", sort: { column: "market_cap", dir: "desc" }, offset: 0, limit: 2 };
  test("sort, NULLs last, paging, total, asOf", () => {
    const r = engine.query(base);
    expect(r.total).toBe(5);
    expect(r.rows.map((x) => x.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(r.asOf).toBe("2026-09-23");
    expect(Object.keys(r.rows[0]!)).toEqual(["symbol", ...VIEWS[0]!.columns]);
    expect(engine.query({ ...base, offset: 4 }).rows.map((x) => x.ticker)).toEqual(["TINY"]);
    for (const dir of ["asc", "desc"]) {
      const rows = engine.query({ ...base, sort: { column: "pe", dir }, limit: 10 }).rows;
      expect(rows.at(-1)!.ticker).toBe("MID"); // NULL P/E last both ways
    }
    expect(engine.query({ ...base, sort: { column: "pe", dir: "asc" }, limit: 10 }).rows.map((x) => x.ticker)).toEqual(["TINY", "JPM", "AAPL", "MSFT", "MID"]);
    // sorting by a column outside the view is allowed
    expect(engine.query({ ...base, sort: { column: "rsi14", dir: "desc" }, limit: 1 }).rows[0]!.ticker).toBe("TINY");
  });
  test("universe and tickers restriction", () => {
    expect(engine.query({ ...base, universe: "etfs", limit: 10 }).total).toBe(3);
    expect(engine.query({ ...base, universe: "all", limit: 10 }).total).toBe(8);
    expect(engine.query({ ...base, universe: "all", tickers: "aapl, SPY.US  jpm", limit: 10 }).rows.map((x) => x.symbol).sort()).toEqual(["AAPL.US", "JPM.US", "SPY.US"]);
    expect(engine.query({ ...base, view: "charts" }).rows.length).toBe(2);
    expect(engine.query({ ...base, view: "etf", universe: "etfs", sort: { column: "etf_aum", dir: "desc" } }).rows[0]).toMatchObject({ ticker: "SPY", etf_sponsor: "SPDR State Street", etf_aum: 5.5e11 });
  });
  test("validation and injection attempts → 400", () => {
    expect400(() => engine.query({ ...base, sort: { column: "price; DROP TABLE universe_metrics", dir: "asc" } }), /sort column/);
    expect400(() => engine.query({ ...base, sort: { column: "price", dir: "asc; --" } }), /dir/);
    expect400(() => engine.query({ ...base, filters: [{ id: "fa_pe", value: "' OR 1=1 --" }] }), /unknown option/);
    expect400(() => engine.query({ ...base, filters: [{ id: "sec", value: "technology' OR '1'='1" }] }), /unknown option/);
    expect400(() => engine.query({ ...base, filters: [{ id: "sec", value: "nosuchsector" }] }), /unknown option/);
    expect400(() => engine.query({ ...base, filters: [{ id: "x; DROP", value: "o5" }] }), /unknown filter/);
    expect400(() => engine.query({ ...base, filters: [{ id: "fa_pe", min: "1) OR (1=1" }] }), /number/);
    expect400(() => engine.query({ ...base, filters: [{ id: "ta_perf", min: 1 }] }), /custom range/);
    expect400(() => engine.query({ ...base, filters: [{ id: "ta_pattern", value: "x" }] }), /not available/);
    expect400(() => engine.query({ ...base, tickers: "AAPL'); DROP TABLE x; --" }), /ticker/);
    expect400(() => engine.query({ ...base, limit: 501 }), /limit/);
    expect400(() => engine.query({ ...base, offset: -1 }), /offset/);
    expect400(() => engine.query({ ...base, view: "nope" }), /view/);
    expect400(() => engine.query({ ...base, universe: "crypto" }), /universe/);
    expect400(() => engine.query("nope"), /object/);
    // table intact
    expect(engine.query({ ...base, universe: "all", limit: 10 }).total).toBe(8);
  });
  test("SQL text never contains user values", () => {
    const q = normalizeQuery({ ...base, tickers: "AAPL", filters: [{ id: "fa_pe", min: 12345 }] });
    const b = buildQuery(q, { col: makeColResolver(), today: "2026-09-24", now: NOW }, () => null);
    expect(b.select.sql).not.toContain("12345");
    expect(b.select.sql).not.toContain("AAPL");
    expect(b.select.params).toContain(12345);
    expect(b.select.params.slice(-2)).toEqual([2, 0]);
  });
  test("missing table → empty result", () => {
    const e = createScreenerEngine(new Database(":memory:"), { now: () => NOW });
    expect(e.query(base)).toEqual({ total: 0, rows: [], asOf: null });
    expect(e.meta({} as never).filters.length).toBe(FILTERS.length);
  });
});

describe("meta", () => {
  test("dynamic options and data coverage", () => {
    const m = engine.meta({ symbols: 8 } as never);
    const f = (id: string) => m.filters.find((x) => x.id === id)!;
    expect(f("sec").options).toEqual(expect.arrayContaining([{ value: "financialservices", label: "Financial" }, { value: "technology", label: "Technology" }]));
    expect(f("exch").options.map((o) => o.label)).toEqual(expect.arrayContaining(["AMEX", "NASDAQ", "NYSE", "NYSE Arca"]));
    expect(f("geo").options.slice(0, 2).map((o) => o.value)).toEqual(["usa", "notusa"]);
    expect(f("geo").options.filter((o) => o.value === "usa").length).toBe(1); // DB "USA" merges with the static option
    expect(f("geo").options.map((o) => o.value)).toContain("israel");
    expect(f("etf_sponsor").options.length).toBe(3);
    expect(f("cap").custom).toEqual({ unit: "money" });
    expect(f("fa_roe").available).toBe(false); // no ROE values seeded
    expect(f("fa_roe").unavailableReason).toMatch(/No data/);
    expect(f("fa_pe").available).toBe(true);
    expect(f("ta_pattern").available).toBe(false);
    expect(m.views.length).toBe(8);
    expect(m.universe.symbols).toBe(8);
  });
});

describe("presets", () => {
  test("seeded once, runnable, CRUD", () => {
    const store = createPresetStore(db);
    const seeded = store.list();
    expect(seeded.map((p) => p.name)).toEqual(DEFAULT_PRESETS.map((p) => p.name));
    for (const p of seeded) expect(() => engine.query({ ...p.query, offset: 0, limit: 10 })).not.toThrow();
    const momentum = engine.query({ ...seeded[0]!.query, offset: 0, limit: 10 });
    expect(momentum.rows.map((r) => r.ticker)).toEqual(["AAPL", "MID"]);

    const created = store.create({ name: "  Cheap banks ", query: { filters: [{ id: "fa_pe", value: "u15" }, { id: "sec", value: "financialservices" }], universe: "stocks", view: "valuation", sort: { column: "pe", dir: "asc" } } });
    expect(created.name).toBe("Cheap banks");
    expect(store.get(created.id)).toEqual(created);
    const upd = store.update(created.id, { id: created.id, name: "Banks", query: { ...created.query, view: "financial" } });
    expect(upd).toMatchObject({ name: "Banks", query: { view: "financial" } });
    expect(store.update("nope", { name: "x" })).toBeNull();
    expect400(() => store.update(created.id, { id: "other" }), /id/);
    expect400(() => store.create({ name: "", query: {} }), /name/);
    expect400(() => store.create({ name: "x", query: { filters: [{ id: "bogus", value: "1" }] } }), /unknown filter/);
    expect400(() => store.create({ name: "x", query: { filters: [{ id: "cap", value: "huge" }] } }), /unknown option/);
    expect(store.remove(created.id)).toBe(true);
    expect(store.remove(created.id)).toBe(false);

    // deleting everything does not resurrect the seeds
    for (const p of store.list()) store.remove(p.id);
    expect(createPresetStore(db).list()).toEqual([]);
  });
});

describe("sparkline params", () => {
  test("parse", () => {
    expect(parseSparklineParams(new URL("http://x/api/screener/sparklines?symbols=aapl.us,MSFT,,AAPL.US"))).toEqual({ symbols: ["AAPL.US", "MSFT.US"], days: 60 });
    expect(parseSparklineParams(new URL("http://x/?symbols=SPY.US&days=30")).days).toBe(30);
    expect400(() => parseSparklineParams(new URL("http://x/?symbols=SPY.US&days=0")), /days/);
    expect400(() => parseSparklineParams(new URL("http://x/?symbols=%3Cscript%3E")), /invalid symbol/);
  });
});
