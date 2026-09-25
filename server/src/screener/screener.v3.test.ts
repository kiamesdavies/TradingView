// v3: multi-market screening, coverage-based availability, Finviz URL codes, new filters/columns.
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { MarketInfo } from "@eodview/shared";
import { HttpError } from "../http";
import { METRICS_TABLE } from "../universe/metricsSchema";
import { getView, VIEWS } from "./columns";
import { FINVIZ_ORDER_ALIASES, parseFinvizFilters, parseOrder } from "./finviz";
import { FILTERS, getFilter } from "./filters";
import { buildQuery, compileFilter, coverageReason, createScreenerEngine, normalizeQuery } from "./query";
import { makeColResolver, SCREENER_COLUMNS, type CompileCtx } from "./sql";

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
const US: R = { kind: "stock", market: "US", currency: "USD", exchange: "NASDAQ", country: "USA", price_date: "2026-09-23" };
const ST: R = { kind: "stock", market: "ST", currency: "SEK", exchange: "ST", country: "Sweden", price_date: "2026-09-23", fx_to_usd: 0.1 };
const LSE: R = { kind: "stock", market: "LSE", currency: "GBP", exchange: "LSE", country: "United Kingdom", price_date: "2026-09-22", fx_to_usd: 1.3 };
const ROWS: R[] = [
  // US: *_usd deliberately NULL on AAPL to exercise the USD-listing fallback
  { ...US, symbol: "AAPL.US", code: "AAPL", name: "Apple", sector: "Technology", market_cap: 3.5e12, price: 230, dollar_volume: 1.1e10, avg_volume: 5e7, perf_3y: 80, perf_5y: 250, ath_pct: 0, atl_pct: 9000, ath_date: "2026-09-23", short_float: 1, insider_trans: -2, in_sp500: 1 },
  { ...US, symbol: "TINY.US", code: "TINY", name: "Tiny", sector: "Healthcare", market_cap: 4e7, market_cap_usd: 4e7, price: 2.5, price_usd: 2.5, dollar_volume: 7.5e5, dollar_volume_usd: 7.5e5, avg_volume: 3e5, perf_3y: -70, perf_5y: -90, ath_pct: -95, atl_pct: 2, short_float: 25, insider_trans: 5, in_sp500: 0 },
  // ST: prices in SEK
  { ...ST, symbol: "VOLV-B.ST", code: "VOLV-B", name: "Volvo B", sector: "Industrials", market_cap: 6e11, market_cap_usd: 6e10, price: 290, price_usd: 29, dollar_volume: 2.9e9, dollar_volume_usd: 2.9e8, avg_volume: 1e7, perf_3y: 60, perf_5y: 90, ath_pct: -2, atl_pct: 400, in_sp500: 0, indices: "OMXS30,OMXSPI" },
  { ...ST, symbol: "SMOL.ST", code: "SMOL", name: "Smol AB", sector: "Technology", market_cap: 5e9, market_cap_usd: 5e8, price: 40, price_usd: 4, dollar_volume: 4e7, dollar_volume_usd: 4e6, avg_volume: 1e6, perf_3y: 150, perf_5y: null, ath_pct: -40, atl_pct: 1, ath_date: "2021-11-01", in_sp500: 0 },
  { ...ST, symbol: "XACT.ST", code: "XACT", name: "XACT OMXS30", kind: "etf", sector: null, market_cap: null, price: 350, price_usd: 35, dollar_volume_usd: 1e6, avg_volume: 3e5, in_sp500: 0 },
  // LSE: a market not enabled by the markets provider
  { ...LSE, symbol: "SHEL.LSE", code: "SHEL", name: "Shell", sector: "Energy", market_cap: 1.6e11, market_cap_usd: 2.1e11, price: 27, price_usd: 35, dollar_volume_usd: 5e8, avg_volume: 1.5e7, perf_3y: 30, ath_pct: -5, atl_pct: 150, in_sp500: 0 },
];

const mi = (code: string, enabled: boolean, name = code): MarketInfo => ({
  code, name, country: "", currency: "", timezone: "", enabled, symbols: 0, withPrices: 0, withFundamentals: 0, lastPriceDate: null,
});
const MARKETS = [mi("US", true, "US exchanges"), mi("ST", true, "Nasdaq Stockholm"), mi("LSE", false, "London")];

function seed(db: Database, rows = ROWS) {
  db.exec(`CREATE TABLE ${METRICS_TABLE} (${SCREENER_COLUMNS.map((c) => `"${c.col}" ${c.type}${c.col === "symbol" ? " PRIMARY KEY" : ""}`).join(", ")})`);
  for (const row of rows) {
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
  engine = createScreenerEngine(db, { now: () => NOW, markets: () => MARKETS });
});

const run = (filters: unknown[], extra: Record<string, unknown> = {}) =>
  engine.query({ filters, universe: "all", view: "overview", sort: { column: "ticker", dir: "asc" }, offset: 0, limit: 500, ...extra });
const tickers = (filters: unknown[], extra: Record<string, unknown> = {}) => run(filters, extra).rows.map((r) => r.ticker);

describe("market param", () => {
  test("default US, single market, ALL = enabled markets", () => {
    expect(tickers([])).toEqual(["AAPL", "TINY"]);
    expect(tickers([], { market: "st" })).toEqual(["SMOL", "VOLV-B", "XACT"]);
    expect(tickers([], { market: "LSE" })).toEqual(["SHEL"]); // disabled markets are still queryable directly
    expect(tickers([], { market: "ALL" })).toEqual(["AAPL", "SMOL", "TINY", "VOLV-B", "XACT"]);
    expect(normalizeQuery({}).market).toBe("US");
    expect400(() => run([], { market: "XX" }), /unknown market/);
    expect400(() => run([], { market: "ST; DROP" }), /unknown market/);
    expect400(() => run([], { market: 5 }), /market/);
  });
  test("asOf is per market", () => {
    expect(run([], { market: "LSE" }).asOf).toBe("2026-09-22");
    expect(run([], { market: "US" }).asOf).toBe("2026-09-23");
  });
  test("Market and Currency filters", () => {
    expect(tickers([{ id: "market", value: "st" }], { market: "ALL" })).toEqual(["SMOL", "VOLV-B", "XACT"]);
    expect(tickers([{ id: "currency", value: "sek|usd" }], { market: "ALL" })).toEqual(["AAPL", "SMOL", "TINY", "VOLV-B", "XACT"]);
    expect(tickers([{ id: "currency", value: "gbp" }], { market: "LSE" })).toEqual(["SHEL"]);
    expect400(() => run([{ id: "currency", value: "xyz" }]), /unknown option/);
  });
  test("legacy table without market column = US", () => {
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE ${METRICS_TABLE} ("symbol" TEXT PRIMARY KEY, "code" TEXT, "kind" TEXT, "price" REAL, "market_cap" REAL)`);
    d.exec(`INSERT INTO ${METRICS_TABLE} VALUES ('AAPL.US', 'AAPL', 'stock', 230, 3.5e12)`);
    const e = createScreenerEngine(d, { now: () => NOW });
    const q = { filters: [{ id: "cap", value: "mega" }], universe: "all", view: "overview", sort: { column: "ticker", dir: "asc" } };
    expect(e.query(q).rows.map((r) => r.ticker)).toEqual(["AAPL"]);
    expect(e.query({ ...q, market: "ALL" }).rows.map((r) => r.ticker)).toEqual(["AAPL"]);
    expect(e.meta({} as never).markets.map((m) => m.code)).toEqual(["US"]);
  });
});

describe("USD column switching", () => {
  const ctx: CompileCtx = { col: makeColResolver(), today: "2026-09-24", now: NOW };
  test("predicates", () => {
    expect(compileFilter({ id: "cap", value: "largeover" }, ctx, () => null).sql).toBe(`"market_cap" >= ?`);
    const usd = compileFilter({ id: "cap", value: "largeover" }, { ...ctx, usd: true }, () => null);
    expect(usd.sql).toContain(`COALESCE("market_cap_usd", CASE WHEN`);
    expect(usd.params).toEqual([1e10]);
    expect(compileFilter({ id: "sh_price", value: "o5" }, { ...ctx, usd: true }, () => null).sql).toContain(`"price_usd"`);
    // share volume stays in shares
    expect(compileFilter({ id: "sh_avgvol", value: "o500" }, { ...ctx, usd: true }, () => null).sql).toBe(`"avg_volume" > ?`);
  });
  test("results: SEK market cap / price compared in USD", () => {
    // Volvo: 600bn SEK = 60bn USD → Large; Smol 5bn SEK = 500M USD → Small
    expect(tickers([{ id: "cap", value: "large" }], { market: "ST" })).toEqual(["VOLV-B"]);
    expect(tickers([{ id: "cap", value: "small" }], { market: "ST" })).toEqual(["SMOL"]);
    expect(tickers([{ id: "cap", value: "mid" }], { market: "ST" })).toEqual([]); // 5bn SEK would be Mid in local units
    expect(tickers([{ id: "sh_price", value: "u5" }], { market: "ST" })).toEqual(["SMOL"]); // 40 SEK = $4
    // ALL: US rows with NULL *_usd fall back to the USD listing values
    expect(tickers([{ id: "cap", value: "mega" }], { market: "ALL" })).toEqual(["AAPL"]);
    expect(tickers([{ id: "cap", value: "largeover" }, { id: "sh_price", value: "o20" }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
  });
  test("Dollar Volume filter", () => {
    expect(tickers([{ id: "sh_dollarvol", value: "o10" }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
    expect(tickers([{ id: "sh_dollarvol", value: "u1" }], { market: "ALL" })).toEqual(["TINY"]);
    expect(tickers([{ id: "sh_dollarvol", min: 1e6, max: 5e6 }], { market: "ST" })).toEqual(["SMOL", "XACT"]);
  });
  test("sort by market cap uses USD outside the US", () => {
    const r = run([], { market: "ALL", universe: "stocks", sort: { column: "market_cap", dir: "desc" } });
    expect(r.rows.map((x) => x.ticker)).toEqual(["AAPL", "VOLV-B", "SMOL", "TINY"]);
  });
});

describe("views per market", () => {
  test("overview adds Market / Mkt Cap $ outside the US", () => {
    expect(getView("overview", "US")).toEqual(VIEWS[0]!);
    const intl = getView("overview", "ST")!;
    expect(intl.columns).toEqual(expect.arrayContaining(["market", "market_cap_usd", "currency"]));
    expect(intl.columns).not.toContain("market_cap");
    expect(getView("valuation", "ALL")!.columns).toContain("market_cap_usd");
    expect(getView("performance")!.columns).toEqual(expect.arrayContaining(["perf_3y", "perf_5y"]));
    expect(getView("technical")!.columns).toContain("ath_pct");
    const row = run([], { market: "ST", tickers: "VOLV-B" }).rows[0]!;
    expect(Object.keys(row)).toEqual(["symbol", ...intl.columns]);
    expect(row).toMatchObject({ market: "ST", market_cap_usd: 6e10, currency: "SEK" });
    // AAPL's NULL market_cap_usd falls back to market_cap
    expect(run([], { market: "ALL", tickers: "AAPL" }).rows[0]).toMatchObject({ market: "US", market_cap_usd: 3.5e12 });
    expect(engine.meta({} as never, "ST").views.find((v) => v.id === "overview")!.columns).toContain("market");
  });
});

describe("new technical filters", () => {
  test("All-Time High/Low", () => {
    expect(getFilter("ta_alltime")!.available).toBe(true);
    expect(tickers([{ id: "ta_alltime", value: "nh" }], { market: "ALL" })).toEqual(["AAPL"]);
    expect(tickers([{ id: "ta_alltime", value: "nl" }], { market: "ALL" })).toEqual([]);
    expect(tickers([{ id: "ta_alltime", value: "b0to3h" }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
    expect(tickers([{ id: "ta_alltime", value: "b30h" }], { market: "ALL" })).toEqual(["SMOL", "TINY"]);
    expect(tickers([{ id: "ta_alltime", value: "a0to3l" }], { market: "ALL" })).toEqual(["SMOL", "TINY"]);
    expect(tickers([{ id: "ta_alltime", value: "a300l" }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
    expect(tickers([{ id: "ta_alltime", min: -10 }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
  });
  test("market index membership", () => {
    expect(tickers([{ id: "idx", value: "omxs30" }], { market: "ST" })).toEqual(["VOLV-B"]);
    expect(tickers([{ id: "idx", value: "omxs30|sp500" }], { market: "ALL" })).toEqual(["AAPL", "VOLV-B"]);
    expect(parseFinvizFilters("idx_omxs30")).toEqual([{ id: "idx", value: "omxs30" }]);
    expect400(() => run([{ id: "idx", value: "nosuchindex" }]), /unknown option/);
    db.query(`UPDATE ${METRICS_TABLE} SET indices = '["FTSE"]' WHERE symbol = 'SHEL.LSE'`).run();
    expect(tickers([{ id: "idx", value: "ftse" }], { market: "LSE" })).toEqual(["SHEL"]);
  });
  test("Performance 3Y / 5Y", () => {
    const labels = getFilter("ta_perf")!.options.map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(["3 Years +50%", "3 Years Up", "5 Years -50%", "5 Years +100%"]));
    expect(tickers([{ id: "ta_perf", value: "3y50" }], { market: "ALL" })).toEqual(["AAPL", "SMOL", "VOLV-B"]);
    expect(tickers([{ id: "ta_perf2", value: "5ydown" }], { market: "ALL" })).toEqual(["TINY"]);
    expect(tickers([{ id: "ta_perf", value: "3y100o" }], { market: "ALL" })).toEqual(["SMOL"]); // Finviz alias
  });
});

describe("availability by coverage", () => {
  test("pure rule", () => {
    const f = getFilter("fa_roe")!;
    const cov = (n: number) => ({ rows: { stock: 100, all: 100 }, nonNull: { stock: { roe: n }, all: { roe: n } } });
    expect(coverageReason(f, "ST", cov(15))).toBeNull();
    expect(coverageReason(f, "ST", cov(3))).toBe("No data for this market: coverage 3%");
    expect(coverageReason(getFilter("sh_short")!, "ST", { rows: { stock: 10, all: 10 }, nonNull: { stock: {}, all: {} } })).toMatch(/US-only/);
    expect(coverageReason(getFilter("sh_short")!, "ST", { rows: { stock: 10, all: 10 }, nonNull: { stock: { short_float: 9 }, all: {} } })).toBeNull();
    expect(coverageReason(f, "ST", { rows: {}, nonNull: {} })).toBeNull(); // no rows yet → keep static availability
    // fundamentals-derived columns are measured against rows whose fundamentals were fetched (rolling backfill) …
    const backfill = { rows: { stock: 1000, all: 1000 }, nonNull: { stock: { fundamentals_at: 100, roe: 90 }, all: { fundamentals_at: 100, rsi14: 50 } } };
    expect(coverageReason(f, "US", backfill)).toBeNull();
    // … bar-derived ones against every row
    expect(coverageReason(getFilter("ta_rsi")!, "US", backfill)).toBe("No data for this market: coverage 5%");
  });
  test("meta per market", () => {
    const us = engine.meta({} as never);
    const st = engine.meta({} as never, "st");
    const all = engine.meta({} as never, "ALL");
    const f = (m: typeof us, id: string) => m.filters.find((x) => x.id === id)!;
    expect(us.market).toBe("US");
    expect(st.market).toBe("ST");
    expect(st.markets.map((m) => m.code)).toEqual(["US", "ST", "LSE"]);
    // every filter has a Finviz-style code
    for (const x of us.filters) expect(x.code).toBeTruthy();
    expect(f(us, "div").code).toBe("fa_div");
    expect(f(us, "cap").code).toBe("cap");
    // short float + insider transactions: filled in US, empty in ST
    expect(f(us, "sh_short").available).toBe(true);
    expect(f(st, "sh_short").available).toBe(false);
    expect(f(st, "sh_short").unavailableReason).toBe("US-only data (coverage 0% in ST)");
    expect(f(st, "sh_insidertrans").available).toBe(false);
    expect(f(st, "fa_pe").unavailableReason).toBe("No data for this market: coverage 0%");
    // Index filter: US flags in the US, the market's own indexes elsewhere
    expect(f(us, "idx").available).toBe(true);
    expect(f(us, "idx").options.map((o) => o.value)).toEqual(["sp500", "ndx", "dji"]);
    expect(f(st, "idx").available).toBe(true);
    expect(f(st, "idx").options).toEqual([{ value: "omxs30", label: "OMX Stockholm 30" }, { value: "omxspi", label: "OMX Stockholm All-Share" }]);
    expect(f(all, "idx").available).toBe(true);
    expect(f(all, "idx").options.map((o) => o.value)).toEqual(["sp500", "ndx", "dji", "omxs30", "omxspi"]); // enabled markets
    const lse = engine.meta({} as never, "LSE");
    expect(f(lse, "idx").available).toBe(false);
    expect(f(lse, "idx").unavailableReason).toBe("No index membership data for this market yet");
    expect(f(lse, "idx").options.map((o) => o.value)).toEqual(expect.arrayContaining(["ftse", "ftmc"]));
    // Market filter only for ALL; options labelled from listMarkets
    expect(f(us, "market").available).toBe(false);
    expect(f(all, "market").available).toBe(true);
    expect(f(all, "market").options).toEqual(expect.arrayContaining([{ value: "st", label: "Nasdaq Stockholm (ST)" }]));
    expect(f(all, "market").options.map((o) => o.value)).not.toContain("lse"); // disabled market
    // dynamic options scoped to the market
    expect(f(st, "sec").options.map((o) => o.label).sort()).toEqual(["Industrials", "Technology"]);
    expect(f(st, "currency").options).toEqual([{ value: "sek", label: "SEK" }]);
    // coverage fine where data exists
    expect(f(st, "ta_alltime").available).toBe(true);
    expect(f(st, "cap").available).toBe(true);
    expect(f(st, "sh_dollarvol").available).toBe(true);
    // ETF filters in a market with ETFs but no ETF data
    expect(f(st, "etf_aum").available).toBe(false);
    expect(f(engine.meta({} as never, "LSE"), "etf_aum").unavailableReason).toBe("No ETFs in this market");
    expect400(() => engine.meta({} as never, "NOPE"), /unknown market/);
  });
});

describe("Finviz codes", () => {
  test("every filter code is unique and resolves", () => {
    const codes = FILTERS.map((f) => f.code ?? f.id);
    expect(new Set(codes).size).toBe(codes.length);
    for (const f of FILTERS) expect(getFilter(f.code ?? f.id)).toBe(f);
  });
  test("parse valid codes", () => {
    expect(parseFinvizFilters("cap_midover,ta_sma50_pa,ta_sma200_pa10,ta_rsi_os30,ta_perf_13wup,ta_highlow52w_nh,sh_avgvol_o500,sh_relvol_o2,earningsdate_thisweek,sec_technology,fa_pe_u20"))
      .toEqual([
        { id: "cap", value: "midover" }, { id: "ta_sma50", value: "pa" }, { id: "ta_sma200", value: "pa10" },
        { id: "ta_rsi", value: "os30" }, { id: "ta_perf", value: "13wup" }, { id: "ta_highlow52w", value: "nh" },
        { id: "sh_avgvol", value: "o500" }, { id: "sh_relvol", value: "o2" }, { id: "earningsdate", value: "thisweek" },
        { id: "sec", value: "technology" }, { id: "fa_pe", value: "u20" },
      ]);
    expect(parseFinvizFilters("")).toEqual([]);
    expect(parseFinvizFilters(" CAP_MEGA , ")).toEqual([{ id: "cap", value: "mega" }]);
    // longest prefix wins
    expect(parseFinvizFilters("ta_sma200_pb")).toEqual([{ id: "ta_sma200", value: "pb" }]);
    expect(parseFinvizFilters("fa_epsyoyttm_pos,fa_epsyoy1_high")).toEqual([{ id: "fa_epsyoyttm", value: "pos" }, { id: "fa_epsyoy1", value: "high" }]);
    // multi-select, our id instead of the Finviz code
    expect(parseFinvizFilters("sec_technology|healthcare,div_pos")).toEqual([{ id: "sec", value: "technology|healthcare" }, { id: "div", value: "pos" }]);
  });
  test("aliases", () => {
    expect(parseFinvizFilters("fa_div_high")).toEqual([{ id: "div", value: "high" }]);
    expect(parseFinvizFilters("ta_perf_13w20o,ta_perf2_d15u")).toEqual([{ id: "ta_perf", value: "13w20" }, { id: "ta_perf2", value: "d-15" }]);
    expect(parseFinvizFilters("exch_nasd")).toEqual([{ id: "exch", value: "nasdaq" }]);
    expect(parseFinvizFilters("ta_candlestick_d")).toEqual([{ id: "ta_candlestick", value: "doji" }]);
    // JSON queries accept aliases and codes too, normalised to ours
    expect(normalizeQuery({ filters: [{ id: "fa_div", value: "pos" }, { id: "ta_perf", value: "4w10o" }] }).filters)
      .toEqual([{ id: "div", value: "pos" }, { id: "ta_perf", value: "4w10" }]);
    // Finviz sector label slug resolves to the DB value
    expect(tickers([{ id: "sec", value: "technology" }], { market: "ALL" })).toEqual(["AAPL", "SMOL"]);
    expect(engine.query({ filters: parseFinvizFilters("sec_technology,cap_smallover"), market: "ST" }).rows.map((r) => r.ticker)).toEqual(["SMOL"]);
  });
  test("custom ranges", () => {
    expect(parseFinvizFilters("fa_pe_10to20,sh_price_to5,ta_rsi_40to")).toEqual([
      { id: "fa_pe", min: 10, max: 20 }, { id: "sh_price", max: 5 }, { id: "ta_rsi", min: 40 },
    ]);
    expect(parseFinvizFilters("sh_price_5to10")).toEqual([{ id: "sh_price", value: "5to10" }]); // an option wins
    expect(parseFinvizFilters("fa_pe_u17,ta_beta_o1.25")).toEqual([{ id: "fa_pe", max: 17 }, { id: "ta_beta", min: 1.25 }]);
    expect(parseFinvizFilters("earningsdate_10-01-2026x10-31-2026,ipodate_2020-01-01x")).toEqual([
      { id: "earningsdate", min: "2026-10-01", max: "2026-10-31" }, { id: "ipodate", min: "2020-01-01" },
    ]);
  });
  test("errors", () => {
    expect400(() => parseFinvizFilters("nope_x"), /unknown filter code "nope_x"/);
    expect400(() => parseFinvizFilters("cap"), /unknown filter code/);
    expect400(() => parseFinvizFilters("cap_"), /no option/);
    expect400(() => parseFinvizFilters("cap_huge"), /unknown option "huge" for filter cap \(Market Cap\.\); valid e\.g\. cap_mega/);
    expect400(() => parseFinvizFilters("ta_perf_13w20o|bogus"), /unknown option "bogus"/);
    expect400(() => parseFinvizFilters("ta_pattern_horizontal"), /not available/);
    expect400(() => parseFinvizFilters("earningsdate_13-45-2026x"), /unknown option/);
    expect400(() => parseFinvizFilters(Array(101).fill("cap_mega").join(",")), /at most 100/);
    // dynamic values are checked against the universe at query time
    expect(parseFinvizFilters("sec_nosuchsector")).toEqual([{ id: "sec", value: "nosuchsector" }]);
    expect400(() => engine.query({ filters: parseFinvizFilters("sec_nosuchsector") }), /unknown option/);
  });
  test("order", () => {
    expect(parseOrder("-perf_3m")).toEqual({ column: "perf_3m", dir: "desc" });
    expect(parseOrder("-perf13w")).toEqual({ column: "perf_3m", dir: "desc" });
    expect(parseOrder("marketcap")).toEqual({ column: "market_cap", dir: "asc" });
    expect(parseOrder("-ath")).toEqual({ column: "ath_pct", dir: "desc" });
    expect(parseOrder("")).toEqual({ column: "ticker", dir: "asc" });
    expect(parseOrder(null)).toEqual({ column: "ticker", dir: "asc" });
    expect400(() => parseOrder("-bogus"), /unknown order column/);
    for (const col of Object.values(FINVIZ_ORDER_ALIASES)) expect(() => parseOrder(col)).not.toThrow();
  });
  test("SQL text never contains user values (market, currency)", () => {
    const q = normalizeQuery({ market: "ST", filters: [{ id: "cap", min: 424242 }] });
    const b = buildQuery(q, { col: makeColResolver(), today: "2026-09-24", now: NOW }, () => null);
    expect(b.select.sql).not.toContain("424242");
    expect(b.select.sql).not.toContain("'ST'");
    expect(b.select.params).toEqual(expect.arrayContaining(["ST", 424242]));
  });
});
