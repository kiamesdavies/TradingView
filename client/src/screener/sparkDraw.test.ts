import { expect, test } from "bun:test";
import { sparkGeometry } from "./sparkDraw";

test("maps values into the box, y inverted", () => {
  const g = sparkGeometry([10, 20, 15], 100, 50, 5)!;
  expect(g.points).toEqual([[0, 45], [50, 5], [100, 25]]);
  expect(g.min).toBe(10);
  expect(g.max).toBe(20);
  expect(g.up).toBe(true);
  expect(g.changePct).toBe(50);
});

test("flat series centred; down detection; NaN skipped", () => {
  const flat = sparkGeometry([5, 5, 5], 10, 20)!;
  expect(flat.points.every(([, y]) => y === 10)).toBe(true);
  const down = sparkGeometry([3, Number.NaN, 1], 10, 10)!;
  expect(down.up).toBe(false);
  expect(down.points.length).toBe(2);
});

test("insufficient data", () => {
  expect(sparkGeometry([], 10, 10)).toBeNull();
  expect(sparkGeometry([1], 10, 10)).toBeNull();
  expect(sparkGeometry([1, 2], 0, 10)).toBeNull();
});
