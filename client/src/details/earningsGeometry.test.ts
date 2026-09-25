import { describe, expect, test } from "bun:test";
import type { EarningsPoint } from "@eodview/shared";
import {
  classifyActual, columnAt, epsChartGeometry, niceScale, niceStep, revenueChartGeometry, stepDecimals, surprisePct, trimZeros,
} from "./earningsGeometry";

const ep = (period: string, epsActual: number | null, epsEstimate: number | null, upcoming = false): EarningsPoint => ({
  period, epsActual, epsEstimate, surprisePct: null, upcoming,
});

describe("niceScale", () => {
  test("niceStep", () => {
    expect(niceStep(0.13)).toBeCloseTo(0.2, 12);
    expect(niceStep(0.22)).toBeCloseTo(0.25, 12);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(0)).toBe(1);
  });
  test("covers data with <= 5 ticks", () => {
    for (const vals of [[1.2, 1.64], [0.31, 0.5], [-0.8, 2.3], [-3, -1], [0.001, 0.004], [120e9, 94e9]]) {
      const s = niceScale(vals, 5)!;
      expect(s.ticks.length).toBeLessThanOrEqual(5);
      expect(s.ticks.length).toBeGreaterThanOrEqual(2);
      expect(s.min).toBeLessThanOrEqual(Math.min(...vals));
      expect(s.max).toBeGreaterThanOrEqual(Math.max(...vals));
      expect(s.ticks[0]).toBe(s.min);
      expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
    }
  });
  test("degenerate and empty input", () => {
    expect(niceScale([], 5)).toBeNull();
    expect(niceScale([Number.NaN], 5)).toBeNull();
    const s = niceScale([2, 2, 2], 5)!;
    expect(s.min).toBeLessThan(2);
    expect(s.max).toBeGreaterThan(2);
    const z = niceScale([0], 5)!;
    expect(z.min).toBeLessThan(0);
    expect(z.max).toBeGreaterThan(0);
    const zi = niceScale([0], 5, true)!;
    expect(zi.min).toBe(0);
    expect(zi.max).toBeGreaterThan(0);
  });
  test("includeZero", () => {
    const s = niceScale([90e9, 120e9], 5, true)!;
    expect(s.min).toBe(0);
    const n = niceScale([-5, -2], 5, true)!;
    expect(n.max).toBe(0);
  });
  test("no float noise in ticks", () => {
    const s = niceScale([0.1, 0.7], 5)!;
    for (const t of s.ticks) expect(String(t).length).toBeLessThan(6);
  });
  test("stepDecimals", () => {
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(2)).toBe(0);
  });
});

describe("epsChartGeometry", () => {
  const box = { width: 280, height: 160 };
  const pts = [
    ep("2025-03-31", 1.5, 1.4),
    ep("2025-06-30", 1.2, 1.3),
    ep("2025-09-30", -0.4, -0.2),
    ep("2025-12-31", null, 1.1),
    ep("2026-03-31", 1.9, null),
    ep("2026-06-30", null, 1.7, true),
  ];
  test("dots: estimate hollow, actual classified, upcoming only estimate, missing skipped", () => {
    const g = epsChartGeometry(pts, box)!;
    expect(g.columns.map((c) => c.label)).toEqual(["Q1 '25", "Q2 '25", "Q3 '25", "Q4 '25", "Q1 '26", "Q2 '26"]);
    expect(g.dots[0].map((d) => d.kind)).toEqual(["estimate", "beat"]);
    expect(g.dots[1].map((d) => d.kind)).toEqual(["estimate", "miss"]);
    expect(g.dots[2].map((d) => d.kind)).toEqual(["estimate", "miss"]);
    expect(g.dots[3].map((d) => d.kind)).toEqual(["estimate"]);
    expect(g.dots[4].map((d) => d.kind)).toEqual(["actual"]);
    expect(g.dots[5].map((d) => d.kind)).toEqual(["estimate"]);
  });
  test("negative EPS: all dots inside the plot, zero line shown, higher value -> smaller y", () => {
    const g = epsChartGeometry(pts, box)!;
    for (const col of g.dots) {
      for (const d of col) {
        expect(d.cy).toBeGreaterThanOrEqual(g.plot.top - 1e-6);
        expect(d.cy).toBeLessThanOrEqual(g.plot.bottom + 1e-6);
        expect(d.cx).toBeGreaterThan(g.plot.left);
        expect(d.cx).toBeLessThan(g.plot.right);
      }
    }
    expect(g.zeroY).not.toBeNull();
    expect(g.dots[4][0].cy).toBeLessThan(g.dots[2][1].cy);
    expect(g.ticks.length).toBeGreaterThanOrEqual(2);
    expect(g.ticks.length).toBeLessThanOrEqual(5);
    expect(g.ticks.some((t) => t.label.startsWith("−"))).toBe(true);
    // ticks descend in y as value rises
    expect(g.ticks[0].y).toBeGreaterThan(g.ticks[g.ticks.length - 1].y);
  });
  test("all missing -> null; single value works", () => {
    expect(epsChartGeometry([ep("2025-03-31", null, null)], box)).toBeNull();
    const g = epsChartGeometry([ep("2025-03-31", 0.5, 0.5)], box)!;
    expect(g.dots[0].map((d) => d.kind)).toEqual(["estimate", "beat"]);
    expect(g.dots[0][0].cy).toBeCloseTo(g.dots[0][1].cy, 9);
  });
  test("labels thin out on narrow widths, keeping the last", () => {
    const many = Array.from({ length: 9 }, (_, i) => ep(`202${4 + Math.floor(i / 4)}-${["03-31", "06-30", "09-30", "12-31"][i % 4]}`, 1, 1));
    const wide = epsChartGeometry(many, { width: 500, height: 160 })!;
    expect(wide.columns.every((c) => c.showLabel)).toBe(true);
    const narrow = epsChartGeometry(many, { width: 200, height: 160 })!;
    expect(narrow.columns.filter((c) => c.showLabel).length).toBeLessThan(9);
    expect(narrow.columns[8].showLabel).toBe(true);
  });
  test("columnAt", () => {
    const g = epsChartGeometry(pts, box)!;
    expect(columnAt(g.columns, g.columns[2].cx)).toBe(2);
    expect(columnAt(g.columns, -5)).toBeNull();
  });
});

describe("revenueChartGeometry", () => {
  test("bars rise from zero, missing values null", () => {
    const g = revenueChartGeometry(
      [{ period: "2025-06-30", revenue: 94e9 }, { period: "2025-09-30", revenue: null }, { period: "2025-12-31", revenue: 124e9 }],
      { width: 280, height: 160 },
    )!;
    expect(g.bars[1]).toBeNull();
    const [a, , c] = g.bars;
    expect(a!.y + a!.height).toBeCloseTo(g.zeroY, 6);
    expect(c!.height).toBeGreaterThan(a!.height);
    expect(g.ticks[0].label).toBe("0");
    expect(g.ticks[g.ticks.length - 1].label).toMatch(/B$/);
  });
  test("negative revenue hangs below the baseline", () => {
    const g = revenueChartGeometry([{ period: "2025-06-30", revenue: -5e6 }, { period: "2025-09-30", revenue: 10e6 }], { width: 280, height: 160 })!;
    expect(g.bars[0]!.negative).toBe(true);
    expect(g.bars[0]!.y).toBeCloseTo(g.zeroY, 6);
    expect(revenueChartGeometry([{ period: "2025-06-30", revenue: null }], { width: 280, height: 160 })).toBeNull();
  });
});

describe("helpers", () => {
  test("classifyActual", () => {
    expect(classifyActual(1, 0.9)).toBe("beat");
    expect(classifyActual(1, 1)).toBe("beat");
    expect(classifyActual(0.8, 0.9)).toBe("miss");
    expect(classifyActual(1, null)).toBe("actual");
  });
  test("surprisePct fallback", () => {
    expect(surprisePct({ ...ep("x", 1.1, 1), surprisePct: 12 })).toBe(12);
    expect(surprisePct(ep("x", 1.1, 1))).toBeCloseTo(10, 9);
    expect(surprisePct(ep("x", -0.1, -0.2))).toBeCloseTo(50, 9);
    expect(surprisePct(ep("x", 1, 0))).toBeNull();
  });
});

describe("trimZeros", () => {
  test("strips trailing zeros before the unit", () => {
    expect(trimZeros("150.0B")).toBe("150B");
    expect(trimZeros("2.50B")).toBe("2.5B");
    expect(trimZeros("1.25M")).toBe("1.25M");
    expect(trimZeros("50.00")).toBe("50");
    expect(trimZeros("−2.00M")).toBe("−2M");
  });
});
