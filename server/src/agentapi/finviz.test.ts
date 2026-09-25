import { describe, expect, test } from "bun:test";
import type { ScreenerFilterDef } from "@eodview/shared";
import { AgentError } from "./errors";
import { parseFinvizFilters, parseOrder, parseScreenParams, parseView, toFinvizCodes } from "./finviz";

const def = (id: string, options: string[], custom?: boolean, code?: string): ScreenerFilterDef => ({
  id, ...(code ? { code } : {}), label: id, group: "technical", appliesTo: "all", available: true,
  options: options.map((value) => ({ value, label: value })),
  ...(custom ? { custom: { unit: "number" as const } } : {}),
});
const DEFS = [
  def("cap", ["midover", "largeover", "small"], true),
  def("ta_perf", ["13wup", "4w10"]),
  def("ta_perf2", ["13wup"]),
  def("fa_pe", ["u15", "profitable"], true),
  def("sh_price", ["o10", "10to50"], true),
  def("sec", ["technology", "healthcare"]),
  def("earningsdate", ["today"], true),
  def("pe_alt", ["low"], false, "fa_pealt"),
];
const COLS = ["ticker", "market_cap", "perf_3m", "perf_1m", "change_pct", "rel_volume"].map((id) => ({ id }));
const VIEWS = ["overview", "performance", "technical"].map((id) => ({ id }));

function err(fn: () => unknown): AgentError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AgentError); return e as AgentError; }
  throw new Error("expected AgentError");
}

describe("parseFinvizFilters", () => {
  test("option codes, longest prefix wins, case-insensitive", () => {
    expect(parseFinvizFilters("cap_midover, TA_PERF2_13wup,ta_perf_4w10", DEFS)).toEqual([
      { id: "cap", value: "midover" }, { id: "ta_perf2", value: "13wup" }, { id: "ta_perf", value: "4w10" },
    ]);
  });
  test("custom ranges and static options that look like ranges", () => {
    expect(parseFinvizFilters("fa_pe_5to20,fa_pe_to15,cap_1e9to,sh_price_10to50", DEFS)).toEqual([
      { id: "fa_pe", min: 5, max: 20 }, { id: "fa_pe", max: 15 }, { id: "cap", min: 1e9 }, { id: "sh_price", value: "10to50" },
    ]);
    expect(parseFinvizFilters("earningsdate_2026-09-01to2026-09-30", DEFS)).toEqual([{ id: "earningsdate", min: "2026-09-01", max: "2026-09-30" }]);
    expect(parseFinvizFilters("earningsdate_2026-09-01x2026-09-30,earningsdate_x2026-10-01", DEFS)).toEqual([
      { id: "earningsdate", min: "2026-09-01", max: "2026-09-30" }, { id: "earningsdate", max: "2026-10-01" },
    ]);
  });
  test("multi-values and dynamic values pass through for engine validation", () => {
    expect(parseFinvizFilters("sec_technology|healthcare,sec_semiconductors", DEFS)).toEqual([
      { id: "sec", value: "technology|healthcare" }, { id: "sec", value: "semiconductors" },
    ]);
  });
  test("uses def.code when set", () => {
    expect(parseFinvizFilters("fa_pealt_low", DEFS)).toEqual([{ id: "pe_alt", value: "low" }]);
  });
  test("errors", () => {
    expect(err(() => parseFinvizFilters("nope_x", DEFS)).status).toBe(400);
    expect(err(() => parseFinvizFilters("cap_", DEFS)).message).toMatch(/unknown filter code/);
    expect(err(() => parseFinvizFilters("fa_pe_to", DEFS)).message).toMatch(/empty range/);
    expect(err(() => parseFinvizFilters("fa_pe_xto5", DEFS)).message).toMatch(/number or YYYY-MM-DD/);
    expect(parseFinvizFilters("", DEFS)).toEqual([]);
  });
});

describe("parseOrder / parseView", () => {
  test("columns, direction, Finviz aliases", () => {
    expect(parseOrder("-perf_3m", COLS)).toEqual({ column: "perf_3m", dir: "desc" });
    expect(parseOrder("marketcap", COLS)).toEqual({ column: "market_cap", dir: "asc" });
    expect(parseOrder("-perf13w", COLS)).toEqual({ column: "perf_3m", dir: "desc" });
    expect(parseOrder("-relvolume", COLS)).toEqual({ column: "rel_volume", dir: "desc" });
    expect(parseOrder(null, COLS)).toEqual({ column: "ticker", dir: "asc" });
    expect(err(() => parseOrder("-bogus", COLS)).detail).toContain("perf_3m");
  });
  test("views by id or Finviz number", () => {
    expect(parseView("141", VIEWS)).toBe("performance");
    expect(parseView("Technical", VIEWS)).toBe("technical");
    expect(parseView(undefined, VIEWS)).toBe("overview");
    expect(err(() => parseView("999", VIEWS)).status).toBe(400);
  });
});

describe("parseScreenParams", () => {
  const ctx = { filters: DEFS, columns: COLS, views: VIEWS };
  test("full query string", () => {
    const sp = new URLSearchParams("f=cap_midover,ta_perf_13wup&o=-perf_3m&v=141&market=us&t=AAPL,MSFT&limit=20&offset=40");
    expect(parseScreenParams(sp, ctx)).toEqual({
      filters: [{ id: "cap", value: "midover" }, { id: "ta_perf", value: "13wup" }],
      market: "US", universe: "stocks", tickers: "AAPL,MSFT", view: "performance",
      sort: { column: "perf_3m", dir: "desc" }, offset: 40, limit: 20,
    });
  });
  test("defaults, etf universe inference, limit bounds", () => {
    const q = parseScreenParams(new URLSearchParams(""), ctx);
    expect(q).toMatchObject({ filters: [], market: "US", universe: "stocks", view: "overview", offset: 0, limit: 50 });
    const etf = parseScreenParams(new URLSearchParams("f=etf_x_y"), { ...ctx, filters: [...DEFS, def("etf_x", ["y"])] });
    expect(etf.universe).toBe("etfs");
    expect(err(() => parseScreenParams(new URLSearchParams("limit=501"), ctx)).message).toMatch(/limit/);
    expect(err(() => parseScreenParams(new URLSearchParams("limit=2.5"), ctx)).status).toBe(400);
    expect(err(() => parseScreenParams(new URLSearchParams("market=U$"), ctx)).status).toBe(400);
    expect(err(() => parseScreenParams(new URLSearchParams("universe=bonds"), ctx)).status).toBe(400);
  });
  test("toFinvizCodes round-trips", () => {
    const f = parseFinvizFilters("cap_midover,fa_pe_5to20,fa_pe_to15", DEFS);
    expect(toFinvizCodes(f, DEFS)).toBe("cap_midover,fa_pe_5to20,fa_pe_to15");
  });
});
