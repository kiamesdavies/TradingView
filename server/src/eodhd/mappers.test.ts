import { describe, expect, test } from "bun:test";
import { assetClassOf, dateToUnix, mapEod, mapIntraday, mapRealtime, mapSearch, mapUser, monthStart, weekStart } from "./mappers";

// Fixtures trimmed from real EODHD responses (AAPL 4:1 split on 2020-08-31).
const EOD_SPLIT = [
  { date: "2020-08-28", open: 504.05, high: 505.77, low: 498.31, close: 499.23, adjusted_close: 120.9557, volume: 187630000 },
  { date: "2020-08-31", open: 127.58, high: 131, low: 126, close: 129.04, adjusted_close: 125.0575, volume: 225702700 },
  { date: "2020-09-01", open: null, high: null, low: null, close: null, adjusted_close: null, volume: null },
];

describe("mapEod", () => {
  test("scales OHLC by adjusted_close/close and volume inversely; drops null rows", () => {
    const bars = mapEod(EOD_SPLIT);
    expect(bars).toHaveLength(2);
    const [pre, post] = bars;
    expect(pre.time).toBe(Date.UTC(2020, 7, 28) / 1000);
    expect(pre.close).toBeCloseTo(120.9557, 6);
    const r = 120.9557 / 499.23;
    expect(pre.open).toBeCloseTo(504.05 * r, 6);
    expect(pre.high).toBeCloseTo(505.77 * r, 6);
    expect(pre.low).toBeCloseTo(498.31 * r, 6);
    expect(pre.volume).toBe(Math.round(187630000 / r));
    // no split cliff: pre-split close is in the same ballpark as post-split open
    expect(Math.abs(post.open - pre.close) / pre.close).toBeLessThan(0.05);
    expect(post.close).toBeCloseTo(125.0575, 6);
  });

  test("ratio falls back to 1 when adjusted_close missing or NA", () => {
    const [b] = mapEod([{ date: "2024-01-02", open: 1, high: 2, low: 0.5, close: 1.5, adjusted_close: "NA", volume: 10 }]);
    expect(b).toEqual({ time: 1704153600, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  });

  test("weekly and monthly bars are re-stamped to Monday / 1st of month", () => {
    const row = { open: 1, high: 1, low: 1, close: 1, adjusted_close: 1, volume: 1 };
    const w = mapEod([{ ...row, date: "2024-01-16" }], "w"); // Tuesday after MLK day
    expect(w[0].time).toBe(Date.UTC(2024, 0, 15) / 1000);
    const m = mapEod([{ ...row, date: "2024-04-01" }, { ...row, date: "2024-02-01" }], "m");
    expect(m.map((b) => b.time)).toEqual([Date.UTC(2024, 1, 1) / 1000, Date.UTC(2024, 3, 1) / 1000]);
  });

  test("non-array input yields []", () => {
    expect(mapEod({ error: "x" })).toEqual([]);
    expect(mapEod(null)).toEqual([]);
  });
});

describe("date helpers", () => {
  test("dateToUnix / weekStart / monthStart", () => {
    expect(dateToUnix("2024-01-02")).toBe(1704153600);
    expect(Number.isNaN(dateToUnix("2024/01/02"))).toBe(true);
    expect(weekStart(Date.UTC(2024, 0, 7, 23) / 1000)).toBe(Date.UTC(2024, 0, 1) / 1000); // Sunday → Monday before
    expect(weekStart(Date.UTC(2024, 0, 8) / 1000)).toBe(Date.UTC(2024, 0, 8) / 1000);
    expect(monthStart(Date.UTC(2024, 1, 29, 12) / 1000)).toBe(Date.UTC(2024, 1, 1) / 1000);
  });
});

describe("mapIntraday", () => {
  test("uses timestamp, drops rows with nulls, sorts and dedupes", () => {
    const raw = [
      { timestamp: 1790084100, gmtoffset: 0, datetime: "2026-09-22 13:35:00", open: 342.73, high: 343.2, low: 341.16, close: 341.36, volume: 764835 },
      { timestamp: 1790083800, gmtoffset: 0, datetime: "2026-09-22 13:30:00", open: 340.33, high: 345.34, low: 339.8, close: 342.61, volume: 3319557 },
      { timestamp: 1790084400, gmtoffset: 0, datetime: "2026-09-22 13:40:00", open: null, high: null, low: null, close: null, volume: null },
      { timestamp: 1790084100, gmtoffset: 0, datetime: "2026-09-22 13:35:00", open: 342.73, high: 343.2, low: 341.16, close: 341.4, volume: null },
    ];
    expect(mapIntraday(raw)).toEqual([
      { time: 1790083800, open: 340.33, high: 345.34, low: 339.8, close: 342.61, volume: 3319557 },
      { time: 1790084100, open: 342.73, high: 343.2, low: 341.16, close: 341.4, volume: 0 },
    ]);
  });
});

describe("mapSearch", () => {
  const raw = [
    { Code: "AAPL", Exchange: "US", Name: "Apple Inc.", Type: "Common Stock", Country: "USA", Currency: "USD", ISIN: "US0378331005", previousClose: 335.92 },
    { Code: "AAPLX-USD", Exchange: "CC", Name: "Apple tokenized stock", Type: "Currency", Country: "Unknown", Currency: "USD", ISIN: null },
    { Code: "AAPL", Exchange: "BA", Name: "Apple Inc DRC", Type: "Common Stock", Country: "Argentina", Currency: "ARS" },
    { Code: "EURUSD", Exchange: "FOREX", Name: "EUR/USD", Type: "Currency", Country: "Unknown", Currency: "USD" },
    { Code: "SPY", Exchange: "US", Name: "SPDR S&P 500", Type: "ETF", Country: "USA", Currency: "USD" },
    { Code: "GSPC", Exchange: "INDX", Name: "S&P 500", Type: "INDEX", Country: "USA", Currency: "USD" },
    { Code: "VFIAX", Exchange: "US", Name: "Vanguard 500", Type: "FUND", Country: "USA", Currency: "USD" },
    { Code: "AAPL", Exchange: "US", Name: "dup", Type: "Common Stock" },
    { Code: "", Exchange: "US" },
  ];

  test("maps to SymbolInfo with symbol, assetClass and streamable", () => {
    const out = mapSearch(raw);
    expect(out.map((s) => s.symbol)).toEqual(["AAPL.US", "AAPLX-USD.CC", "AAPL.BA", "EURUSD.FOREX", "SPY.US", "GSPC.INDX", "VFIAX.US"]);
    expect(out[0]).toEqual({
      symbol: "AAPL.US", code: "AAPL", exchange: "US", name: "Apple Inc.", type: "Common Stock",
      country: "USA", currency: "USD", assetClass: "us_stock", streamable: true,
    });
    expect(out[1]).toMatchObject({ assetClass: "crypto", streamable: true });
    expect(out[1].country).toBeUndefined();
    expect(out[2]).toMatchObject({ assetClass: "stock", streamable: false });
    expect(out[3]).toMatchObject({ assetClass: "forex", streamable: true });
    expect(out[4]).toMatchObject({ assetClass: "etf", streamable: true });
    expect(out[5]).toMatchObject({ assetClass: "index", streamable: false });
    expect(out[6]).toMatchObject({ assetClass: "other" });
  });

  test("assetClassOf edge cases", () => {
    expect(assetClassOf("LSE", "Preferred Stock")).toBe("stock");
    expect(assetClassOf("cc", "Currency")).toBe("crypto");
  });
});

describe("mapRealtime", () => {
  test("array response with NA values", () => {
    const raw = [
      { code: "AAPL.US", timestamp: 1790281740, gmtoffset: 0, open: 336.72, high: 338.91, low: 334.3, close: 335.92, volume: 24246647, previousClose: 337.02, change: -1.1, change_p: -0.3264 },
      { code: "EURUSD.FOREX", timestamp: 1790329980, open: 1.138, high: 1.139, low: 1.137, close: 1.1392, volume: 0, previousClose: 1.1382, change: "NA", change_p: "NA" },
      { code: "DEAD.US", timestamp: "NA", open: "NA", high: "NA", low: "NA", close: "NA", volume: "NA", previousClose: "NA", change: "NA", change_p: "NA" },
    ];
    const out = mapRealtime(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ symbol: "AAPL.US", price: 335.92, change: -1.1, changePct: -0.3264, volume: 24246647, prevClose: 337.02, time: 1790281740 });
    expect(out[1].change).toBeCloseTo(0.001, 10);
    expect(out[1].changePct).toBeCloseTo((0.001 / 1.1382) * 100, 8);
  });

  test("single-object response", () => {
    const out = mapRealtime({ code: "BTC-USD.CC", timestamp: 1790330040, close: 84603.2, volume: "NA", previousClose: 84379.06, change: 224.17, change_p: 0.2657 });
    expect(out).toEqual([{ symbol: "BTC-USD.CC", price: 84603.2, change: 224.17, changePct: 0.2657, volume: 0, prevClose: 84379.06, time: 1790330040 }]);
  });
});

describe("mapUser", () => {
  test("keeps only known fields", () => {
    expect(mapUser({ name: "J", email: "j@x", subscriptionType: "monthly", apiRequests: 89, dailyRateLimit: 100000, inviteToken: "secret" }))
      .toEqual({ name: "J", email: "j@x", subscriptionType: "monthly", apiRequests: 89, dailyRateLimit: 100000 });
    expect(mapUser("Unauthenticated")).toEqual({});
  });
});
