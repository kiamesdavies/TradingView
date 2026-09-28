import { describe, expect, test } from "bun:test";
import { formatDuration, measure, measureLabel } from "./measure";

const DAY = 86400;
const times = Array.from({ length: 30 }, (_, i) => 1_700_000_000 - (1_700_000_000 % DAY) + i * DAY);
const fmt = (p: number) => p.toFixed(2);

describe("measure", () => {
  test("up move: price and percent change, bars, elapsed time", () => {
    const m = measure({ time: times[2]!, price: 100 }, { time: times[12]!, price: 112.5 }, times);
    expect(m.priceChange).toBe(12.5);
    expect(m.pctChange).toBeCloseTo(12.5);
    expect(m.bars).toBe(10);
    expect(m.seconds).toBe(10 * DAY);
    expect(m.up).toBe(true);
    expect(measureLabel(m, fmt)).toEqual(["+12.50 (+12.50%)", "10 bars, 10d"]);
  });

  test("down move measured right-to-left", () => {
    const m = measure({ time: times[20]!, price: 50 }, { time: times[15]!, price: 40 }, times);
    expect(m.up).toBe(false);
    expect(m.bars).toBe(-5);
    expect(measureLabel(m, fmt)).toEqual(["−10.00 (−20.00%)", "5 bars, -5d"]);
  });

  test("zero start price has no percent", () => {
    const m = measure({ time: times[0]!, price: 0 }, { time: times[1]!, price: 1 }, times);
    expect(m.pctChange).toBeNull();
    expect(measureLabel(m, fmt)[0]).toBe("+1.00");
  });

  test("points beyond the loaded data are extrapolated", () => {
    const m = measure({ time: times[28]!, price: 1 }, { time: times[29]! + 3 * DAY, price: 1 }, times);
    expect(m.bars).toBe(4);
  });
});

describe("formatDuration", () => {
  test("two adjacent units", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe("2h 15m");
    expect(formatDuration(3 * DAY + 4 * 3600)).toBe("3d 4h");
    expect(formatDuration(400 * DAY)).toBe("1y 1mo");
    expect(formatDuration(365 * DAY + 3 * 3600)).toBe("1y");
  });
});
