import { describe, expect, test } from "bun:test";
import aapl from "./fixtures/aapl.fundamentals.json";
import spy from "./fixtures/spy.fundamentals.json";
import { deriveFundamentals, priceDependent, timingOf } from "./derive";
import { cagr, num, pctChange } from "./util";

const TODAY = "2026-09-25";

describe("util parsing", () => {
  test("num handles EODHD's mixed encodings", () => {
    expect(num("12.5")).toBe(12.5);
    expect(num(" 3 ")).toBe(3);
    expect(num("NA")).toBeNull();
    expect(num("None")).toBeNull();
    expect(num("")).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num({})).toBeNull();
  });
  test("pctChange uses |base| for negative bases, null for zero", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(-1, -2)).toBeCloseTo(50);
    expect(pctChange(1, 0)).toBeNull();
  });
  test("cagr needs positive ends", () => {
    expect(cagr(121, 100, 2)).toBeCloseTo(10);
    expect(cagr(-1, 100, 2)).toBeNull();
  });
});

describe("deriveFundamentals (AAPL fixture)", () => {
  const d = deriveFundamentals(aapl as any, TODAY);
  const c = d.cols;

  test("descriptive", () => {
    expect(d.kind).toBe("stock");
    expect(c.sector).toBe("Technology");
    expect(c.industry).toBe("Consumer Electronics");
    expect(c.country).toBe("USA");
    expect(c.currency).toBe("USD");
    expect(c.ipo_date).toBe("1980-12-12");
    expect(c.employees).toBe(150000);
    expect(c.shares_outstanding).toBe(14594180000);
    expect(c.shares_float).toBe(14569078010);
    expect(c.beta).toBe(1.085);
  });

  test("earnings-based growth", () => {
    expect(c.eps_ttm).toBe(8.7);
    // 2.02 (Q2 2026) vs 1.57 (Q2 2025)
    expect(c.eps_growth_qoq as number).toBeCloseTo((2.02 / 1.57 - 1) * 100, 6);
    // (2.02+2.01+2.84+1.85) vs (1.57+1.65+2.40+0.97)
    expect(c.eps_growth_ttm as number).toBeCloseTo((8.72 / 6.59 - 1) * 100, 6);
    expect(c.eps_surprise_pct).toBeCloseTo(7.4468, 4);
    // newest "0y" trend: 8.8195 vs year-ago 7.46 (a stale 0y snapshot exists in the fixture too)
    expect(c.eps_growth_this_y as number).toBeCloseTo((8.8195 / 7.46 - 1) * 100, 6);
    expect(c.eps_growth_next_y as number).toBeCloseTo((9.5815 / 8.8195 - 1) * 100, 6);
    // no +5y trend → PE / PEG
    expect(c.eps_growth_next_5y as number).toBeCloseTo(38.6115 / 2.706, 6);
    // fiscal-year rows only (Sep): 7.47 (FY25) vs 6.11 (FY22)
    expect(c.eps_growth_past_3y as number).toBeCloseTo(cagr(7.47, 6.11, 3)!, 6);
  });

  test("revenue growth", () => {
    expect(c.sales_growth_qoq as number).toBeCloseTo((109417 / 94036 - 1) * 100, 6);
    expect(c.sales_growth_ttm as number).toBeCloseTo((466823 / 408625 - 1) * 100, 6);
    expect(c.sales_growth_past_3y as number).toBeCloseTo(cagr(416161, 394328, 3)!, 6);
    expect(c.sales_growth_past_5y as number).toBeCloseTo(cagr(416161, 274515, 5)!, 6);
  });

  test("profitability and balance sheet", () => {
    expect(c.roa as number).toBeCloseTo(27.08, 6);
    expect(c.roe as number).toBeCloseTo(148.75, 6);
    expect(c.gross_margin as number).toBeCloseTo((227123003392 / 466822987776) * 100, 6);
    expect(c.oper_margin as number).toBeCloseTo(32.62, 6);
    expect(c.net_margin as number).toBeCloseTo(27.62, 6);
    expect(c.current_ratio as number).toBeCloseTo(149818 / 149326, 6);
    expect(c.quick_ratio as number).toBeCloseTo((149818 - 11092) / 149326, 6);
    expect(c.lt_debt_eq as number).toBeCloseTo(71340 / 107520, 6);
    expect(c.debt_eq as number).toBeCloseTo(84307 / 107520, 6);
    expect(c.roic as number).toBeGreaterThan(30);
    expect(c.roic as number).toBeLessThan(80);
  });

  test("ownership and analysts", () => {
    expect(c.insider_own as number).toBeCloseTo(1.648, 6);
    expect(c.inst_own as number).toBeCloseTo(66.344, 6);
    expect(c.insider_trans).toBeNull(); // AAPL payload has no insider transactions
    expect(typeof c.inst_trans).toBe("number");
    expect(c.short_float as number).toBeCloseTo(0.96, 6);
    expect(c.short_ratio).toBe(2.97);
    expect(c.analyst_recom as number).toBeCloseTo(6 - 4.0417, 6);
    expect(c.target_price as number).toBeCloseTo(328.2221, 6);
    expect(c.payout_ratio as number).toBeCloseTo(12.16, 6);
    expect(c.ev_ebitda).toBe(29.413);
    expect(c.peg).toBe(2.706);
  });

  test("earnings dates from history", () => {
    expect(d.earnings.next).toEqual({ date: "2026-10-29", timing: "amc" });
    expect(d.earnings.last).toBe("2026-07-30");
  });

  test("price-dependent ratios", () => {
    const p = priceDependent(d.inputs, 335.92);
    expect(p.market_cap as number).toBeCloseTo(335.92 * 14594180000, 0);
    expect(p.pe as number).toBeCloseTo(335.92 / 8.7, 6);
    expect(p.forward_pe as number).toBeCloseTo(335.92 / 9.5815, 6);
    expect(p.ps as number).toBeCloseTo((335.92 * 14594180000) / 466822987776, 6);
    expect(p.pb as number).toBeCloseTo(335.92 / 7.36, 6);
    expect(p.pfcf as number).toBeCloseTo((335.92 * 14594180000) / 136683e6, 6);
    expect(p.pcash as number).toBeCloseTo((335.92 * 14594180000) / 62399e6, 6);
    expect(p.dividend_yield as number).toBeCloseTo((1.08 / 335.92) * 100, 6);
    expect(p.target_upside_pct as number).toBeCloseTo((328.2221 / 335.92 - 1) * 100, 6);
    // without a price the fetch-time values are used
    const q = priceDependent(d.inputs, null);
    expect(q.market_cap).toBe(4902477103104);
    expect(q.pe).toBeNull();
    expect(q.forward_pe).toBe(35.2113);
  });

  test("survives JSON round-trip (stored as JSON)", () => {
    expect(JSON.parse(JSON.stringify(d)).cols.sector).toBe("Technology");
  });
});

describe("deriveFundamentals (SPY fixture)", () => {
  const d = deriveFundamentals(spy as any, TODAY);
  test("ETF columns", () => {
    expect(d.kind).toBe("etf");
    expect(d.cols.etf_expense_ratio as number).toBeCloseTo(0.095, 6);
    expect(d.cols.etf_aum).toBe(803326731840);
    expect(d.cols.etf_sponsor).toBe("State Street Investment Management");
    expect(d.cols.etf_category).toBe("Large Blend");
    expect(d.cols.etf_holdings_count).toBe(50);
    expect(d.cols.ipo_date).toBe("1993-01-22");
    expect(d.cols.pe ?? null).toBeNull();
    expect(priceDependent(d.inputs, 767.18).dividend_yield as number).toBeCloseTo(0.98, 6);
    expect(priceDependent(d.inputs, 767.18).market_cap).toBeNull();
  });
});

describe("deriveFundamentals (messy payloads)", () => {
  test("empty / garbage input yields nulls, never throws", () => {
    for (const raw of [{}, { General: null }, { Highlights: "NA", Earnings: { History: "NA" } }, { Financials: { Income_Statement: { quarterly: [] } } }]) {
      const d = deriveFundamentals(raw as any, TODAY);
      expect(d.cols.pe ?? null).toBeNull();
      expect(d.cols.sales_growth_ttm).toBeNull();
      expect(priceDependent(d.inputs, 10).market_cap).toBeNull();
    }
  });

  test("string numbers, NA and insider transactions", () => {
    const raw = {
      General: { Type: "Common Stock", FullTimeEmployees: "NA", IPODate: "0000-00-00" },
      Highlights: { EarningsShare: "-1.5", ProfitMargin: "NA", ReturnOnEquityTTM: "0.1" },
      SharesStats: { SharesOutstanding: "1000000", PercentInsiders: "10" },
      AnalystRatings: { Rating: "NA" },
      InsiderTransactions: {
        "0": { transactionDate: "2026-08-01", transactionCode: "P", transactionAmount: "5000", transactionAcquiredDisposed: "A" },
        "1": { transactionDate: "2026-07-01", transactionCode: "S", transactionAmount: 2000, transactionAcquiredDisposed: "D" },
        "2": { transactionDate: "2025-01-01", transactionCode: "S", transactionAmount: 90000, transactionAcquiredDisposed: "D" }, // too old
        "3": { transactionDate: "2026-08-02", transactionCode: "A", transactionAmount: 50000, transactionAcquiredDisposed: "A" }, // grant, ignored
      },
    };
    const d = deriveFundamentals(raw as any, TODAY);
    expect(d.cols.employees).toBeNull();
    expect(d.cols.ipo_date).toBeNull();
    expect(d.cols.eps_ttm).toBe(-1.5);
    expect(d.cols.net_margin).toBeNull();
    expect(d.cols.roe as number).toBeCloseTo(10);
    expect(d.cols.analyst_recom).toBeNull();
    // net +3000 shares vs 100k insider shares
    expect(d.cols.insider_trans as number).toBeCloseTo(3);
    const p = priceDependent(d.inputs, 20);
    expect(p.pe).toBeNull(); // negative EPS → no P/E
    expect(p.market_cap).toBe(20_000_000);
  });

  test("timing parser", () => {
    expect(timingOf("BeforeMarket")).toBe("bmo");
    expect(timingOf("AfterMarket")).toBe("amc");
    expect(timingOf(null)).toBeNull();
  });
});

describe("deriveFundamentals (review fixes)", () => {
  test("loss-maker with ProfitMargin 0 gets the statement-based negative margin", () => {
    const raw = structuredClone(aapl as any);
    raw.Highlights.ProfitMargin = 0;
    raw.Highlights.OperatingMarginTTM = "0";
    for (const q of Object.values<any>(raw.Financials.Income_Statement.quarterly)) {
      q.netIncome = String(-Math.abs(Number(q.netIncome)));
      q.operatingIncome = String(-Math.abs(Number(q.operatingIncome)));
    }
    const c = deriveFundamentals(raw, TODAY).cols;
    expect(c.net_margin as number).toBeLessThan(0);
    expect(c.oper_margin as number).toBeLessThan(0);
    // no statements: a bare 0 stays unknown instead of "break-even"
    const bare = deriveFundamentals({ General: { Type: "Common Stock" }, Highlights: { ProfitMargin: 0 } }, TODAY).cols;
    expect(bare.net_margin).toBeNull();
  });

  test("ADR: country from the address, no FX-mixed ratios", () => {
    const raw = {
      General: { Type: "Common Stock", CurrencyCode: "USD", CountryName: "USA", CountryISO: "US", HomeCategory: "ADR", AddressData: { Country: "China" } },
      Highlights: { MarketCapitalization: 2.75e11, RevenueTTM: 1.045e12, EPSEstimateNextYear: 50.12, DilutedEpsTTM: 4.43, BookValue: 66.97, DividendShare: 7.242 },
      Valuation: { ForwardPE: 17.9, PriceSalesTTM: 0.26, PriceBookMRQ: 1.76 },
      SharesStats: { SharesOutstanding: 2.4e9 },
      SplitsDividends: { ForwardAnnualDividendRate: 1.05 },
      Financials: { Income_Statement: { currency_symbol: "CNY", quarterly: {} } },
    };
    const d = deriveFundamentals(raw, TODAY);
    expect(d.cols.country).toBe("China");
    const r = priceDependent(JSON.parse(JSON.stringify(d.inputs)), 110);
    expect(r.ps).toBeNull();
    expect(r.forward_pe).toBe(17.9);
    expect(r.pb).toBe(1.76);
    expect(r.pe as number).toBeCloseTo(110 / 4.43, 6);
    expect(r.dividend_yield as number).toBeCloseTo((1.05 / 110) * 100, 6);
    // same payload reported in USD: ratios computed from the inputs
    raw.Financials.Income_Statement.currency_symbol = "USD";
    const u = priceDependent(deriveFundamentals(raw, TODAY).inputs, 110);
    expect(u.ps as number).toBeCloseTo((110 * 2.4e9) / 1.045e12, 6);
  });

  test("domestic issuers keep CountryName", () => {
    expect(deriveFundamentals({ General: { CountryName: "USA", AddressData: { Country: "United States" } } }, TODAY).cols.country).toBe("USA");
  });
});
