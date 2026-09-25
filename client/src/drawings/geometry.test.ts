/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { Drawing } from "@eodview/shared";
import {
  barInterval, distToHRay, fractionalCoordinate, fractionalLogical, distToSegment, distToShape, fibLevels, hitTest, isValidDrawing, logicalToTime,
  movePoint, pointsRequired, projectDrawing, timeToLogical, translateDrawing, withAlpha, type ScreenShape,
} from "./geometry";

const D = 86400;
// Mon..Fri, Mon..Fri (weekend gap)
const times = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map((d) => d * D);

describe("time <-> logical", () => {
  test("bar interval is the median delta", () => {
    expect(barInterval(times)).toBe(D);
    expect(barInterval([])).toBe(D);
    expect(barInterval([60, 120, 180, 600])).toBe(60);
  });

  test("exact bar times map to their index", () => {
    times.forEach((t, i) => expect(timeToLogical(t, times)).toBe(i));
  });

  test("times in a gap interpolate", () => {
    // Saturday = day 5, between index 4 (day 4) and 5 (day 7)
    expect(timeToLogical(5 * D, times)).toBeCloseTo(4 + 1 / 3);
  });

  test("extrapolates outside loaded data", () => {
    expect(timeToLogical(-3 * D, times)).toBe(-3);
    expect(timeToLogical(14 * D, times)).toBe(9 + 3);
  });

  test("logicalToTime inverts timeToLogical", () => {
    for (const l of [-5, -0.5, 0, 2, 4.5, 9, 12.25]) {
      const t = logicalToTime(l, times)!;
      expect(timeToLogical(t, times)).toBeCloseTo(l, 5);
    }
    expect(logicalToTime(5, times)).toBe(7 * D);
    expect(logicalToTime(11, times)).toBe(13 * D);
  });

  test("empty data -> null", () => {
    expect(timeToLogical(0, [])).toBeNull();
    expect(logicalToTime(0, [])).toBeNull();
  });
});

describe("distances", () => {
  test("segment", () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  test("horizontal ray", () => {
    expect(distToHRay({ x: 500, y: 12 }, { x: 10, y: 10 })).toBe(2);
    expect(distToHRay({ x: 7, y: 6 }, { x: 10, y: 10 })).toBe(5);
  });

  test("rect hits edges, not the interior", () => {
    const s: ScreenShape = { id: "r", type: "rect", pts: [{ x: 100, y: 100 }, { x: 0, y: 0 }] };
    expect(distToShape(s, { x: 50, y: 2 })).toBe(2);
    expect(distToShape(s, { x: 97, y: 50 })).toBe(3);
    expect(distToShape(s, { x: 50, y: 50 })).toBe(50);
  });

  test("hline is full width", () => {
    const s: ScreenShape = { id: "h", type: "hline", pts: [{ x: 0, y: 40 }] };
    expect(distToShape(s, { x: 9999, y: 44 })).toBe(4);
  });
});

describe("fib", () => {
  test("levels: 0 at end, 1 at start", () => {
    const l = fibLevels(100, 200);
    expect(l.map((x) => x.ratio)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(l[0]!.price).toBe(200);
    expect(l[3]!.price).toBe(150);
    expect(l[4]!.price).toBeCloseTo(138.2);
    expect(l[6]!.price).toBe(100);
  });

  test("hit on a level line within x-span", () => {
    const d: Drawing = { id: "f", type: "fib", points: [{ time: 0, price: 100 }, { time: 10, price: 200 }], color: "#fff", lineWidth: 1 };
    const s = projectDrawing(d, { timeToX: (t) => t * 10, priceToY: (p) => 300 - p })!;
    expect(s.levels!.length).toBe(7);
    expect(distToShape(s, { x: 20, y: 151 })).toBe(1); // 0.5 level at y=150, away from the diagonal
    expect(distToShape(s, { x: 200, y: 150 })).toBeGreaterThan(6);
  });
});

describe("projection", () => {
  const proj = { timeToX: (t: number) => (t < 0 ? null : t), priceToY: (p: number) => -p };
  test("returns null when a point cannot be projected", () => {
    const d: Drawing = { id: "t", type: "trendline", points: [{ time: -1, price: 1 }, { time: 5, price: 2 }], color: "#fff", lineWidth: 1 };
    expect(projectDrawing(d, proj)).toBeNull();
  });
  test("hline survives a missing x", () => {
    const d: Drawing = { id: "h", type: "hline", points: [{ time: -1, price: 7 }], color: "#fff", lineWidth: 1 };
    expect(projectDrawing(d, proj)!.pts[0]).toEqual({ x: 0, y: -7 });
  });
  test("missing second point -> null", () => {
    const d: Drawing = { id: "t", type: "trendline", points: [{ time: 1, price: 1 }], color: "#fff", lineWidth: 1 };
    expect(projectDrawing(d, proj)).toBeNull();
  });
});

describe("hitTest", () => {
  const line: ScreenShape = { id: "a", type: "trendline", pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
  const hl: ScreenShape = { id: "b", type: "hline", pts: [{ x: 0, y: 3 }] };

  test("miss beyond tolerance", () => {
    expect(hitTest([line], { x: 50, y: 20 }, null)).toBeNull();
  });
  test("body hit picks the nearest", () => {
    expect(hitTest([line, hl], { x: 50, y: 2 }, null)).toMatchObject({ id: "b", part: { kind: "body" } });
    expect(hitTest([line, hl], { x: 50, y: 0 }, null)).toMatchObject({ id: "a", part: { kind: "body" } });
  });
  test("handles beat bodies", () => {
    expect(hitTest([line, hl], { x: 100, y: 3 }, null)).toMatchObject({ id: "a", part: { kind: "handle", index: 1 } });
  });
  test("selected drawing's handles win", () => {
    const other: ScreenShape = { id: "c", type: "trendline", pts: [{ x: 101, y: 0 }, { x: 200, y: 50 }] };
    expect(hitTest([line, other], { x: 101, y: 0 }, null)!.id).toBe("c");
    expect(hitTest([line, other], { x: 101, y: 0 }, "a")).toMatchObject({ id: "a", part: { kind: "handle", index: 1 } });
  });
  test("hline has no handle", () => {
    expect(hitTest([hl], { x: 0, y: 3 }, "b")!.part.kind).toBe("body");
  });
});

describe("transforms", () => {
  const d: Drawing = { id: "t", type: "trendline", points: [{ time: 3 * D, price: 10 }, { time: 7 * D, price: 20 }], color: "#fff", lineWidth: 2 };
  test("translate by bars skips the weekend gap", () => {
    const m = translateDrawing(d, 1, 5, times);
    expect(m.points).toEqual([{ time: 4 * D, price: 15 }, { time: 8 * D, price: 25 }]);
    expect(d.points[0]!.price).toBe(10); // immutable
  });
  test("translate beyond data extrapolates", () => {
    const m = translateDrawing(d, 6, 0, times);
    expect(m.points[1]!.time).toBe(13 * D);
  });
  test("hline keeps its time", () => {
    const h: Drawing = { ...d, type: "hline", points: [{ time: 3 * D, price: 10 }] };
    expect(translateDrawing(h, 4, 1, times).points[0]).toEqual({ time: 3 * D, price: 11 });
  });
  test("movePoint", () => {
    expect(movePoint(d, 1, { time: 1, price: 2 }).points).toEqual([d.points[0]!, { time: 1, price: 2 }]);
  });
});

describe("misc", () => {
  test("withAlpha", () => {
    expect(withAlpha("#2962ff", 0.5)).toBe("rgba(41, 98, 255, 0.5)");
    expect(withAlpha("#fff", 0.1)).toBe("rgba(255, 255, 255, 0.1)");
    expect(withAlpha("red", 0.1)).toBe("red");
  });
  test("pointsRequired", () => {
    expect(pointsRequired("hline")).toBe(1);
    expect(pointsRequired("hray")).toBe(1);
    expect(pointsRequired("fib")).toBe(2);
  });
  test("isValidDrawing", () => {
    expect(isValidDrawing({ id: "x", type: "hline", points: [{ time: 1, price: 2 }], color: "#fff", lineWidth: 1 })).toBe(true);
    expect(isValidDrawing({ id: "x", type: "rect", points: [{ time: 1, price: 2 }], color: "#fff" })).toBe(false);
    expect(isValidDrawing({ id: "x", type: "circle", points: [], color: "#fff" })).toBe(false);
    expect(isValidDrawing(null)).toBe(false);
  });
});

describe("fractional logical conversions", () => {
  // library-like integer conversions: bar i centred at 100 + 10*i; coordinate->index uses ceil
  const toCoord = (i: number) => (Number.isInteger(i) ? 100 + 10 * i : 0);
  const toLogical = (x: number) => Math.ceil((x - 100) / 10);
  test("coordinate of a fractional index", () => {
    expect(fractionalCoordinate(2, toCoord)).toBe(120);
    expect(fractionalCoordinate(2.25, toCoord)).toBe(122.5);
    expect(fractionalCoordinate(-1.5, toCoord)).toBe(85);
    expect(fractionalCoordinate(1, () => null)).toBeNull();
  });
  test("fractional index under x", () => {
    expect(fractionalLogical(120, toLogical, toCoord)).toBe(2);
    expect(fractionalLogical(123, toLogical, toCoord)).toBeCloseTo(2.3);
    expect(fractionalLogical(77, toLogical, toCoord)).toBeCloseTo(-2.3);
    expect(fractionalLogical(5, () => null, toCoord)).toBeNull();
  });
});
