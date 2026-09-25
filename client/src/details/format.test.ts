import { describe, expect, test } from "bun:test";
import {
  analystTotal, avatarColor, consensusOf, displayHost, formatClock, formatCompact, formatDate, formatDaysUntil,
  formatRelative, formatShortDate, formatStat, lacksFundamentals, quarterLabel, resolveTimeZone, safeUrl,
  sentimentOf, sortNews, upsidePct,
} from "./format";

describe("formatStat", () => {
  test("volume", () => {
    expect(formatStat(7_730_000, "volume")).toBe("7.73M");
    expect(formatStat(812_345, "volume")).toBe("812.3K");
    expect(formatStat(950, "volume")).toBe("950");
    expect(formatStat(0, "volume")).toBe("—");
  });
  test("money", () => {
    expect(formatStat(2_040_000_000, "money")).toBe("2.04B");
    expect(formatStat(3.52e12, "money")).toBe("3.52T");
    expect(formatStat(-1_200_000, "money")).toBe("−1.20M");
    expect(formatStat(245.5, "money")).toBe("245.50");
  });
  test("pct, ratio, days, date, number, text, null", () => {
    expect(formatStat(0.45, "pct")).toBe("0.45%");
    expect(formatStat(-3.1, "pct")).toBe("−3.10%");
    expect(formatStat(28.456, "ratio")).toBe("28.46");
    expect(formatStat(-1.5, "ratio")).toBe("−1.50");
    expect(formatStat(47, "days")).toBe("In 47 days");
    expect(formatStat(1, "days")).toBe("Tomorrow");
    expect(formatStat(0, "days")).toBe("Today");
    expect(formatStat(-3, "days")).toBe("3 days ago");
    expect(formatStat("2026-10-29", "date")).toBe("Oct 29, 2026");
    expect(formatStat(164000, "number")).toBe("164,000");
    expect(formatStat(15_400_000_000, "number")).toBe("15.40B");
    expect(formatStat("164.08 - 260.10", "text")).toBe("164.08 - 260.10");
    expect(formatStat(null, "money")).toBe("—");
    expect(formatStat("", "text")).toBe("—");
    expect(formatStat(Number.NaN, "ratio")).toBe("—");
  });
  test("numeric strings are formatted numerically", () => {
    expect(formatStat("2040000000", "money")).toBe("2.04B");
    expect(formatStat("n/a", "money")).toBe("n/a");
  });
});

describe("dates and times", () => {
  test("formatDate", () => {
    expect(formatDate("2026-01-05")).toBe("Jan 5, 2026");
    expect(formatDate(Date.UTC(2025, 8, 17) / 1000)).toBe("Sep 17, 2025");
    expect(formatDate("garbage")).toBe("garbage");
    expect(formatDate(null)).toBe("—");
  });
  test("quarterLabel", () => {
    expect(quarterLabel("2025-09-30")).toBe("Q3 '25");
    expect(quarterLabel("2026-03-31")).toBe("Q1 '26");
    expect(quarterLabel("2009-12-31")).toBe("Q4 '09");
    expect(quarterLabel("bad")).toBe("bad");
  });
  test("formatClock in a zone", () => {
    const t = Date.UTC(2026, 8, 24, 20, 0) / 1000; // 16:00 New York (EDT)
    expect(formatClock(t, "America/New_York")).toBe("16:00 EDT");
    expect(formatClock(t, "UTC")).toBe("20:00 UTC");
    expect(formatClock(0, "UTC")).toBe("—");
  });
  test("formatShortDate adds the year only for other years", () => {
    const now = Date.UTC(2026, 8, 25);
    expect(formatShortDate(Date.UTC(2026, 8, 17, 12) / 1000, "UTC", now)).toBe("Sep 17");
    expect(formatShortDate(Date.UTC(2025, 8, 17, 12) / 1000, "UTC", now)).toBe("Sep 17, 2025");
  });
  test("formatRelative", () => {
    const now = Date.UTC(2026, 8, 25, 12) ;
    const s = now / 1000;
    expect(formatRelative(s - 10, now)).toBe("just now");
    expect(formatRelative(s - 60, now)).toBe("1 minute ago");
    expect(formatRelative(s - 5 * 3600, now)).toBe("5 hours ago");
    expect(formatRelative(s - 2 * 86400, now)).toBe("2 days ago");
    expect(formatRelative(s - 20 * 86400, now, "UTC")).toBe("Sep 5");
  });
  test("formatDaysUntil rounds", () => {
    expect(formatDaysUntil(46.6)).toBe("In 47 days");
    expect(formatDaysUntil(undefined)).toBe("—");
  });
  test("resolveTimeZone", () => {
    expect(resolveTimeZone(undefined, "AAPL.US")).toBe("UTC");
    expect(resolveTimeZone("exchange", "AAPL.US")).toBe("America/New_York");
    expect(resolveTimeZone("exchange", "FOO.ZZ")).toBeUndefined();
    expect(resolveTimeZone("Europe/London", "AAPL.US")).toBe("Europe/London");
    expect(resolveTimeZone("Not/AZone", "AAPL.US")).toBeUndefined();
  });
});

describe("analyst", () => {
  const base = { rating: null, targetPrice: 250, strongBuy: 20, buy: 10, hold: 8, sell: 1, strongSell: 1 };
  test("consensus from rating", () => {
    expect(consensusOf({ ...base, rating: 4.6 })?.label).toBe("Strong buy");
    expect(consensusOf({ ...base, rating: 3.9 })?.label).toBe("Buy");
    expect(consensusOf({ ...base, rating: 3 })?.label).toBe("Neutral");
    expect(consensusOf({ ...base, rating: 1.2 })?.label).toBe("Strong sell");
  });
  test("consensus from counts when rating missing", () => {
    const c = consensusOf(base)!;
    expect(c.score).toBeCloseTo((100 + 40 + 24 + 2 + 1) / 40, 6);
    expect(c.label).toBe("Buy");
    expect(consensusOf({ ...base, strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBeNull();
    expect(analystTotal(base)).toBe(40);
  });
  test("upsidePct", () => {
    expect(upsidePct(250, 200)).toBeCloseTo(25, 9);
    expect(upsidePct(150, 200)).toBeCloseTo(-25, 9);
    expect(upsidePct(null, 200)).toBeNull();
    expect(upsidePct(100, 0)).toBeNull();
  });
});

describe("misc", () => {
  test("lacksFundamentals", () => {
    expect(lacksFundamentals("EURUSD.FOREX")).toBe(true);
    expect(lacksFundamentals("BTC-USD.CC")).toBe(true);
    expect(lacksFundamentals("GSPC.INDX")).toBe(true);
    expect(lacksFundamentals("AAPL.US")).toBe(false);
    expect(lacksFundamentals("XYZ.US", "Currency")).toBe(true);
  });
  test("sentimentOf", () => {
    expect(sentimentOf(0.5)).toBe("positive");
    expect(sentimentOf(-0.5)).toBe("negative");
    expect(sentimentOf(0.05)).toBe("neutral");
    expect(sentimentOf(undefined)).toBe("neutral");
  });
  test("urls", () => {
    expect(displayHost("https://www.apple.com/")).toBe("apple.com");
    expect(displayHost("nvidia.com")).toBe("nvidia.com");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("www.apple.com")).toBe("https://www.apple.com/");
    expect(safeUrl("http://x.com/a")).toBe("http://x.com/a");
    expect(safeUrl(undefined)).toBeNull();
  });
  test("avatarColor is stable", () => {
    expect(avatarColor("AAPL")).toBe(avatarColor("AAPL"));
    expect(avatarColor("AAPL")).toMatch(/^hsl\(\d+ 55% 45%\)$/);
  });
  test("formatCompact", () => {
    expect(formatCompact(123_456_789_000)).toBe("123.5B");
    expect(formatCompact(undefined)).toBe("—");
  });
  test("sortNews newest first", () => {
    const n = (id: string, t: number) => ({ id, title: id, url: "", publishedAt: t, symbols: [] });
    expect(sortNews([n("a", 1), n("b", 3), n("c", 2)]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});
