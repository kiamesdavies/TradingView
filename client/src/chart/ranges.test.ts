import { describe, expect, test } from "bun:test";
import type { Bar } from "@eodview/shared";
import {
  PRESET_TIMEFRAME, centeredRange, dateToChartTime, goToTimeframe, logicalRangeForTimes, lowerBound, parseDateInput,
  rangeStart, subtractMonths, toDateInput,
} from "./ranges";

const at = (iso: string) => Date.parse(iso) / 1000;
const DAY = 86_400;
const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 0 });

describe("presets", () => {
  test("timeframes match TradingView", () => {
    expect(PRESET_TIMEFRAME["1D"]).toBe("1m");
    expect(PRESET_TIMEFRAME["5D"]).toBe("5m");
    expect(PRESET_TIMEFRAME["1M"]).toBe("30m");
    expect(PRESET_TIMEFRAME["3M"]).toBe("1h");
    expect(PRESET_TIMEFRAME["6M"]).toBe("4h");
    expect(PRESET_TIMEFRAME.YTD).toBe("1D");
    expect(PRESET_TIMEFRAME["1Y"]).toBe("1D");
    expect(PRESET_TIMEFRAME["5Y"]).toBe("1W");
    expect(PRESET_TIMEFRAME.All).toBe("1M");
  });

  test("1D = start of the last session day in the exchange zone", () => {
    const last = at("2026-09-25T19:59:00Z"); // 15:59 NY
    expect(rangeStart("1D", last, { tz: "America/New_York" })).toBe(at("2026-09-25T04:00:00Z"));
    // after-hours bar past UTC midnight still belongs to the 25th in New York
    expect(rangeStart("1D", at("2026-09-26T00:30:00Z"), { tz: "America/New_York" })).toBe(at("2026-09-25T04:00:00Z"));
    expect(rangeStart("1D", last, { alwaysOpen: true })).toBe(last - DAY);
  });

  test("5D skips weekends", () => {
    // Tue 2026-09-22 → sessions Tue, Mon, Fri, Thu, Wed → starts Wed 2026-09-16
    expect(rangeStart("5D", at("2026-09-22T15:00:00Z"), { tz: "UTC" })).toBe(at("2026-09-16T00:00:00Z"));
    expect(rangeStart("5D", at("2026-09-22T15:00:00Z"), { tz: "America/New_York" })).toBe(at("2026-09-16T04:00:00Z"));
  });

  test("calendar presets", () => {
    const last = at("2026-09-25T00:00:00Z");
    expect(rangeStart("1M", last)).toBe(at("2026-08-25T00:00:00Z"));
    expect(rangeStart("3M", last)).toBe(at("2026-06-25T00:00:00Z"));
    expect(rangeStart("6M", last)).toBe(at("2026-03-25T00:00:00Z"));
    expect(rangeStart("1Y", last)).toBe(at("2025-09-25T00:00:00Z"));
    expect(rangeStart("5Y", last)).toBe(at("2021-09-25T00:00:00Z"));
    expect(rangeStart("YTD", last)).toBe(at("2026-01-01T00:00:00Z"));
    expect(rangeStart("All", last)).toBeNull();
  });

  test("month subtraction clamps the day", () => {
    expect(subtractMonths(at("2026-03-31T10:00:00Z"), 1)).toBe(at("2026-02-28T10:00:00Z"));
    expect(subtractMonths(at("2024-03-31T00:00:00Z"), 1)).toBe(at("2024-02-29T00:00:00Z"));
    expect(subtractMonths(at("2026-01-15T00:00:00Z"), 2)).toBe(at("2025-11-15T00:00:00Z"));
  });
});

describe("go to date", () => {
  const now = at("2026-09-25T12:00:00Z");
  test("keeps reachable intraday intervals", () => {
    expect(goToTimeframe("1m", now - 5 * DAY, now)).toBe("1m");
    expect(goToTimeframe("1h", now - 1000 * DAY, now)).toBe("1h");
    expect(goToTimeframe("1D", now - 20_000 * DAY, now)).toBe("1D");
    expect(goToTimeframe("1W", now - 20_000 * DAY, now)).toBe("1W");
  });

  test("steps to a coarser interval when too many pages, 1D beyond EODHD limits", () => {
    expect(goToTimeframe("1m", now - 100 * DAY, now)).toBe("5m");
    expect(goToTimeframe("1m", now - 300 * DAY, now)).toBe("15m");
    expect(goToTimeframe("5m", now - 1500 * DAY, now)).toBe("1h");
    expect(goToTimeframe("5m", now - 2000 * DAY, now)).toBe("4h");
    expect(goToTimeframe("4h", now - 8000 * DAY, now)).toBe("1D");
  });

  test("date input helpers", () => {
    expect(parseDateInput("2024-03-15")).toBe(at("2024-03-15T00:00:00Z"));
    expect(parseDateInput("junk")).toBeNull();
    expect(toDateInput(at("2024-03-15T00:00:00Z"))).toBe("2024-03-15");
    const d = at("2024-03-15T00:00:00Z");
    expect(dateToChartTime(d, "1D", "America/New_York")).toBe(d);
    expect(dateToChartTime(d, "5m", "America/New_York")).toBe(at("2024-03-15T04:00:00Z"));
  });
});

describe("logical ranges", () => {
  const bars = [10, 20, 30, 40, 50, 60].map(bar);
  test("lowerBound", () => {
    expect(lowerBound(bars, 5)).toBe(0);
    expect(lowerBound(bars, 30)).toBe(2);
    expect(lowerBound(bars, 31)).toBe(3);
    expect(lowerBound(bars, 99)).toBe(6);
  });

  test("range for times pads the right edge", () => {
    expect(logicalRangeForTimes(bars, 25)).toEqual({ from: 1.5, to: 7 });
    expect(logicalRangeForTimes(bars, 20, 40)).toEqual({ from: 0.5, to: 5 });
    expect(logicalRangeForTimes(bars, 100)).toBeNull();
    expect(logicalRangeForTimes([], 0)).toBeNull();
  });

  test("centered range", () => {
    expect(centeredRange(bars, 30, 20)).toEqual({ from: -8, to: 12 });
    expect(centeredRange(bars, 999, 20)).toEqual({ from: -5, to: 15 });
  });
});
