import { describe, expect, test } from "bun:test";
import type { Alert } from "@eodview/shared";
import { detectCross, REPEAT_COOLDOWN_SEC, shouldTrigger } from "./evaluate";

describe("detectCross", () => {
  test("up: prev < level <= cur", () => {
    expect(detectCross(99, 100, 100)).toBe("up");
    expect(detectCross(99, 101, 100)).toBe("up");
    expect(detectCross(100, 101, 100)).toBeNull(); // started on the level
    expect(detectCross(98, 99, 100)).toBeNull();
  });
  test("down: prev > level >= cur", () => {
    expect(detectCross(101, 100, 100)).toBe("down");
    expect(detectCross(101, 99, 100)).toBe("down");
    expect(detectCross(100, 99, 100)).toBeNull();
    expect(detectCross(102, 101, 100)).toBeNull();
  });
  test("no baseline or invalid → none", () => {
    expect(detectCross(undefined, 200, 100)).toBeNull();
    expect(detectCross(NaN, 200, 100)).toBeNull();
    expect(detectCross(99, NaN, 100)).toBeNull();
  });
});

describe("shouldTrigger", () => {
  const base: Alert = { id: "a", symbol: "AAPL.US", price: 100, condition: "cross", repeat: false, active: true, createdAt: 0 };
  test("respects condition", () => {
    expect(shouldTrigger({ ...base, condition: "cross_up" }, 99, 101, 1000)).toBe(true);
    expect(shouldTrigger({ ...base, condition: "cross_up" }, 101, 99, 1000)).toBe(false);
    expect(shouldTrigger({ ...base, condition: "cross_down" }, 101, 99, 1000)).toBe(true);
    expect(shouldTrigger({ ...base, condition: "cross_down" }, 99, 101, 1000)).toBe(false);
    expect(shouldTrigger(base, 99, 101, 1000)).toBe(true);
    expect(shouldTrigger(base, 101, 99, 1000)).toBe(true);
  });
  test("inactive never fires", () => {
    expect(shouldTrigger({ ...base, active: false }, 99, 101, 1000)).toBe(false);
  });
  test("repeat cooldown", () => {
    const a = { ...base, repeat: true, lastTriggeredAt: 1000 };
    expect(shouldTrigger(a, 99, 101, 1000 + REPEAT_COOLDOWN_SEC - 1)).toBe(false);
    expect(shouldTrigger(a, 99, 101, 1000 + REPEAT_COOLDOWN_SEC)).toBe(true);
  });
});
