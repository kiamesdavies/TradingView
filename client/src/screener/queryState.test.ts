import { describe, expect, test } from "bun:test";
import type { ScreenerFilterDef } from "@eodview/shared";
import {
  activeCounts, applyPreset, DEFAULT_STATE, filterKey, isEmptyFilter, normalizeTickers, pageItems, presetQuery, pruneUnknownFilters,
  removeFilter, resetFilters, sanitizeState, setFilter, setPage, setPageSize, setUniverse, setView, toggleSort, toQuery, totalPages,
  type ScreenerState,
} from "./queryState";

const base = (): ScreenerState => ({ ...DEFAULT_STATE, sort: { ...DEFAULT_STATE.sort } });

const defs: ScreenerFilterDef[] = [
  { id: "pe", label: "P/E", group: "fundamental", options: [{ value: "o10", label: "Over 10" }], custom: { unit: "number" }, appliesTo: "stock", available: true },
  { id: "sector", label: "Sector", group: "descriptive", options: [{ value: "tech", label: "Technology" }], appliesTo: "all", available: true },
  { id: "sma50", label: "SMA50", group: "technical", options: [{ value: "pa", label: "Price above SMA50" }], appliesTo: "all", available: true },
];

describe("filters", () => {
  test("set, replace in place, clear, and reset page", () => {
    let s = { ...base(), page: 4 };
    s = setFilter(s, "pe", { id: "pe", value: "o10" });
    expect(s.page).toBe(1);
    s = setFilter(s, "sector", { id: "sector", value: "tech" });
    s = setFilter(s, "pe", { id: "pe", min: 5, max: 20 });
    expect(s.filters).toEqual([{ id: "pe", min: 5, max: 20 }, { id: "sector", value: "tech" }]);
    s = removeFilter(s, "pe");
    expect(s.filters).toEqual([{ id: "sector", value: "tech" }]);
    s = setFilter(s, "sector", { id: "sector", value: "" });
    expect(s.filters).toEqual([]);
  });

  test("custom range drops blank bounds; fully blank is Any", () => {
    let s = setFilter(base(), "pe", { id: "pe", min: "", max: 20 });
    expect(s.filters).toEqual([{ id: "pe", max: 20 }]);
    s = setFilter(s, "pe", { id: "pe", min: undefined, max: undefined });
    expect(s.filters).toEqual([]);
    expect(isEmptyFilter({ id: "x", min: Number.NaN })).toBe(true);
  });

  test("reset keeps view/sort/universe", () => {
    let s = setFilter({ ...base(), view: "valuation", universe: "etfs", tickers: "AAPL", presetId: "p1" }, "pe", { id: "pe", value: "o10" });
    s = resetFilters(s);
    expect(s.filters).toEqual([]);
    expect(s.tickers).toBe("");
    expect(s.presetId).toBeNull();
    expect(s.view).toBe("valuation");
    expect(s.universe).toBe("etfs");
  });

  test("active counts per tab", () => {
    let s = setFilter(base(), "pe", { id: "pe", value: "o10" });
    s = setFilter(s, "sma50", { id: "sma50", value: "pa" });
    s = setFilter(s, "unknown", { id: "unknown", value: "x" });
    const c = activeCounts(s.filters, defs);
    expect(c).toEqual({ descriptive: 0, fundamental: 1, technical: 1, news: 0, etf: 0, all: 2 });
  });

  test("prune unknown filters / options / custom on a non-custom def", () => {
    const s = { ...base(), filters: [{ id: "pe", value: "o10" }, { id: "gone", value: "x" }, { id: "sector", value: "nope" }, { id: "sector2", min: 1 }] };
    expect(pruneUnknownFilters(s, defs).filters).toEqual([{ id: "pe", value: "o10" }]);
    const t = { ...base(), filters: [{ id: "sector", min: 1 }] };
    expect(pruneUnknownFilters(t, defs).filters).toEqual([]);
    const same = { ...base(), filters: [{ id: "pe", min: 1 }] };
    expect(pruneUnknownFilters(same, defs)).toBe(same);
  });
});

describe("sort / page / universe", () => {
  test("toggleSort toggles same column and uses firstDir for a new one", () => {
    let s = { ...base(), page: 3 };
    s = toggleSort(s, "market_cap", "desc");
    expect(s.sort).toEqual({ column: "market_cap", dir: "desc" });
    expect(s.page).toBe(1);
    s = toggleSort(s, "market_cap");
    expect(s.sort.dir).toBe("asc");
    s = toggleSort(s, "market_cap");
    expect(s.sort.dir).toBe("desc");
  });

  test("setPage clamps", () => {
    expect(setPage(base(), 0).page).toBe(1);
    expect(setPage(base(), 99, 45).page).toBe(3);
    expect(setPage(base(), 2.7).page).toBe(2);
  });

  test("setPageSize keeps first visible row", () => {
    const s = { ...base(), page: 6, pageSize: 20 as const }; // rows 101..120
    expect(setPageSize(s, 50).page).toBe(3); // rows 101..150
    expect(setPageSize(s, 100).page).toBe(2);
  });

  test("universe change resets page; same universe is a no-op", () => {
    const s = { ...base(), page: 5 };
    expect(setUniverse(s, "stocks")).toBe(s);
    expect(setUniverse(s, "all").page).toBe(1);
  });

  test("view change keeps page", () => {
    expect(setView({ ...base(), page: 3 }, "technical").page).toBe(3);
  });

  test("totalPages", () => {
    expect(totalPages(0, 20)).toBe(1);
    expect(totalPages(20, 20)).toBe(1);
    expect(totalPages(21, 20)).toBe(2);
  });

  test("pageItems like Finviz", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(7, 20)).toEqual([1, "gap", 5, 6, 7, 8, 9, "gap", 20]);
    expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, 6, "gap", 20]);
    expect(pageItems(20, 20)).toEqual([1, "gap", 15, 16, 17, 18, 19, 20]);
    expect(pageItems(4, 20)).toEqual([1, 2, 3, 4, 5, 6, "gap", 20]);
    expect(pageItems(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, "gap", 20]);
  });
});

describe("query building", () => {
  test("toQuery maps paging, charts view and tickers", () => {
    let s: ScreenerState = { ...base(), page: 3, pageSize: 50, view: "charts", tickers: " aapl msft,aapl " };
    s = setFilter(s, "pe", { id: "pe", value: "o10" });
    s = { ...s, page: 3 };
    const q = toQuery(s);
    expect(q).toEqual({
      filters: [{ id: "pe", value: "o10" }],
      market: "US",
      universe: "stocks",
      tickers: "AAPL, MSFT",
      view: "overview",
      sort: { column: "ticker", dir: "asc" },
      offset: 100,
      limit: 50,
    });
    expect(toQuery(s, { offset: 0, limit: 1000 }).limit).toBe(500);
    expect("tickers" in toQuery(base())).toBe(false);
  });

  test("normalizeTickers", () => {
    expect(normalizeTickers("")).toBeUndefined();
    expect(normalizeTickers("nvda; amd\n intc")).toBe("NVDA, AMD, INTC");
  });

  test("filterKey ignores paging/sort/view but tracks filters/universe/tickers", () => {
    const s = base();
    expect(filterKey({ ...s, page: 9, view: "x", sort: { column: "pe", dir: "desc" } })).toBe(filterKey(s));
    expect(filterKey({ ...s, universe: "all" })).not.toBe(filterKey(s));
    expect(filterKey({ ...s, tickers: "aapl" })).toBe(filterKey({ ...s, tickers: " AAPL " }));
  });

  test("preset round trip", () => {
    let s = setFilter({ ...base(), view: "charts", universe: "etfs" }, "sector", { id: "sector", value: "tech" });
    s = toggleSort(s, "change_pct", "desc");
    const pq = presetQuery(s);
    expect(pq.view).toBe("charts");
    expect("offset" in pq).toBe(false);
    const loaded = applyPreset({ ...base(), page: 7, pageSize: 100 }, { id: "p1", name: "x", query: pq });
    expect(loaded.filters).toEqual(s.filters);
    expect(loaded.universe).toBe("etfs");
    expect(loaded.sort).toEqual({ column: "change_pct", dir: "desc" });
    expect(loaded.page).toBe(1);
    expect(loaded.pageSize).toBe(100);
    expect(loaded.presetId).toBe("p1");
  });
});

describe("sanitizeState", () => {
  test("garbage -> defaults", () => {
    expect(sanitizeState(null)).toEqual(DEFAULT_STATE);
    expect(sanitizeState("x")).toEqual(DEFAULT_STATE);
  });

  test("filters validated and de-duplicated; fields clamped", () => {
    const s = sanitizeState({
      filters: [{ id: "pe", value: "o10" }, { id: "pe", value: "u5" }, { id: "", value: "x" }, { id: "rsi", min: 30, max: "bad" }, { id: "e", min: null }, 5],
      universe: "crypto",
      sort: { column: "pe", dir: "desc" },
      page: -3,
      pageSize: 33,
      tab: "technical",
      filtersOpen: false,
      presetId: "",
      tickers: "AAPL",
    });
    expect(s.filters).toEqual([{ id: "pe", value: "o10" }, { id: "rsi", min: 30, max: "bad" }]);
    expect(s.universe).toBe("stocks");
    expect(s.sort).toEqual({ column: "pe", dir: "desc" });
    expect(s.page).toBe(1);
    expect(s.pageSize).toBe(20);
    expect(s.tab).toBe("technical");
    expect(s.filtersOpen).toBe(false);
    expect(s.presetId).toBeNull();
    expect(s.tickers).toBe("AAPL");
  });
});
