import { describe, expect, test } from "bun:test";
import type { MarketInfo, ScreenerFilterDef } from "@eodview/shared";
import {
  findMarket, flagEmoji, ignoredFilters, ignoredNotice, marketCurrency, marketName, marketOptionLabel, marketOptionTitle,
  resolveMarket, showAllOption, showsLocalCurrency,
} from "./markets";
import {
  applyPreset, DEFAULT_STATE, filterKey, presetQuery, sanitizeState, setFilter, setMarket, toQuery, unavailableFilterIds,
  type ScreenerState,
} from "./queryState";

const mk = (code: string, name: string, country: string, currency: string, enabled = true): MarketInfo => ({
  code, name, country, currency, timezone: "UTC", enabled, symbols: 1200, withPrices: 1100, withFundamentals: 800, lastPriceDate: "2026-09-24",
});
const US = mk("US", "US exchanges", "USA", "USD");
const ST = mk("ST", "Nasdaq Stockholm", "Sweden", "SEK");
const LSE = mk("LSE", "London Stock Exchange", "UK", "GBP", false);
const markets = [US, ST, LSE];

const defs = (avail: Record<string, boolean>): ScreenerFilterDef[] => [
  { id: "pe", label: "P/E", group: "fundamental", options: [{ value: "u20", label: "Under 20" }], custom: { unit: "number" }, appliesTo: "stock", available: avail.pe ?? true, unavailableReason: avail.pe === false ? "No fundamentals for ST" : undefined },
  { id: "short", label: "Float Short", group: "fundamental", options: [{ value: "o5", label: "Over 5%" }], appliesTo: "stock", available: avail.short ?? true },
  { id: "sma50", label: "SMA50", group: "technical", options: [{ value: "pa", label: "Price above SMA50" }], appliesTo: "all", available: true },
];
const base = (): ScreenerState => ({ ...DEFAULT_STATE, sort: { ...DEFAULT_STATE.sort } });

describe("market helpers", () => {
  test("flag emoji from country names and ISO codes", () => {
    expect(flagEmoji("Sweden")).toBe("🇸🇪");
    expect(flagEmoji("USA")).toBe("🇺🇸");
    expect(flagEmoji("UK")).toBe("🇬🇧");
    expect(flagEmoji("de")).toBe("🇩🇪");
    expect(flagEmoji("Atlantis")).toBe("🌐");
    expect(flagEmoji(undefined)).toBe("🌐");
  });
  test("labels, titles, names", () => {
    expect(marketOptionLabel(ST)).toBe("🇸🇪 Nasdaq Stockholm (ST)");
    expect(marketOptionTitle(ST)).toContain("1,200 symbols");
    expect(marketOptionTitle(ST)).toContain("800 with fundamentals");
    expect(marketOptionTitle(LSE)).toMatch(/^Not enabled/);
    expect(marketName(markets, "ST")).toBe("Nasdaq Stockholm");
    expect(marketName(markets, "ALL")).toBe("all markets");
    expect(marketName(markets, "XX")).toBe("XX");
    expect(findMarket(markets, "LSE")?.currency).toBe("GBP");
  });
  test("resolveMarket falls back from unknown/disabled markets", () => {
    expect(resolveMarket("ST", markets)).toBe("ST");
    expect(resolveMarket("ALL", markets)).toBe("ALL");
    expect(resolveMarket("LSE", markets)).toBe("US");
    expect(resolveMarket("XX", markets)).toBe("US");
    expect(resolveMarket("XX", [ST, LSE])).toBe("ST");
    expect(resolveMarket("ST", [])).toBe("ST");
    expect(resolveMarket("ST", undefined)).toBe("ST");
  });
  test("All option only with >1 enabled market", () => {
    expect(showAllOption(markets)).toBe(true);
    expect(showAllOption([US, LSE])).toBe(false);
  });
  test("currency display", () => {
    expect(showsLocalCurrency("US")).toBe(false);
    expect(showsLocalCurrency("ST")).toBe(true);
    expect(showsLocalCurrency("ALL")).toBe(true);
    expect(marketCurrency(markets, "ST")).toBe("SEK");
    expect(marketCurrency(markets, "ALL")).toBeUndefined();
  });
});

describe("per-market filter availability", () => {
  test("switching market keeps filters, resets page, persists", () => {
    let s = setFilter(base(), "pe", { id: "pe", value: "u20" });
    s = { ...s, page: 3 };
    const t = setMarket(s, "st");
    expect(t.market).toBe("ST");
    expect(t.page).toBe(1);
    expect(t.filters).toEqual(s.filters);
    expect(setMarket(t, "ST")).toBe(t);
    expect(sanitizeState(JSON.parse(JSON.stringify(t))).market).toBe("ST");
    expect(sanitizeState({}).market).toBe("US");
    expect(sanitizeState({ market: "bad code!" }).market).toBe("US");
    expect(filterKey(t)).not.toBe(filterKey(s));
  });
  test("unavailable filters are excluded from the query but kept in state", () => {
    let s = setMarket(base(), "ST");
    s = setFilter(s, "pe", { id: "pe", min: 5, max: 20 });
    s = setFilter(s, "short", { id: "short", value: "o5" });
    s = setFilter(s, "sma50", { id: "sma50", value: "pa" });
    const d = defs({ pe: false, short: false });
    expect([...unavailableFilterIds(s.filters, d)]).toEqual(["pe", "short"]);
    const q = toQuery(s, {}, d);
    expect(q.market).toBe("ST");
    expect(q.filters).toEqual([{ id: "sma50", value: "pa" }]);
    // without defs (presets) everything is kept
    expect(toQuery(s).filters.length).toBe(3);
    expect(presetQuery(s).filters.length).toBe(3);
    expect(presetQuery(s).market).toBe("ST");
    // back on a market where they are available they are sent again
    expect(toQuery(setMarket(s, "US"), {}, defs({})).filters.length).toBe(3);
  });
  test("ignored list + notice", () => {
    const s = setFilter(setFilter(base(), "pe", { id: "pe", value: "u20" }), "short", { id: "short", value: "o5" });
    const ig = ignoredFilters(s.filters, defs({ pe: false, short: false }));
    expect(ig).toEqual([
      { id: "pe", label: "P/E", reason: "No fundamentals for ST" },
      { id: "short", label: "Float Short", reason: "No data for this market" },
    ]);
    expect(ignoredNotice(ig.length, "Nasdaq Stockholm")).toBe("2 filters ignored for Nasdaq Stockholm");
    expect(ignoredNotice(1, "all markets")).toBe("1 filter ignored for all markets");
    expect(ignoredNotice(0, "x")).toBeNull();
    expect(ignoredFilters(s.filters, undefined)).toEqual([]);
  });
  test("presets carry their market; v2 presets keep the current one", () => {
    const s = setMarket(base(), "ST");
    const withMarket = applyPreset(s, { id: "p1", name: "x", query: { filters: [], market: "US", universe: "stocks", view: "overview", sort: { column: "ticker", dir: "asc" } } });
    expect(withMarket.market).toBe("US");
    const v2 = applyPreset(s, { id: "p2", name: "y", query: { filters: [], universe: "stocks", view: "overview", sort: { column: "ticker", dir: "asc" } } });
    expect(v2.market).toBe("ST");
  });
});
