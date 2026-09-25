import { describe, expect, test } from "bun:test";
import type { Bar, Tick, Timeframe } from "@eodview/shared";
import {
  applyPrice,
  applyTick,
  bucketStart,
  findBarIndex,
  heikinAshiStep,
  mergeTail,
  prependBars,
  sessionDayStart,
  sessionTimeZone,
  tfSeconds,
  timeAtLogical,
  toHeikinAshi,
} from "./candles";

const utc = (iso: string) => Date.parse(iso) / 1000;
const bar = (time: number, o: number, h: number, l: number, c: number, v = 100): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v });
const tick = (iso: string, price: number, volume = 10, symbol = "AAPL.US"): Tick => ({ symbol, price, volume, time: Date.parse(iso) });

describe("bucketStart", () => {
  const t = utc("2024-03-14T13:47:23Z"); // Thursday
  const cases: [Timeframe, string][] = [
    ["1m", "2024-03-14T13:47:00Z"],
    ["5m", "2024-03-14T13:45:00Z"],
    ["15m", "2024-03-14T13:45:00Z"],
    ["30m", "2024-03-14T13:30:00Z"],
    ["1h", "2024-03-14T13:00:00Z"],
    ["4h", "2024-03-14T12:00:00Z"],
    ["1D", "2024-03-14T00:00:00Z"],
    ["1W", "2024-03-11T00:00:00Z"], // Monday
    ["1M", "2024-03-01T00:00:00Z"],
  ];
  for (const [tf, expected] of cases) {
    test(tf, () => expect(bucketStart(t, tf)).toBe(utc(expected)));
  }

  test("exact boundary maps to itself", () => {
    expect(bucketStart(utc("2024-03-14T13:45:00Z"), "15m")).toBe(utc("2024-03-14T13:45:00Z"));
    expect(bucketStart(utc("2024-03-11T00:00:00Z"), "1W")).toBe(utc("2024-03-11T00:00:00Z"));
  });

  test("1W: Sunday belongs to the week starting the previous Monday", () => {
    expect(bucketStart(utc("2024-03-17T23:59:59Z"), "1W")).toBe(utc("2024-03-11T00:00:00Z"));
  });

  test("1W across a year boundary (ISO week)", () => {
    expect(bucketStart(utc("2025-01-01T10:00:00Z"), "1W")).toBe(utc("2024-12-30T00:00:00Z"));
  });

  test("1M on the last second of a month and on Feb 29", () => {
    expect(bucketStart(utc("2024-01-31T23:59:59Z"), "1M")).toBe(utc("2024-01-01T00:00:00Z"));
    expect(bucketStart(utc("2024-02-29T12:00:00Z"), "1M")).toBe(utc("2024-02-01T00:00:00Z"));
  });

  test("intraday anchor keeps the feed's phase", () => {
    const anchor = utc("2024-03-14T13:30:00Z");
    expect(bucketStart(utc("2024-03-14T14:10:00Z"), "1h", anchor)).toBe(utc("2024-03-14T13:30:00Z"));
    expect(bucketStart(utc("2024-03-14T14:31:00Z"), "1h", anchor)).toBe(utc("2024-03-14T14:30:00Z"));
    expect(bucketStart(utc("2024-03-14T13:29:00Z"), "1h", anchor)).toBe(utc("2024-03-14T12:30:00Z"));
  });

  test("tfSeconds", () => {
    expect(tfSeconds("1m")).toBe(60);
    expect(tfSeconds("4h")).toBe(14_400);
    expect(tfSeconds("1D")).toBe(86_400);
    expect(tfSeconds("1W")).toBe(604_800);
  });
});

describe("applyTick", () => {
  const last = bar(utc("2024-03-14T13:45:00Z"), 100, 101, 99, 100.5, 1000);
  const bars = [bar(utc("2024-03-14T13:30:00Z"), 99, 100, 98, 99.5), last];

  test("same bucket updates high/low/close and adds volume", () => {
    const r = applyTick(bars, tick("2024-03-14T13:50:00Z", 102, 25), "15m");
    expect(r).toEqual({ kind: "update", bar: { time: last.time, open: 100, high: 102, low: 99, close: 102, volume: 1025 } });
    const r2 = applyTick(bars, tick("2024-03-14T13:59:59Z", 98.5, 5), "15m");
    expect(r2).toEqual({ kind: "update", bar: { time: last.time, open: 100, high: 101, low: 98.5, close: 98.5, volume: 1005 } });
  });

  test("does not mutate the input", () => {
    const copy = structuredClone(bars);
    applyTick(bars, tick("2024-03-14T13:50:00Z", 150), "15m");
    applyTick(bars, tick("2024-03-14T14:05:00Z", 150), "15m");
    expect(bars).toEqual(copy);
  });

  test("newer bucket appends a bar opened at the price", () => {
    const r = applyTick(bars, tick("2024-03-14T14:07:30Z", 103, 7), "15m");
    expect(r).toEqual({ kind: "append", bar: { time: utc("2024-03-14T14:00:00Z"), open: 103, high: 103, low: 103, close: 103, volume: 7 } });
  });

  test("older ticks are ignored", () => {
    expect(applyTick(bars, tick("2024-03-14T13:44:59Z", 50), "15m")).toEqual({ kind: "ignored" });
  });

  test("no loaded bars → ignored (never creates bars outside the loaded range)", () => {
    expect(applyTick([], tick("2024-03-14T13:50:00Z", 50), "15m")).toEqual({ kind: "ignored" });
  });

  test("invalid price is ignored; negative/NaN volume counts as 0", () => {
    expect(applyTick(bars, tick("2024-03-14T13:50:00Z", Number.NaN), "15m").kind).toBe("ignored");
    expect(applyTick(bars, tick("2024-03-14T13:50:00Z", 0), "15m").kind).toBe("ignored");
    const r = applyTick(bars, { ...tick("2024-03-14T13:50:00Z", 100.7), volume: Number.NaN }, "15m");
    expect(r.kind === "update" && r.bar.volume).toBe(1000);
  });

  test("1D: same UTC date updates, next date appends at 00:00 UTC", () => {
    const d = [bar(utc("2024-03-14T00:00:00Z"), 10, 11, 9, 10.5, 500)];
    expect(applyTick(d, tick("2024-03-14T20:59:00Z", 12, 1), "1D")).toMatchObject({ kind: "update", bar: { high: 12, close: 12, volume: 501 } });
    expect(applyTick(d, tick("2024-03-15T13:30:00Z", 11, 1), "1D")).toEqual({
      kind: "append",
      bar: { time: utc("2024-03-15T00:00:00Z"), open: 11, high: 11, low: 11, close: 11, volume: 1 },
    });
    expect(applyTick(d, tick("2024-03-13T20:00:00Z", 11), "1D").kind).toBe("ignored");
  });

  test("1W: bar stamped on a Tuesday (holiday Monday) still takes ticks from the same ISO week", () => {
    const w = [bar(utc("2024-05-28T00:00:00Z"), 10, 11, 9, 10)]; // Tue after Memorial Day
    const r = applyTick(w, tick("2024-05-31T19:00:00Z", 12), "1W");
    expect(r.kind).toBe("update");
    expect(r.kind === "update" && r.bar.time).toBe(utc("2024-05-28T00:00:00Z"));
    const next = applyTick(w, tick("2024-06-03T14:00:00Z", 12), "1W");
    expect(next.kind === "append" && next.bar.time).toBe(utc("2024-06-03T00:00:00Z"));
  });

  test("1M: first-trading-day stamps bucket by calendar month", () => {
    const m = [bar(utc("2024-04-01T00:00:00Z"), 10, 11, 9, 10)];
    expect(applyTick(m, tick("2024-04-30T19:00:00Z", 12), "1M").kind).toBe("update");
    const r = applyTick(m, tick("2024-05-01T14:00:00Z", 12), "1M");
    expect(r.kind === "append" && r.bar.time).toBe(utc("2024-05-01T00:00:00Z"));
  });

  test("intraday bars with a :30 phase keep that phase", () => {
    const h = [bar(utc("2024-03-14T13:30:00Z"), 10, 11, 9, 10)];
    expect(applyTick(h, tick("2024-03-14T14:20:00Z", 12), "1h").kind).toBe("update");
    const r = applyTick(h, tick("2024-03-14T15:40:00Z", 12), "1h");
    expect(r.kind === "append" && r.bar.time).toBe(utc("2024-03-14T15:30:00Z"));
  });

  test("applyPrice (quotes) with zero volume leaves volume unchanged", () => {
    const r = applyPrice(bars, 100.9, 0, utc("2024-03-14T13:52:00Z"), "15m");
    expect(r).toMatchObject({ kind: "update", bar: { close: 100.9, volume: 1000 } });
  });
});

describe("heikin ashi", () => {
  test("first bar uses (o+c)/2 open", () => {
    const b = bar(1, 10, 14, 8, 12);
    expect(heikinAshiStep(undefined, b)).toEqual({ time: 1, open: 11, high: 14, low: 8, close: 11, volume: 100 });
  });

  test("series follows the recurrence", () => {
    const src = [bar(1, 10, 14, 8, 12, 5), bar(2, 12, 15, 11, 14, 6), bar(3, 14, 14.5, 9, 9.5, 7)];
    const ha = toHeikinAshi(src);
    expect(ha).toHaveLength(3);
    // bar 2: close = (12+15+11+14)/4 = 13, open = (11 + 11)/2 = 11
    expect(ha[1]).toEqual({ time: 2, open: 11, high: 15, low: 11, close: 13, volume: 6 });
    // bar 3: close = (14+14.5+9+9.5)/4 = 11.75, open = (11+13)/2 = 12, high = max(14.5,12,11.75), low = min(9,...)
    expect(ha[2]).toEqual({ time: 3, open: 12, high: 14.5, low: 9, close: 11.75, volume: 7 });
    // high/low always envelope open/close
    for (const h of ha) {
      expect(h.high).toBeGreaterThanOrEqual(Math.max(h.open, h.close));
      expect(h.low).toBeLessThanOrEqual(Math.min(h.open, h.close));
    }
  });

  test("does not mutate raw bars and handles empty input", () => {
    const src = [bar(1, 10, 14, 8, 12)];
    const copy = structuredClone(src);
    toHeikinAshi(src);
    expect(src).toEqual(copy);
    expect(toHeikinAshi([])).toEqual([]);
  });

  test("incremental step equals full recompute", () => {
    const src = Array.from({ length: 20 }, (_, i) => bar(i, 10 + i, 12 + i, 9 + i, 11 + (i % 3)));
    const full = toHeikinAshi(src);
    const inc: Bar[] = [];
    for (const b of src) inc.push(heikinAshiStep(inc[inc.length - 1], b));
    expect(inc).toEqual(full);
  });
});

describe("merging and lookup", () => {
  const bars = [bar(10, 1, 1, 1, 1), bar(20, 2, 2, 2, 2), bar(30, 3, 3, 3, 3)];

  test("prependBars drops overlap", () => {
    const older = [bar(0, 0, 0, 0, 0), bar(10, 9, 9, 9, 9)];
    expect(prependBars(older, bars).map((b) => b.time)).toEqual([0, 10, 20, 30]);
    expect(prependBars(older, bars)[1]!.open).toBe(1); // existing bar wins
    expect(prependBars(older, []).map((b) => b.time)).toEqual([0, 10]);
  });

  test("mergeTail replaces from the fresh start", () => {
    const fresh = [bar(20, 7, 7, 7, 7), bar(30, 8, 8, 8, 8), bar(40, 9, 9, 9, 9)];
    const merged = mergeTail(bars, fresh);
    expect(merged.map((b) => b.time)).toEqual([10, 20, 30, 40]);
    expect(merged[1]!.open).toBe(7);
    expect(mergeTail(bars, [])).toEqual(bars);
  });

  test("mergeTail keeps live bars newer than the fresh tail", () => {
    // Local has a tick-built bar at 40 that the (lagging) REST tail does not include yet.
    const local = [...bars, bar(40, 5, 9, 4, 8, 50)];
    const merged = mergeTail(local, [bar(20, 7, 7, 7, 7), bar(30, 8, 8, 8, 8)]);
    expect(merged.map((b) => b.time)).toEqual([10, 20, 30, 40]);
    expect(merged[2]!.close).toBe(8);
    expect(merged[3]).toEqual(bar(40, 5, 9, 4, 8, 50));
  });

  test("mergeTail folds the forming bar when both end on the same time", () => {
    const local = [...bars, bar(40, 5, 12, 4, 11, 80)];
    const merged = mergeTail(local, [bar(30, 3, 3, 3, 3), bar(40, 5, 10, 3, 9, 60)]);
    expect(merged.map((b) => b.time)).toEqual([10, 20, 30, 40]);
    expect(merged[3]).toEqual(bar(40, 5, 12, 3, 11, 80));
  });

  test("findBarIndex", () => {
    expect(findBarIndex(bars, 20)).toBe(1);
    expect(findBarIndex(bars, 25)).toBe(-1);
    expect(findBarIndex([], 20)).toBe(-1);
  });

  test("timeAtLogical snaps inside, extrapolates outside", () => {
    const m = [bar(utc("2024-01-01T00:00:00Z"), 1, 1, 1, 1), bar(utc("2024-01-02T00:00:00Z"), 1, 1, 1, 1)];
    expect(timeAtLogical(m, 0.4, "1D")).toBe(m[0]!.time);
    expect(timeAtLogical(m, 3, "1D")).toBe(utc("2024-01-04T00:00:00Z"));
    expect(timeAtLogical(m, -2, "1D")).toBe(utc("2023-12-30T00:00:00Z"));
    const mo = [bar(utc("2024-01-02T00:00:00Z"), 1, 1, 1, 1)];
    expect(timeAtLogical(mo, 2, "1M")).toBe(utc("2024-03-01T00:00:00Z"));
    expect(timeAtLogical(mo, -1, "1M")).toBe(utc("2023-12-01T00:00:00Z"));
    expect(timeAtLogical([], 1, "1D")).toBeNull();
  });
});

describe("session dates and coalesced ticks", () => {
  test("US ticks bucket by the New York session date", () => {
    expect(sessionTimeZone("AAPL.US")).toBe("America/New_York");
    expect(sessionTimeZone("BTC-USD.CC")).toBeUndefined();
    // Friday 2027-01-15 19:30 EST == Saturday 00:30 UTC
    const t = utc("2027-01-16T00:30:00Z");
    expect(sessionDayStart(t)).toBe(utc("2027-01-16T00:00:00Z"));
    expect(sessionDayStart(t, "America/New_York")).toBe(utc("2027-01-15T00:00:00Z"));
    const friday = [bar(utc("2027-01-15T00:00:00Z"), 100, 101, 99, 100)];
    const r = applyTick(friday, tick("2027-01-16T00:30:00Z", 102), "1D", "America/New_York");
    expect(r.kind).toBe("update");
    // without the zone it would open a phantom Saturday bar
    expect(applyTick(friday, tick("2027-01-16T00:30:00Z", 102), "1D").kind).toBe("append");
    // month end: Jan 31 after-hours stays in January
    const jan = [bar(utc("2027-01-01T00:00:00Z"), 1, 1, 1, 1)];
    expect(applyTick(jan, tick("2027-02-01T00:30:00Z", 2), "1M", "America/New_York").kind).toBe("update");
  });

  test("coalesced tick extremes reach the candle", () => {
    const start = utc("2024-03-14T13:47:00Z");
    const bars = [bar(start, 100, 100, 100, 100)];
    const t: Tick = { ...tick("2024-03-14T13:47:10Z", 101), open: 105, high: 110, low: 95 };
    const r = applyTick(bars, t, "1m");
    expect(r).toEqual({ kind: "update", bar: bar(start, 100, 110, 95, 101, 110) });
    const next: Tick = { ...tick("2024-03-14T13:48:01Z", 101), open: 104, high: 106, low: 99 };
    const a = applyTick(bars, next, "1m");
    expect(a).toEqual({ kind: "append", bar: bar(start + 60, 104, 106, 99, 101, 10) });
  });
});
