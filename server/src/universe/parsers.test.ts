import { describe, expect, test } from "bun:test";
import {
  dominantDate,
  earningsBySymbol,
  filterSymbolList,
  parseActions,
  parseBulk,
  parseEarningsCalendar,
  parseIndexComponents,
  parseNews,
} from "./parsers";
import { parseEod } from "./jobs";

describe("symbol list", () => {
  test("keeps listed common stocks and ETFs only", () => {
    const rows = filterSymbolList([
      { Code: "AAPL", Name: "Apple Inc", Exchange: "NASDAQ", Type: "Common Stock", Isin: "US0378331005" },
      { Code: "BRK-B", Name: "Berkshire", Exchange: "NYSE", Type: "Common Stock", Isin: null },
      { Code: "XYZ", Name: "Old Amex", Exchange: "NYSE MKT", Type: "Common Stock" },
      { Code: "SPY", Name: "SPDR S&P 500", Exchange: "NYSE ARCA", Type: "ETF" },
      { Code: "IBIT", Name: "iShares Bitcoin", Exchange: "NASDAQ", Type: "ETF" },
      { Code: "OTCX", Name: "Pink", Exchange: "PINK", Type: "Common Stock" },
      { Code: "PFD", Name: "Preferred", Exchange: "NYSE", Type: "Preferred Stock" },
      { Code: "VFIAX", Name: "Mutual", Exchange: "NMFQS", Type: "FUND" },
      { Code: "ARCACS", Name: "Stock on Arca", Exchange: "NYSE ARCA", Type: "Common Stock" },
      { Code: "^GSPC", Name: "Index", Exchange: "US", Type: "INDEX" },
    ]);
    expect(rows.map((r) => `${r.symbol}:${r.kind}:${r.exchange}`)).toEqual([
      "AAPL.US:stock:NASDAQ",
      "BRK-B.US:stock:NYSE",
      "XYZ.US:stock:AMEX",
      "SPY.US:etf:NYSE ARCA",
      "IBIT.US:etf:NASDAQ",
    ]);
    expect(rows[0]!.isin).toBe("US0378331005");
  });
});

describe("bulk", () => {
  test("parses plain and extended rows", () => {
    const rows = parseBulk([
      { code: "AAPL", date: "2026-09-24", open: 336.72, high: 338.91, low: 334.3, close: 335.92, adjusted_close: 335.92, volume: 24686400, MarketCapitalization: 4902477103104, Beta: 1.085, hi_250d: 339.787, lo_250d: 244.367, avgvol_50d: 47270123.76 },
      { code: "NBIZ", date: "2026-09-21", open: 5.4, high: 5.5, low: 5.3, close: 5.44, adjusted_close: 21.76, volume: "1000" },
      { code: "BAD", date: "2026-09-24", close: 0 },
      { code: "NA", date: "2026-09-24", close: "NA" },
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ code: "AAPL", close: 335.92, marketCap: 4902477103104, hi250: 339.787, avgVol50: 47270123.76 });
    expect(rows[1]).toMatchObject({ code: "NBIZ", adjClose: 21.76, volume: 1000, marketCap: null });
    expect(dominantDate(rows.concat(rows.slice(0, 1)))).toBe("2026-09-24");
    expect(parseBulk([])).toEqual([]);
    expect(parseBulk({ error: "x" })).toEqual([]);
  });

  test("corporate actions and /eod rows", () => {
    expect(parseActions([{ code: "AXTX", exchange: "US", date: "2026-09-22", split: "1.000000/4.000000" }], "split")).toEqual([
      { code: "AXTX", date: "2026-09-22", kind: "split" },
    ]);
    expect(parseEod([{ date: "2026-09-21", open: 1, high: 2, low: 0.5, close: 1.5, adjusted_close: 3, volume: 10 }, { date: "x", close: 1 }])).toEqual([
      { date: "2026-09-21", open: 1, high: 2, low: 0.5, close: 1.5, adjClose: 3, volume: 10 },
    ]);
  });
});

describe("earnings calendar", () => {
  const raw = {
    type: "Earnings",
    earnings: [
      { code: "AAPL.US", report_date: "2026-10-29", date: "2026-09-30", before_after_market: "AfterMarket", actual: null },
      { code: "COST.US", report_date: "2026-09-24", date: "2026-08-31", before_after_market: "AfterMarket", actual: 5.87 },
      { code: "FDX.US", report_date: "2026-09-25", date: "2026-08-31", before_after_market: "BeforeMarket", actual: 4.1 },
      { code: "NKE.US", report_date: "2026-09-25", date: "2026-08-31", before_after_market: "AfterMarket", actual: null },
      { code: "NVDA.US", report_date: "2026-11-18", date: "2026-10-31", before_after_market: null, actual: null },
      { code: "EFF.V", report_date: "2026-09-18", date: "2026-07-31", before_after_market: "AfterMarket" },
    ],
  };
  test("next/last per symbol", () => {
    const m = earningsBySymbol(parseEarningsCalendar(raw), "2026-09-25");
    expect(m.get("AAPL.US")).toEqual({ next: { date: "2026-10-29", timing: "amc" }, last: null });
    expect(m.get("COST.US")).toEqual({ next: null, last: "2026-09-24" });
    expect(m.get("FDX.US")).toEqual({ next: null, last: "2026-09-25" }); // reported this morning
    expect(m.get("NKE.US")).toEqual({ next: { date: "2026-09-25", timing: "amc" }, last: null }); // tonight
    expect(m.get("NVDA.US")!.next).toEqual({ date: "2026-11-18", timing: null });
    expect(m.has("EFF.V")).toBe(false);
  });
});

describe("index components and news", () => {
  test("components", () => {
    const syms = parseIndexComponents({ "0": { Code: "AIZ", Exchange: "US" }, "1": { Code: "BRK-B", Exchange: "US" }, "2": { Code: "BF.B", Exchange: "US" } });
    expect(syms).toEqual(["AIZ.US", "BRK-B.US", "BF-B.US"]);
    expect(parseIndexComponents({ Components: { "0": { Code: "MSFT", Exchange: "US" } } })).toEqual(["MSFT.US"]);
  });

  test("news → newest article per US symbol", () => {
    const r = parseNews([
      { date: "2026-09-25T12:16:38+00:00", symbols: ["AMZN.US", "ORC.HM", "MSFT.US"] },
      { date: "2026-09-25T10:00:00+00:00", symbols: ["MSFT.US"] },
      { date: "garbage", symbols: ["X.US"] },
    ]);
    expect(r.count).toBe(2);
    expect(r.latest.get("MSFT.US")).toBe(Date.parse("2026-09-25T12:16:38Z") / 1000);
    expect(r.latest.has("ORC.HM")).toBe(false);
    expect(r.oldest).toBe(Date.parse("2026-09-25T10:00:00Z") / 1000);
  });
});
