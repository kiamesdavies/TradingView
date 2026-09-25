import { describe, expect, test } from "bun:test";
import type { Bar } from "@eodview/shared";
import { aggregate, bucketOf } from "./aggregate";

const bar = (time: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v });
const T0 = Date.UTC(2024, 0, 2, 0, 0) / 1000; // Tue 2024-01-02 00:00 UTC

describe("aggregate", () => {
  test("5m → 15m merges OHLCV on epoch-aligned buckets", () => {
    const five = [
      bar(T0, 10, 11, 9, 10.5, 100),
      bar(T0 + 300, 10.5, 12, 10, 11, 200),
      bar(T0 + 600, 11, 11.5, 8, 9, 300),
      bar(T0 + 900, 9, 9.5, 8.5, 9.2, 50),
    ];
    expect(aggregate(five, 900)).toEqual([
      bar(T0, 10, 12, 8, 9, 600),
      bar(T0 + 900, 9, 9.5, 8.5, 9.2, 50),
    ]);
  });

  test("1h → 4h buckets start on UTC 4h boundaries even when data starts mid-bucket", () => {
    const start = T0 + 13 * 3600 + 1800; // 13:30 UTC, US open
    const hours = Array.from({ length: 8 }, (_, i) => bar(start + i * 3600, 100 + i, 101 + i, 99 + i, 100.5 + i, 10));
    const out = aggregate(hours, 4 * 3600);
    expect(out.map((b) => (b.time - T0) / 3600)).toEqual([12, 16, 20]);
    expect(out[0]).toEqual(bar(T0 + 12 * 3600, 100, 103, 99, 102.5, 30)); // 13:30,14:30,15:30
    expect(out[1].volume).toBe(40);
    expect(out[2]).toEqual(bar(T0 + 20 * 3600, 107, 108, 106, 107.5, 10));
  });

  test("gaps produce no empty buckets and input is not mutated", () => {
    const input = [bar(T0 + 3600, 1, 1, 1, 1, 1), bar(T0, 2, 2, 2, 2, 2)];
    const copy = structuredClone(input);
    const out = aggregate(input, 1800);
    expect(input).toEqual(copy);
    expect(out.map((b) => b.time)).toEqual([T0, T0 + 3600]);
  });

  test("empty input and bucketOf", () => {
    expect(aggregate([], 900)).toEqual([]);
    expect(bucketOf(T0 + 899, 900)).toBe(T0);
    expect(bucketOf(T0 + 900, 900)).toBe(T0 + 900);
    expect(() => aggregate([], 0)).toThrow();
  });
});
