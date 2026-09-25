import { describe, expect, test } from "bun:test";
import type { Layout } from "@eodview/shared";
import {
  applyTickToQuote, direction, formatAgo, formatChange, formatEventTime, formatPct, formatPrice, formatVolume,
  moveItem, normalizeLayout, parsePrice, splitSymbol,
} from "./format";

const DEF: Layout = { symbol: "AAPL.US", tf: "1D", chartType: "candles", theme: "dark", logScale: false, indicators: [], recentSymbols: [] };

describe("formatting", () => {
  test("prices", () => {
    expect(formatPrice(1234.5)).toBe("1,234.50");
    expect(formatPrice(0.5)).toBe("0.5000");
    expect(formatPrice(1.08234, "EURUSD.FOREX")).toBe("1.08234");
    expect(formatPrice(149.123, "USDJPY.FOREX")).toBe("149.123");
    expect(formatPrice(Number.NaN)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
  });
  test("change and pct", () => {
    expect(formatChange(1.5)).toBe("+1.50");
    expect(formatChange(-0.25, undefined, 100)).toBe("−0.25");
    expect(formatPct(2.345)).toBe("+2.35%");
    expect(formatPct(-1)).toBe("−1.00%");
    expect(formatPct(Number.NaN)).toBe("—");
    expect(direction(-1)).toBe("down");
    expect(direction(Number.NaN)).toBe("flat");
  });
  test("volume", () => {
    expect(formatVolume(0)).toBe("—");
    expect(formatVolume(950)).toBe("950");
    expect(formatVolume(12_345)).toBe("12.3K");
    expect(formatVolume(1_500_000)).toBe("1.50M");
    expect(formatVolume(234_000_000_000)).toBe("234B");
  });
  test("event time", () => {
    const now = new Date(2026, 8, 25, 15, 0, 0);
    const t = (d: Date) => Math.floor(d.getTime() / 1000);
    expect(formatEventTime(t(new Date(2026, 8, 25, 9, 5, 7)), now)).toBe("09:05:07");
    expect(formatEventTime(t(new Date(2026, 8, 24, 14, 32)), now)).toBe("Sep 24 14:32");
    expect(formatEventTime(t(new Date(2025, 0, 2, 3, 4)), now)).toBe("2025-01-02 03:04");
    expect(formatAgo(1000, 1_960_000)).toBe("16m ago");
    expect(formatAgo(0, 7_200_000)).toBe("2h ago");
  });
});

describe("applyTickToQuote", () => {
  test("uses known prevClose and accumulates volume", () => {
    const q = applyTickToQuote(
      { symbol: "AAPL.US", price: 100, change: 0, changePct: 0, volume: 1000, prevClose: 100, time: 0 },
      "AAPL.US", 102, 50, 1_700_000_000_500,
    );
    expect(q.change).toBeCloseTo(2);
    expect(q.changePct).toBeCloseTo(2);
    expect(q.volume).toBe(1050);
    expect(q.time).toBe(1_700_000_000);
  });
  test("a new session day resets volume and rolls the reference close", () => {
    const prev = { symbol: "BTC-USD.CC", price: 110, change: 10, changePct: 10, volume: 5000, prevClose: 100, time: Date.parse("2026-09-24T23:59:00Z") / 1000 };
    const same = applyTickToQuote(prev, "BTC-USD.CC", 111, 5, Date.parse("2026-09-24T23:59:30Z"));
    expect(same.volume).toBe(5005);
    expect(same.prevClose).toBe(100);
    const next = applyTickToQuote(prev, "BTC-USD.CC", 111, 5, Date.parse("2026-09-25T00:00:10Z"));
    expect(next.volume).toBe(5);
    expect(next.prevClose).toBe(110);
    expect(next.change).toBeCloseTo(1);
    // US: 00:30 UTC is still the previous New York session (after-hours)
    const us = { ...prev, symbol: "AAPL.US", time: Date.parse("2026-09-24T19:59:00Z") / 1000 };
    expect(applyTickToQuote(us, "AAPL.US", 111, 5, Date.parse("2026-09-25T00:30:00Z")).volume).toBe(5005);
    expect(applyTickToQuote(us, "AAPL.US", 111, 5, Date.parse("2026-09-25T08:00:00Z")).volume).toBe(5);
  });
  test("unknown quote leaves change undefined (NaN)", () => {
    const q = applyTickToQuote(undefined, "X.US", 5, 1, 0);
    expect(q.price).toBe(5);
    expect(Number.isNaN(q.change)).toBe(true);
    expect(q.volume).toBe(1);
  });
});

describe("moveItem", () => {
  test("moves and ignores bad indices", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("normalizeLayout", () => {
  test("null -> defaults (copied)", () => {
    const l = normalizeLayout(null, DEF);
    expect(l).toEqual(DEF);
    expect(l.indicators).not.toBe(DEF.indicators);
  });
  test("keeps valid fields, drops junk", () => {
    const l = normalizeLayout({
      symbol: "MSFT.US", tf: "4h", chartType: "nope", theme: "light", logScale: true,
      indicators: [{ id: "a", type: "sma", params: { period: 20, bad: {} }, visible: true }, { id: "b", type: "zzz" }],
      recentSymbols: ["MSFT.US", "MSFT.US", 3], activeWatchlistId: "w1",
    }, DEF);
    expect(l).toEqual({
      symbol: "MSFT.US", tf: "4h", chartType: "candles", theme: "light", logScale: true,
      indicators: [{ id: "a", type: "sma", params: { period: 20 }, visible: true }],
      recentSymbols: ["MSFT.US"], activeWatchlistId: "w1",
    });
  });
});

describe("misc", () => {
  test("splitSymbol", () => {
    expect(splitSymbol("BTC-USD.CC")).toEqual({ code: "BTC-USD", exchange: "CC" });
    expect(splitSymbol("FOO")).toEqual({ code: "FOO", exchange: "" });
  });
  test("parsePrice", () => {
    expect(parsePrice("1,234.5")).toBe(1234.5);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("-3")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
  });
});
