import { describe, expect, test } from "bun:test";
import { addDays } from "./util";
import { candlestick, computeTechnicals, crossState, smaAt, wilderAtr, wilderRsi, type SymbolBars } from "./technicals";

/** Weekday dates ending at `end`. */
function dates(n: number, end = "2026-09-24"): string[] {
  const out: string[] = [];
  let d = end;
  while (out.length < n) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

function barsFromCloses(closes: number[], opts: { range?: number; volume?: number; end?: string } = {}): SymbolBars {
  const r = opts.range ?? 1;
  return {
    date: dates(closes.length, opts.end),
    open: closes.map((c, i) => (i ? closes[i - 1]! : c)),
    high: closes.map((c, i) => Math.max(c, i ? closes[i - 1]! : c) + r / 2),
    low: closes.map((c, i) => Math.min(c, i ? closes[i - 1]! : c) - r / 2),
    close: closes,
    adjClose: closes,
    volume: closes.map(() => opts.volume ?? 1000),
  };
}

/** Straightforward reference Wilder RSI (different code path: explicit arrays). */
function refRsi(c: number[], p = 14): number {
  const g: number[] = [], l: number[] = [];
  for (let i = 1; i < c.length; i++) { const d = c[i]! - c[i - 1]!; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  let ag = g.slice(0, p).reduce((a, b) => a + b) / p, al = l.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < g.length; i++) { ag = (ag * (p - 1) + g[i]!) / p; al = (al * (p - 1) + l[i]!) / p; }
  return 100 - 100 / (1 + ag / al);
}

describe("indicator primitives", () => {
  test("sma", () => {
    expect(smaAt([1, 2, 3, 4, 5], 5, 4)).toBe(3);
    expect(smaAt([1, 2, 3, 4, 5], 2, 4)).toBe(4.5);
    expect(smaAt([1, 2, 3], 5, 2)).toBeNull();
  });

  test("Wilder RSI matches the reference and edge cases", () => {
    const c = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.1);
    expect(wilderRsi(c)!).toBeCloseTo(refRsi(c), 9);
    expect(wilderRsi(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100);
    expect(wilderRsi(Array.from({ length: 30 }, () => 5))).toBe(50);
    expect(wilderRsi([1, 2, 3])).toBeNull();
  });

  test("Wilder RSI on the classic 14-period example is in the expected band", () => {
    // Wilder/StockCharts sample closes; RSI(14) at the 15th close ≈ 70.53
    const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(wilderRsi(c)!).toBeCloseTo(70.5, 0);
  });

  test("Wilder ATR: constant true range → that range", () => {
    const n = 40;
    const h = Array.from({ length: n }, () => 11), l = Array.from({ length: n }, () => 9), c = Array.from({ length: n }, () => 10);
    expect(wilderAtr(h, l, c)).toBeCloseTo(2, 10);
    expect(wilderAtr(h.slice(0, 10), l.slice(0, 10), c.slice(0, 10))).toBeNull();
  });

  test("ATR uses gaps (true range)", () => {
    // closes jump by 5 each day with a 1-point intraday range → TR = 5.5 (|high - prev close|)
    const c = Array.from({ length: 30 }, (_, i) => 100 + 5 * i);
    const h = c.map((x) => x + 0.5), l = c.map((x) => x - 0.5);
    expect(wilderAtr(h, l, c)).toBeCloseTo(5.5, 10);
  });

  test("cross state", () => {
    expect(crossState(9, 10, 11, 10)).toBe("cross_above");
    expect(crossState(11, 10, 9, 10)).toBe("cross_below");
    expect(crossState(11, 10, 12, 10)).toBe("above");
    expect(crossState(8, 10, 9, 10)).toBe("below");
    expect(crossState(null, null, 9, 10)).toBe("below");
    expect(crossState(9, 10, 11, null)).toBeNull();
  });
});

describe("candlestick patterns", () => {
  const P = (o: number, h: number, l: number, c: number) => ({ o, h, l, c });
  test("each pattern", () => {
    expect(candlestick(P(10, 11, 9, 10.05), null, 0)).toBe("doji");
    expect(candlestick(P(10, 10.55, 8.5, 10.5), null, -1)).toBe("hammer");
    expect(candlestick(P(10, 10.55, 8.5, 10.5), null, 1)).toBe("hanging_man");
    expect(candlestick(P(10, 10.55, 8.5, 10.5), null, 0)).toBeNull();
    expect(candlestick(P(10, 12.5, 9.95, 10.5), null, -1)).toBe("inverted_hammer");
    expect(candlestick(P(10, 12.5, 9.95, 10.5), null, 1)).toBe("shooting_star");
    expect(candlestick(P(10, 12.02, 9.99, 12), null, 0)).toBe("marubozu_white");
    expect(candlestick(P(12, 12.01, 9.98, 10), null, 0)).toBe("marubozu_black");
    expect(candlestick(P(9.5, 11.5, 9.2, 11.2), P(11, 11.1, 9.8, 10), 0)).toBe("bullish_engulfing");
    expect(candlestick(P(11.2, 11.5, 9.2, 9.5), P(10, 11.1, 9.8, 11), 0)).toBe("bearish_engulfing");
    expect(candlestick(P(10, 11, 9, 10.25), null, 0)).toBe("spinning_top");
    expect(candlestick(P(10, 11, 9.9, 10.9), null, 0)).toBeNull(); // plain up day
    expect(candlestick(P(10, 10, 10, 10), null, 0)).toBeNull(); // no range
  });
});

describe("computeTechnicals", () => {
  test("empty history → all null", () => {
    const t = computeTechnicals({ date: [], open: [], high: [], low: [], close: [], adjClose: [], volume: [] });
    expect(t.price).toBeNull();
    expect(t.rsi14).toBeNull();
  });

  test("steady uptrend", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 * 1.001 ** i);
    const t = computeTechnicals(barsFromCloses(closes));
    const last = closes[299]!;
    expect(t.price).toBe(last);
    expect(t.change_pct as number).toBeCloseTo(0.1, 6);
    expect(t.perf_1w as number).toBeCloseTo((1.001 ** 5 - 1) * 100, 6);
    expect(t.perf_1y as number).toBeCloseTo((1.001 ** 252 - 1) * 100, 6);
    expect(t.sma20 as number).toBeCloseTo(closes.slice(-20).reduce((a, b) => a + b) / 20, 8);
    expect(t.sma200_pct as number).toBeGreaterThan(0);
    expect(t.sma50_200_cross).toBe("above");
    expect(t.sma20_cross).toBe("above");
    expect(t.rsi14).toBe(100);
    expect(t.new_high).toBe("52w");
    expect(t.new_low).toBeNull();
    expect(t.high_52w_pct as number).toBeLessThanOrEqual(0);
    expect(t.low_52w_pct as number).toBeGreaterThan(0);
    expect(t.avg_volume).toBe(1000);
    expect(t.rel_volume).toBe(1);
    expect(t.dollar_volume as number).toBeCloseTo(last * 1000, 6);
    expect(t.price_date).toBe("2026-09-24");
    // YTD: base is the last bar of 2025
    const b = barsFromCloses(closes);
    const idx = b.date.findLastIndex((d) => d < "2026-01-01");
    expect(t.perf_ytd as number).toBeCloseTo((last / closes[idx]! - 1) * 100, 6);
  });

  test("gap, change from open, volume spike", () => {
    const closes = Array.from({ length: 80 }, () => 50);
    const b = barsFromCloses(closes);
    const n = closes.length - 1;
    b.close[n - 1] = 49; b.adjClose[n - 1] = 49; // yesterday just under SMA20
    b.open[n] = 52; b.high[n] = 56; b.low[n] = 51.5; b.close[n] = 55; b.adjClose[n] = 55; b.volume[n] = 5000;
    const t = computeTechnicals(b);
    expect(t.gap_pct as number).toBeCloseTo((52 / 49 - 1) * 100, 6);
    expect(t.change_from_open_pct as number).toBeCloseTo((55 / 52 - 1) * 100, 6);
    expect(t.change_pct as number).toBeCloseTo((55 / 49 - 1) * 100, 6);
    expect(t.sma20_cross).toBe("cross_above");
    expect(t.rel_volume as number).toBeCloseTo(5000 / ((62 * 1000 + 5000) / 63), 6);
    expect(t.new_high).toBe("50d"); // 80 bars < 252 and not a recent listing → no 52w window
  });

  test("split-adjusted history: returns and levels are continuous", () => {
    // 2:1 split 10 sessions ago: raw closes halve, EODHD adj_close is restated (historical halves)
    const n = 260;
    const trueP = Array.from({ length: n }, (_, i) => 50 + i * 0.1); // post-split basis
    const splitAt = n - 10;
    const raw = trueP.map((p, i) => (i < splitAt ? p * 2 : p));
    const b = barsFromCloses(raw);
    b.adjClose = trueP.slice();
    // raw OHLC before the split sits on the pre-split basis
    for (let i = 0; i < n; i++) {
      const f = i < splitAt ? 2 : 1;
      b.open[i] = (i ? trueP[i - 1]! : trueP[i]!) * f;
      b.high[i] = Math.max(b.open[i]!, raw[i]!) + 0.5 * f;
      b.low[i] = Math.min(b.open[i]!, raw[i]!) - 0.5 * f;
      b.volume[i] = i < splitAt ? 500 : 1000;
    }
    const t = computeTechnicals(b);
    expect(t.perf_1m as number).toBeCloseTo((trueP[n - 1]! / trueP[n - 22]! - 1) * 100, 6);
    expect(t.sma50 as number).toBeCloseTo(trueP.slice(-50).reduce((a, c) => a + c) / 50, 6);
    expect(t.high_52w_pct as number).toBeCloseTo((trueP[n - 1]! / (trueP[n - 1]! + 0.5) - 1) * 100, 6);
    expect(t.avg_volume as number).toBeCloseTo(1000, 6); // pre-split volume doubled
    expect(t.atr14 as number).toBeLessThan(2);
  });

  test("stale adjusted basis (last row adj != close) is rescaled to today's price", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 10 + i);
    const b = barsFromCloses(closes);
    b.adjClose = closes.map((c) => c * 0.98); // uniform dividend factor
    const t = computeTechnicals(b);
    expect(t.price).toBe(39);
    expect(t.sma20 as number).toBeCloseTo(closes.slice(-20).reduce((a, c) => a + c) / 20, 8);
    expect(t.prev_close as number).toBeCloseTo(38, 8);
  });

  test("short history uses bulk fallbacks and recent-listing windows", () => {
    const closes = [10, 10.5, 11, 10.8, 11.2];
    const t = computeTechnicals(barsFromCloses(closes), { bulk: { hi250: 20, lo250: 5, avgVol50: 2000 } });
    expect(t.high_52w_pct as number).toBeCloseTo((11.2 / 20 - 1) * 100, 6);
    expect(t.low_52w_pct as number).toBeCloseTo((11.2 / 5 - 1) * 100, 6);
    expect(t.avg_volume).toBe(2000);
    expect(t.high_20d_pct).toBeNull();
    expect(t.sma20).toBeNull();
    expect(t.rsi14).toBeNull();
    const ipo = computeTechnicals(barsFromCloses(closes), { listedWithinHistory: true });
    expect(ipo.high_20d_pct as number).toBeLessThanOrEqual(0);
    expect(ipo.avg_volume).toBe(1000);
  });

  test("bad rows are dropped", () => {
    const b = barsFromCloses([10, 11, 12]);
    b.close[1] = 0;
    b.adjClose[1] = 0;
    const t = computeTechnicals(b);
    expect(t.prev_close).toBe(10);
  });
});
