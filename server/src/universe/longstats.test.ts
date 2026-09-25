import { describe, expect, test } from "bun:test";
import { computeLongStats, extendExtremes, isDue, planBackfill, retentionCutoff, splitSuspects, type BackfillCandidate } from "./longstats";
import type { EodRow } from "./store";

const r = (date: string, close: number, adj = close, hi = close * 1.01, lo = close * 0.99): EodRow => ({
  date, open: close, high: hi, low: lo, close, adjClose: adj, volume: 1,
});

describe("long stats", () => {
  test("ATH/ATL on the adjusted basis (AAPL-like 4:1 split)", () => {
    const rows = [
      r("2020-08-28", 499.23, 120.9557, 505.77, 498.31), // pre-split raw
      r("2021-01-04", 129.41, 126.5),
      r("2026-09-24", 335.92, 335.92, 338.91, 334.3),
    ];
    const s = computeLongStats(rows)!;
    expect(s.firstDate).toBe("2020-08-28");
    expect(s.lastDate).toBe("2026-09-24");
    expect(s.rows).toBe(3);
    expect(s.ath).toBeCloseTo(338.91, 6);
    expect(s.athDate).toBe("2026-09-24");
    expect(s.atl).toBeCloseTo(498.31 * (120.9557 / 499.23), 6); // ≈ 120.7, not 498
    expect(s.atlDate).toBe("2020-08-28");
  });

  test("bad ticks are capped at the bar body; empty history → null", () => {
    const s = computeLongStats([r("2024-01-02", 10), r("2024-01-03", 11, 11, 500, 0.001), r("2024-01-04", 10.5)])!;
    expect(s.ath).toBe(11); // the 500 high is capped at the body top
    expect(s.atl).toBeCloseTo(9.9, 9);
    expect(computeLongStats([])).toBeNull();
    expect(computeLongStats([{ ...r("2024-01-02", 0), close: 0 }])).toBeNull();
  });

  test("extremes extended by bars after the stats' last date, scaled to the latest basis", () => {
    const stats = { ath: 100, athDate: "2021-01-04", atl: 5, atlDate: "2009-03-09", lastDate: "2026-09-01" };
    const e = extendExtremes(stats, ["2026-08-31", "2026-09-02", "2026-09-03"], [500, 90, 101], [1, 80, 90], 1)!;
    expect(e).toEqual({ ath: 101, athDate: "2026-09-03", atl: 5, atlDate: "2009-03-09" }); // 08-31 is already in the stats
    expect(extendExtremes(stats, [], [], [], 2)).toEqual({ ath: 200, athDate: "2021-01-04", atl: 10, atlDate: "2009-03-09" });
    expect(extendExtremes(null, ["2026-09-02"], [1], [1])).toBeNull();
  });

  test("retention cutoff", () => {
    expect(retentionCutoff("2026-09-25", 5)).toBe("2021-09-15");
    expect(retentionCutoff("2026-09-25", 2)).toBe("2024-09-14");
  });
});

describe("backfill planner", () => {
  const now = 1_800_000_000;
  const c = (symbol: string, dv: number | null, status: BackfillCandidate["status"] = null, fetchedAt: number | null = null, attempts = 0): BackfillCandidate =>
    ({ symbol, dollarVolumeUsd: dv, status, fetchedAt, attempts });

  test("due rules", () => {
    const o = { nowSec: now, cap: null, limit: 10 };
    expect(isDue(c("A", 1), o)).toBe(true);
    expect(isDue(c("A", 1, "ok", now - 1e7), o)).toBe(false);
    expect(isDue(c("A", 1, "stale", now), o)).toBe(true);
    expect(isDue(c("A", 1, "error", now - 3600, 1), o)).toBe(false); // retry after 6 h
    expect(isDue(c("A", 1, "error", now - 7 * 3600, 1), o)).toBe(true);
    expect(isDue(c("A", 1, "error", now - 7 * 3600, 5), o)).toBe(false); // gave up
    expect(isDue(c("A", 1, "nodata", now - 86400), o)).toBe(false);
    expect(isDue(c("A", 1, "nodata", now - 31 * 86400), o)).toBe(true);
  });

  test("order: stale first, then USD dollar volume, then symbol; resumable", () => {
    const cands = [c("LOW", 1), c("NULL", null), c("HIGH", 1e9), c("DONE", 5e9, "ok", now), c("SPLIT", 2, "stale", now), c("B", 1), c("A", 1)];
    const p = planBackfill(cands, { nowSec: now, cap: null, limit: 4 });
    expect(p.todo).toEqual(["SPLIT", "HIGH", "A", "B"]);
    expect(p.remaining).toBe(2);
    expect(p.done).toBe(1);
    expect(p.capped).toBe(false);
  });

  test("per-market cap counts attempted symbols; re-fetches don't consume it", () => {
    const cands = [c("DONE", 9, "ok", now), c("SPLIT", 8, "stale", now), c("N1", 7), c("N2", 6), c("N3", 5)];
    const p = planBackfill(cands, { nowSec: now, cap: 3, limit: 10 });
    expect(p.todo).toEqual(["SPLIT", "N1"]); // DONE + SPLIT already count; room for one new
    expect(p.capped).toBe(true);
    expect(p.remaining).toBe(0);
    const q = planBackfill(cands, { nowSec: now, cap: 3, limit: 1 });
    expect(q.todo).toEqual(["SPLIT"]);
    expect(q.remaining).toBe(1);
  });
});

describe("split suspects", () => {
  test("split-like close ratios vs the previous stored close, largest first, capped", () => {
    const prev = new Map([["A", 100], ["B", 100], ["C", 100], ["D", 100], ["E", 0]]);
    const today = [
      { symbol: "A", close: 50 }, // 2:1 split
      { symbol: "B", close: 1000 }, // 1:10 reverse
      { symbol: "C", close: 120 }, // normal move
      { symbol: "D", close: 60 }, // -40%: below the threshold
      { symbol: "E", close: 5 },
      { symbol: "NEW", close: 5 },
    ];
    expect(splitSuspects(prev, today)).toEqual(["B", "A"]);
    expect(splitSuspects(prev, today, { max: 1 })).toEqual(["B"]);
  });
});
