// ADJ toggle: raw vs split/dividend-adjusted daily bars (mapper + cache keys).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Bar } from "@eodview/shared";
import { mapEod, type EodPeriod } from "../eodhd/mappers";
import { BarCache, dailyKey } from "./engine";

const DAY = 86400;
const LAST = Date.UTC(2024, 5, 28) / 1000;
const NOW = LAST + 20 * 3600;
const settings = { dailyTailTtlSec: 600, intradayLatestTtlSec: 60, intradayHistoryTtlSec: 3600 };

// A 2:1 split between the two rows: raw close halves, adjusted_close is continuous.
const RAW_ROWS = [
  { date: "2024-06-27", open: 200, high: 210, low: 190, close: 200, adjusted_close: 100, volume: 1000 },
  { date: "2024-06-28", open: 101, high: 105, low: 99, close: 102, adjusted_close: 102, volume: 3000 },
];

describe("mapEod adjusted flag", () => {
  test("adjusted (default) scales OHLC and volume by adjusted_close/close", () => {
    const [a, b] = mapEod(RAW_ROWS);
    expect(a).toEqual({ time: LAST - DAY, open: 100, high: 105, low: 95, close: 100, volume: 2000 });
    expect(b.close).toBe(102);
  });

  test("adjusted=false returns as-traded OHLCV", () => {
    const [a, b] = mapEod(RAW_ROWS, "d", false);
    expect(a).toEqual({ time: LAST - DAY, open: 200, high: 210, low: 190, close: 200, volume: 1000 });
    expect(b).toEqual({ time: LAST, open: 101, high: 105, low: 99, close: 102, volume: 3000 });
  });
});

describe("BarCache adj on/off", () => {
  function setup(withRaw = true) {
    const calls: string[] = [];
    const client = {
      async eod(_s: string, from?: string, _to?: string, period: EodPeriod = "d"): Promise<Bar[]> {
        calls.push(`adj:${from ?? "all"}`);
        return mapEod(RAW_ROWS, period);
      },
      async intraday(): Promise<Bar[]> {
        calls.push("intraday");
        return [];
      },
    };
    const unadjustedEod = async (_s: string, from?: string, _to?: string, period: EodPeriod = "d") => {
      calls.push(`raw:${from ?? "all"}`);
      return mapEod(RAW_ROWS, period, false);
    };
    const db = new Database(":memory:");
    const cache = new BarCache({ db, client, settings, now: () => NOW, log: () => {}, ...(withRaw ? { unadjustedEod } : {}) });
    return { cache, calls, db };
  }

  test("adjusted and raw series are cached under separate keys and do not clobber each other", async () => {
    const { cache, calls, db } = setup();
    const adj = await cache.getBars("X.US", "1D");
    const raw = await cache.getBars("X.US", "1D", undefined, 500, false);
    expect(adj.bars.map((b) => b.close)).toEqual([100, 102]);
    expect(raw.bars.map((b) => b.close)).toEqual([200, 102]);
    expect(raw.bars[0].volume).toBe(1000);
    expect(adj.bars[0].volume).toBe(2000);
    // served from SQLite on repeat
    expect((await cache.getBars("X.US", "1D")).bars[0].close).toBe(100);
    expect((await cache.getBars("X.US", "1D", undefined, 500, false)).bars[0].close).toBe(200);
    expect(calls).toEqual(["adj:all", "raw:all"]);
    const keys = db.query<{ tf: string }, []>("SELECT DISTINCT tf FROM bars_daily ORDER BY tf").all().map((r) => r.tf);
    expect(keys).toEqual(["1D", "1D:raw"]);
    expect(dailyKey("1W", false)).toBe("1W:raw");
  });

  test("intraday ignores adj", async () => {
    const { cache, calls } = setup();
    await cache.getBars("X.US", "1h", NOW, 10, false);
    expect(calls.every((c) => c === "intraday")).toBe(true);
  });

  test("without an unadjusted source, adj=0 falls back to adjusted bars", async () => {
    const { cache, calls } = setup(false);
    const r = await cache.getBars("X.US", "1D", undefined, 500, false);
    expect(r.bars[0].close).toBe(100);
    expect(calls).toEqual(["adj:all"]);
  });

  test("invalidate drops both variants", async () => {
    const { cache, calls } = setup();
    await cache.getBars("X.US", "1W");
    await cache.getBars("X.US", "1W", undefined, 500, false);
    cache.invalidate("X.US");
    await cache.getBars("X.US", "1W", undefined, 500, false);
    expect(calls).toEqual(["adj:all", "raw:all", "raw:all"]);
  });
});
