import { describe, expect, test } from "bun:test";
import type { ScreenerFilterDef, UniverseStatus } from "@eodview/shared";
import {
  cellTone, compactNumber, filterValueLabel, formatCell, formatCustomRange, formatValue, fundamentalsTotal, isUniverseBuilding,
  parseCustomBound, resultRangeText,
} from "./format";

describe("formatValue", () => {
  test("compact numbers", () => {
    expect(compactNumber(2_036_000_000)).toBe("2.04B");
    expect(compactNumber(7_730_000)).toBe("7.73M");
    expect(compactNumber(-1_500)).toBe("-1.50K");
    expect(compactNumber(3.2e12)).toBe("3.20T");
    expect(compactNumber(950)).toBe("950");
  });

  test("per format", () => {
    expect(formatCell(2_036_000_000, { id: "market_cap", format: "money" })).toBe("2.04B");
    expect(formatCell(182.5, { id: "price", format: "money" })).toBe("182.50");
    expect(formatCell(612_000, { id: "price", format: "money" })).toBe("612,000.00");
    expect(formatCell(7_730_000, { id: "volume", format: "volume" })).toBe("7.73M");
    expect(formatCell(-1.234, { id: "change_pct", format: "pct" })).toBe("-1.23%");
    expect(formatCell(12.3456, { id: "pe", format: "ratio" })).toBe("12.35");
    expect(formatCell(164000, { id: "employees", format: "number" })).toBe("164,000");
    expect(formatCell(null, { id: "pe", format: "ratio" })).toBe("-");
    expect(formatCell(undefined, { id: "pe", format: "ratio" })).toBe("-");
    expect(formatCell("Technology", { id: "sector", format: "text" })).toBe("Technology");
    expect(formatCell("2026-10-28", { id: "earnings_date", format: "date" })).toBe("2026-10-28");
    expect(formatCell(1790000000, { id: "d", format: "date" })).toBe("2026-09-21");
    expect(formatValue("12.5", "pct")).toBe("12.50%");
    expect(formatValue("n/a", "ratio")).toBe("n/a");
  });

  test("tone only for change/performance columns", () => {
    expect(cellTone(2, { id: "change_pct", format: "pct" })).toBe("up");
    expect(cellTone(-2, { id: "perf_1w", format: "pct" })).toBe("down");
    expect(cellTone(0, { id: "perf_1w", format: "pct" })).toBe("");
    expect(cellTone(-2, { id: "roe", format: "pct" })).toBe("");
    expect(cellTone(null, { id: "change_pct", format: "pct" })).toBe("");
  });
});

describe("custom bounds", () => {
  test("parse", () => {
    expect(parseCustomBound("", "number")).toBeUndefined();
    expect(parseCustomBound("2B", "money")).toBe(2e9);
    expect(parseCustomBound("500k", "volume")).toBe(5e5);
    expect(parseCustomBound("1,000", "number")).toBe(1000);
    expect(parseCustomBound("-5%", "pct")).toBe(-5);
    expect(parseCustomBound("5", "pct")).toBe(5);
    expect(parseCustomBound("5M", "pct")).toBeNull();
    expect(parseCustomBound("abc", "number")).toBeNull();
    expect(parseCustomBound("2026-10-01", "date")).toBe("2026-10-01");
    expect(parseCustomBound("10/01/2026", "date")).toBeNull();
  });

  test("range label", () => {
    expect(formatCustomRange(5, 20, "number")).toBe("5 to 20");
    expect(formatCustomRange(2e9, undefined, "money")).toBe("Over 2B");
    expect(formatCustomRange(undefined, 2.5e9, "money")).toBe("Under 2.5B");
    expect(formatCustomRange(undefined, 10, "pct")).toBe("Under 10%");
    expect(formatCustomRange("2026-01-01", undefined, "date")).toBe("After 2026-01-01");
    expect(formatCustomRange(undefined, undefined, "number")).toBe("Any");
  });

  test("filter value label", () => {
    const def: ScreenerFilterDef = {
      id: "pe", label: "P/E", group: "fundamental", options: [{ value: "o10", label: "Over 10" }], custom: { unit: "number" }, appliesTo: "stock", available: true,
    };
    expect(filterValueLabel(def, { id: "pe", value: "o10" })).toBe("Over 10");
    expect(filterValueLabel(def, { id: "pe", min: 1, max: 3 })).toBe("1 to 3");
    expect(filterValueLabel(undefined, { id: "pe", value: "zz" })).toBe("zz");
  });
});

describe("universe status", () => {
  const u = (patch: Partial<UniverseStatus>): UniverseStatus => ({
    symbols: 11020, withPrices: 11000, withFundamentals: 4210, lastPriceDate: "2026-09-24", historyDays: 300,
    creditsUsedToday: 100, dailyCreditBudget: 40000, jobs: [], ...patch,
  });

  test("fundamentals denominator from job progress", () => {
    // the job's progress is per slice ("24/80 this slice"): the denominator is the universe size
    expect(fundamentalsTotal(u({ symbols: 11448, jobs: [{ name: "fundamentals", state: "running", lastRunAt: null, lastError: null, progress: "24/80 this slice (RIVN.US)", nextRunAt: null }] }))).toBe(11448);
    expect(fundamentalsTotal(u({ symbols: 0 }))).toBeNull();
  });

  test("building detection", () => {
    expect(isUniverseBuilding(null)).toBe(false);
    expect(isUniverseBuilding(u({}))).toBe(false);
    expect(isUniverseBuilding(u({ withPrices: 20 }))).toBe(true);
    expect(isUniverseBuilding(u({ jobs: [{ name: "backfill", state: "running", lastRunAt: null, lastError: null, progress: "1/2", nextRunAt: null }] }))).toBe(true);
    expect(isUniverseBuilding(u({ jobs: [{ name: "news", state: "running", lastRunAt: null, lastError: null, progress: null, nextRunAt: null }] }))).toBe(false);
    expect(isUniverseBuilding(u({ symbols: 0, withPrices: 0 }))).toBe(false);
  });

  test("range text", () => {
    expect(resultRangeText(1234, 0, 20)).toBe("#1–20");
    expect(resultRangeText(1234, 1200, 34)).toBe("#1,201–1,234");
    expect(resultRangeText(0, 0, 0)).toBe("#0");
  });
});

describe("v3 currency display", () => {
  const { formatCell, rowCurrency, isUsdColumn } = require("./format") as typeof import("./format");
  test("USD columns get a $ prefix", () => {
    expect(isUsdColumn("market_cap_usd")).toBe(true);
    expect(formatCell(2.5e9, { id: "market_cap_usd", format: "money" })).toBe("$2.50B");
    expect(formatCell(-5, { id: "price_usd", format: "money" })).toBe("-$5.00");
    expect(formatCell(null, { id: "dollar_volume_usd", format: "money" })).toBe("-");
  });
  test("local money values carry the currency code when requested", () => {
    expect(formatCell(123.4, { id: "price", format: "money" }, { currency: "SEK" })).toBe("123.40 SEK");
    expect(formatCell(1.23e10, { id: "market_cap", format: "money" }, { currency: "SEK" })).toBe("12.30B SEK");
    expect(formatCell(123.4, { id: "price", format: "money" })).toBe("123.40");
    expect(formatCell(5, { id: "perf_3y", format: "pct" }, { currency: "SEK" })).toBe("5.00%");
    expect(formatCell(-12.5, { id: "ath_pct", format: "pct" })).toBe("-12.50%");
    expect(formatCell(88.1, { id: "ath", format: "money" }, { currency: "GBP" })).toBe("88.10 GBP");
  });
  test("row currency falls back to the market's", () => {
    expect(rowCurrency({ currency: "gbp" }, "SEK")).toBe("GBP");
    expect(rowCurrency({}, "SEK")).toBe("SEK");
    expect(rowCurrency({ currency: "" }, null)).toBeUndefined();
  });
});
