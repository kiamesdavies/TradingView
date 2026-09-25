import { describe, expect, test } from "bun:test";
import { priceDependent, type FundInputs } from "./derive";
import { fxSymbols, isMinorUnit, majorOf, parseFxQuotes, quoteCurrency, rateToUsd, toUsd } from "./fx";

describe("FX / pence normalisation", () => {
  test("minor units", () => {
    expect(majorOf("GBX")).toEqual({ currency: "GBP", factor: 0.01 });
    expect(majorOf("GBp")).toEqual({ currency: "GBP", factor: 0.01 });
    expect(majorOf("ZAC")).toEqual({ currency: "ZAR", factor: 0.01 });
    expect(majorOf("sek")).toEqual({ currency: "SEK", factor: 1 });
    expect(isMinorUnit("GBX")).toBe(true);
    expect(isMinorUnit("GBP")).toBe(false);
  });

  test("forex symbols needed", () => {
    expect(fxSymbols(["USD", "GBX", "GBP", "SEK", null, "EUR", "SEK", "N/A"])).toEqual(["EURUSD.FOREX", "GBPUSD.FOREX", "SEKUSD.FOREX"]);
    expect(fxSymbols(["USD"])).toEqual([]);
  });

  test("real-time payloads (array or single object)", () => {
    const r = parseFxQuotes([
      { code: "GBPUSD.FOREX", close: 1.3246, previousClose: 1.32 },
      { code: "SEKUSD.FOREX", close: "NA", previousClose: 0.1008 },
      { code: "JPYUSD.FOREX", close: 0, previousClose: 0 },
      { code: "AAPL.US", close: 200 },
    ]);
    expect([...r]).toEqual([["GBP", 1.3246], ["SEK", 0.1008]]);
    expect([...parseFxQuotes({ code: "EURUSD.FOREX", close: 1.17 })]).toEqual([["EUR", 1.17]]);
    expect(parseFxQuotes("garbage").size).toBe(0);
  });

  test("rate per quote unit", () => {
    const rates = new Map([["GBP", 1.3246], ["SEK", 0.101]]);
    expect(rateToUsd("USD", rates)).toBe(1);
    expect(rateToUsd("GBX", rates)).toBeCloseTo(0.013246, 9);
    expect(rateToUsd("GBP", rates)).toBe(1.3246);
    expect(rateToUsd("EUR", rates)).toBeNull();
    expect(rateToUsd(null, rates)).toBeNull();
    expect(toUsd(108.9, rateToUsd("GBX", rates))).toBeCloseTo(1.4425, 4); // LLOY 108.9p ≈ $1.44
    expect(toUsd(null, 1)).toBeNull();
    expect(toUsd(5, null)).toBeNull();
  });

  test("quote currency: symbol list, then fundamentals, then market", () => {
    expect(quoteCurrency("GBX", "GBP", "GBX")).toBe("GBX");
    expect(quoteCurrency(null, "GBp", "GBX")).toBe("GBp");
    expect(quoteCurrency("", "sek", "SEK")).toBe("SEK");
    expect(quoteCurrency(null, "NA", "CAD")).toBe("CAD");
  });

  test("pence-quoted stock: ratios use GBP, target in pence (LLOY-like)", () => {
    const inp: FundInputs = {
      sharesOutstanding: 57_676_841_863, marketCapFallback: 61.7e9, epsTtm: 0.08, epsNextY: null, forwardPeFallback: null,
      revenueTtm: null, psFallback: null, bookPerShare: 0.714, pbFallback: null, cashSti: null, fcfTtm: null,
      divRate: 0.04, divYieldFallback: null, targetPrice: 121.316,
    };
    const r = priceDependent(inp, 108.9, majorOf("GBX").factor);
    expect(r.market_cap).toBeCloseTo(1.089 * 57_676_841_863, -3); // GBP, not pence
    expect(r.pe).toBeCloseTo(1.089 / 0.08, 9);
    expect(r.pb).toBeCloseTo(1.089 / 0.714, 9);
    expect(r.dividend_yield).toBeCloseTo((0.04 / 1.089) * 100, 9);
    expect(r.target_upside_pct).toBeCloseTo((121.316 / 108.9 - 1) * 100, 9);
    // default factor keeps v2 behaviour
    expect(priceDependent(inp, 108.9).pe).toBeCloseTo(108.9 / 0.08, 9);
  });
});
