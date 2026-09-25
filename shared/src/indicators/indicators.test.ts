import { describe, expect, test } from "bun:test";
import type { Bar } from "../types";
import {
  atr, bollinger, ema, macd, rsi, sma, sourceValue, trueRange, volumeMa, vwap,
  type IndicatorPoint,
} from "./index";

const DAY = 86_400;

/** Bars at daily spacing from closes; high = close+1, low = close-1, open = close. */
function fromCloses(closes: number[], volume = 100): Bar[] {
  return closes.map((c, i) => ({ time: i * DAY, open: c, high: c + 1, low: c - 1, close: c, volume }));
}

function expectPoints(actual: IndicatorPoint[], expected: [number, number][]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach(([time, value], i) => {
    expect(actual[i]!.time).toBe(time);
    expect(actual[i]!.value).toBeCloseTo(value, 9);
  });
}

describe("sources", () => {
  const b: Bar = { time: 0, open: 1, high: 4, low: 0, close: 3, volume: 0 };
  test("derived sources", () => {
    expect(sourceValue(b, "close")).toBe(3);
    expect(sourceValue(b, "open")).toBe(1);
    expect(sourceValue(b, "high")).toBe(4);
    expect(sourceValue(b, "low")).toBe(0);
    expect(sourceValue(b, "hl2")).toBe(2);
    expect(sourceValue(b, "hlc3")).toBeCloseTo(7 / 3, 12);
    expect(sourceValue(b, "ohlc4")).toBe(2);
  });
});

describe("sma", () => {
  test("rolling mean, warmup skipped", () => {
    expectPoints(sma(fromCloses([1, 2, 3, 4, 5]), 3), [[2 * DAY, 2], [3 * DAY, 3], [4 * DAY, 4]]);
  });
  test("uses the requested source", () => {
    // high = close + 1
    expectPoints(sma(fromCloses([1, 2, 3]), 3, "high"), [[2 * DAY, 3]]);
  });
  test("not enough bars -> empty", () => {
    expect(sma(fromCloses([1, 2]), 3)).toEqual([]);
  });
  test("rejects bad period", () => {
    expect(() => sma(fromCloses([1, 2]), 0)).toThrow(RangeError);
  });
});

describe("ema", () => {
  test("seeded with SMA, k = 2/(n+1)", () => {
    // seed = (2+4+6)/3 = 4; k = 0.5: 8*.5+4*.5 = 6; 20*.5+6*.5 = 13
    expectPoints(ema(fromCloses([2, 4, 6, 8, 20]), 3), [[2 * DAY, 4], [3 * DAY, 6], [4 * DAY, 13]]);
  });
});

describe("rsi (Wilder)", () => {
  test("hand-computed values", () => {
    // diffs: +1 -1 +2 | +1 -1 ; seed avgG = 1, avgL = 1/3 -> RS 3 -> 75
    // next: avgG = (2+1)/3 = 1, avgL = (2/3)/3 = 2/9 -> RS 4.5 -> 100 - 100/5.5
    // next: avgG = 2/3, avgL = (4/9+1)/3 = 13/27 -> RS 18/13 -> 100 - 1300/31
    expectPoints(rsi(fromCloses([10, 11, 10, 12, 13, 12]), 3), [
      [3 * DAY, 75],
      [4 * DAY, 100 - 100 / 5.5],
      [5 * DAY, 100 - 1300 / 31],
    ]);
  });
  test("only gains -> 100, flat -> 50", () => {
    expect(rsi(fromCloses([1, 2, 3, 4]), 3).map((p) => p.value)).toEqual([100]);
    expect(rsi(fromCloses([5, 5, 5, 5]), 3).map((p) => p.value)).toEqual([50]);
  });
  test("needs period+1 bars", () => {
    expect(rsi(fromCloses([1, 2, 3]), 3)).toEqual([]);
  });
});

describe("macd", () => {
  test("hand-computed with fast=2 slow=3 signal=2", () => {
    const r = macd(fromCloses([1, 2, 4, 8, 16, 32]), 2, 3, 2);
    // EMA2: 1.5, 19/6, 115/18, 691/54, 4147/162 ; EMA3: 7/3, 31/6, 127/12, 511/24
    expectPoints(r.macd, [
      [2 * DAY, 5 / 6],
      [3 * DAY, 11 / 9],
      [4 * DAY, 239 / 108],
      [5 * DAY, 2791 / 648],
    ]);
    // signal = EMA2 of macd seeded with (5/6 + 11/9)/2
    expectPoints(r.signal, [[3 * DAY, 37 / 36], [4 * DAY, 589 / 324], [5 * DAY, 6760 / 1944]]);
    expectPoints(r.histogram, [
      [3 * DAY, 11 / 9 - 37 / 36],
      [4 * DAY, 239 / 108 - 589 / 324],
      [5 * DAY, 1613 / 1944],
    ]);
  });
  test("default 12/26/9 warmup lengths", () => {
    const bars = fromCloses(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5));
    const r = macd(bars);
    expect(r.macd.length).toBe(60 - 25);
    expect(r.signal.length).toBe(60 - 33);
    expect(r.histogram.length).toBe(60 - 33);
    expect(r.signal[0]!.time).toBe(33 * DAY);
  });
});

describe("bollinger", () => {
  test("population standard deviation", () => {
    const r = bollinger(fromCloses([1, 2, 3, 10]), 3, 2);
    const sd1 = Math.sqrt(2 / 3); // [1,2,3] mean 2
    // [2,3,10] mean 5, deviations -3 -2 5 -> var = 38/3
    const sd2 = Math.sqrt(38 / 3);
    expectPoints(r.middle, [[2 * DAY, 2], [3 * DAY, 5]]);
    expectPoints(r.upper, [[2 * DAY, 2 + 2 * sd1], [3 * DAY, 5 + 2 * sd2]]);
    expectPoints(r.lower, [[2 * DAY, 2 - 2 * sd1], [3 * DAY, 5 - 2 * sd2]]);
  });
});

describe("atr (Wilder)", () => {
  const bars: Bar[] = [
    { time: 0, open: 9, high: 10, low: 8, close: 9, volume: 0 },
    { time: DAY, open: 9, high: 11, low: 9, close: 10, volume: 0 },       // TR 2
    { time: 2 * DAY, open: 10, high: 13, low: 10, close: 12, volume: 0 }, // TR 3
    { time: 3 * DAY, open: 19, high: 20, low: 19, close: 19.5, volume: 0 }, // gap: TR = 20-12 = 8
  ];
  test("true range handles gaps", () => {
    expect(trueRange(bars)).toEqual([2, 2, 3, 8]);
  });
  test("seed excludes first bar, then Wilder smoothing", () => {
    // seed (2+3)/2 = 2.5 ; next (2.5*1 + 8)/2 = 5.25
    expectPoints(atr(bars, 2), [[2 * DAY, 2.5], [3 * DAY, 5.25]]);
  });
});

describe("vwap", () => {
  const bars: Bar[] = [
    { time: 10 * DAY + 3600, open: 10, high: 11, low: 9, close: 10, volume: 100 },  // tp 10
    { time: 10 * DAY + 7200, open: 12, high: 14, low: 10, close: 12, volume: 300 }, // tp 12
    { time: 11 * DAY + 3600, open: 20, high: 21, low: 19, close: 20, volume: 50 },  // tp 20
  ];
  test("session resets each UTC day", () => {
    expectPoints(vwap(bars, "session"), [
      [bars[0]!.time, 10],
      [bars[1]!.time, (1000 + 3600) / 400],
      [bars[2]!.time, 20],
    ]);
  });
  test("cumulative anchored to first bar", () => {
    expectPoints(vwap(bars, "cumulative"), [
      [bars[0]!.time, 10],
      [bars[1]!.time, 11.5],
      [bars[2]!.time, (1000 + 3600 + 1000) / 450],
    ]);
  });
  test("zero volume falls back to equal weighting", () => {
    const zero = bars.map((b) => ({ ...b, volume: 0 }));
    expect(vwap(zero, "cumulative").map((p) => p.value)).toEqual([10, 11, 14]);
  });
});

describe("volumeMa", () => {
  test("sma of volume", () => {
    const bars = [100, 200, 600].map((v, i) => ({ time: i, open: 1, high: 1, low: 1, close: 1, volume: v }));
    expectPoints(volumeMa(bars, 2), [[1, 150], [2, 400]]);
  });
});
