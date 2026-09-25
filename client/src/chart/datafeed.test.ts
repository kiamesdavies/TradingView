import { describe, expect, test } from "bun:test";
import type { Bar, BarsResponse, Symbol, Timeframe } from "@eodview/shared";
import { BarsController, sanitize, type Fetcher } from "./datafeed";
import type { BarsChangeKind } from "./types";
import { formatChangePct, formatVolume, pricePrecision } from "./format";

const bar = (time: number, c = 10, v = 100): Bar => ({ time, open: c, high: c, low: c, close: c, volume: v });

interface Call {
  symbol: Symbol;
  tf: Timeframe;
  to?: number;
  resolve: (r: BarsResponse) => void;
  reject: (e: unknown) => void;
}

function manualFetcher() {
  const calls: Call[] = [];
  const fetcher: Fetcher = (symbol, tf, to) =>
    new Promise<BarsResponse>((resolve, reject) => {
      calls.push({ symbol, tf, to, resolve, reject });
    });
  return { calls, fetcher };
}

const res = (symbol: Symbol, tf: Timeframe, bars: Bar[], hasMore = true): BarsResponse => ({ symbol, tf, bars, hasMore });

describe("BarsController", () => {
  test("load emits reset twice (clear, then data)", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const kinds: [BarsChangeKind, number][] = [];
    c.onChange((b, k) => kinds.push([k, b.length]));
    const p = c.load("AAPL.US", "1D");
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(1), bar(2)]));
    expect(await p).toBe(true);
    expect(kinds).toEqual([
      ["reset", 0],
      ["reset", 2],
    ]);
    expect(c.hasMore).toBe(true);
  });

  test("stale load responses are dropped", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p1 = c.load("AAPL.US", "1D");
    const p2 = c.load("MSFT.US", "1D");
    calls[1]!.resolve(res("MSFT.US", "1D", [bar(5)]));
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(1), bar(2)]));
    expect(await p1).toBe(false);
    expect(await p2).toBe(true);
    expect(c.symbol).toBe("MSFT.US");
    expect(c.bars.map((b) => b.time)).toEqual([5]);
  });

  test("loadOlder prepends, passes `to`, and guards concurrency", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1D");
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(10), bar(20)]));
    await p;
    const kinds: BarsChangeKind[] = [];
    c.onChange((_, k) => kinds.push(k));
    const o1 = c.loadOlder();
    const o2 = c.loadOlder(); // concurrent → skipped
    expect(calls).toHaveLength(2);
    expect(calls[1]!.to).toBe(10);
    calls[1]!.resolve(res("AAPL.US", "1D", [bar(1), bar(5)], false));
    expect(await o1).toBe(2);
    expect(await o2).toBe(0);
    expect(c.bars.map((b) => b.time)).toEqual([1, 5, 10, 20]);
    expect(c.hasMore).toBe(false);
    expect(kinds).toEqual(["prepend"]);
    expect(await c.loadOlder()).toBe(0); // no more history → no request
    expect(calls).toHaveLength(2);
  });

  test("loadOlder response after a symbol change is ignored", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1D");
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(10)]));
    await p;
    const older = c.loadOlder();
    const p2 = c.load("MSFT.US", "1D");
    calls[2]!.resolve(res("MSFT.US", "1D", [bar(100)]));
    await p2;
    calls[1]!.resolve(res("AAPL.US", "1D", [bar(1)]));
    expect(await older).toBe(0);
    expect(c.bars.map((b) => b.time)).toEqual([100]);
    // and the new symbol can still backfill
    void c.loadOlder();
    expect(calls).toHaveLength(4);
  });

  test("empty backfill page stops further backfills", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1D");
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(10)]));
    await p;
    const o = c.loadOlder();
    calls[1]!.resolve(res("AAPL.US", "1D", [], true));
    expect(await o).toBe(0);
    expect(c.hasMore).toBe(false);
  });

  test("ticks and quotes fold into the last bar; other symbols ignored", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1m");
    calls[0]!.resolve(res("AAPL.US", "1m", [bar(60), bar(120, 10, 100)]));
    await p;
    const kinds: BarsChangeKind[] = [];
    c.onChange((_, k) => kinds.push(k));
    expect(c.applyTick({ symbol: "MSFT.US", price: 11, volume: 1, time: 130_000 }).kind).toBe("ignored");
    expect(c.applyTick({ symbol: "AAPL.US", price: 11, volume: 1, time: 130_000 }).kind).toBe("update");
    expect(c.bars[1]).toEqual({ time: 120, open: 10, high: 11, low: 10, close: 11, volume: 101 });
    expect(c.applyTick({ symbol: "AAPL.US", price: 12, volume: 2, time: 185_000 }).kind).toBe("append");
    expect(c.bars).toHaveLength(3);
    const q = { symbol: "AAPL.US", price: 12.5, change: 0, changePct: 0, volume: 9_999, prevClose: 10, time: 190 };
    expect(c.applyQuote(q).kind).toBe("update");
    expect(c.bars[2]).toMatchObject({ close: 12.5, volume: 2 });
    expect(kinds).toEqual(["update", "update", "update"]);
  });

  test("refreshTail merges the fresh page over the tail", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1m");
    calls[0]!.resolve(res("AAPL.US", "1m", [bar(60), bar(120), bar(180, 1)]));
    await p;
    const r = c.refreshTail();
    calls[1]!.resolve(res("AAPL.US", "1m", [bar(180, 2), bar(240), bar(300)]));
    await r;
    expect(c.bars.map((b) => [b.time, b.close])).toEqual([
      [60, 10],
      [120, 10],
      [180, 2],
      [240, 10],
      [300, 10],
    ]);
  });

  test("load failure propagates", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1D");
    calls[0]!.reject(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
    expect(c.bars).toEqual([]);
  });
});

describe("sanitize", () => {
  test("sorts, de-duplicates and drops non-finite rows", () => {
    const out = sanitize([bar(3), bar(1), { ...bar(2), close: Number.NaN }, bar(3, 11), { ...bar(4), volume: Number.NaN }]);
    expect(out.map((b) => b.time)).toEqual([1, 3, 4]);
    expect(out[1]!.close).toBe(11);
    expect(out[2]!.volume).toBe(0);
  });
});

describe("format", () => {
  test("formatVolume", () => {
    expect(formatVolume(0)).toBe("0");
    expect(formatVolume(950)).toBe("950");
    expect(formatVolume(1_234)).toBe("1.23K");
    expect(formatVolume(1_200_000)).toBe("1.2M");
    expect(formatVolume(45_600_000)).toBe("45.6M");
    expect(formatVolume(123_456_789)).toBe("123M");
    expect(formatVolume(2_000_000_000)).toBe("2B");
  });

  test("formatChangePct", () => {
    expect(formatChangePct(1.234)).toBe("+1.23%");
    expect(formatChangePct(-0.5)).toBe("-0.50%");
    expect(formatChangePct(Number.NaN)).toBe("—");
  });

  test("pricePrecision", () => {
    expect(pricePrecision("AAPL.US", [bar(1, 190)])).toBe(2);
    expect(pricePrecision("EURUSD.FOREX", [bar(1, 1.08)])).toBe(5);
    expect(pricePrecision("USDJPY.FOREX", [bar(1, 150.2)])).toBe(3);
    expect(pricePrecision("PENNY.US", [bar(1, 0.5)])).toBe(6);
    expect(pricePrecision("F.US", [bar(1, 5)])).toBe(4);
    expect(pricePrecision("SHIB-USD.CC", [bar(1, 0.00001)])).toBe(8);
    expect(pricePrecision("X.US", [])).toBe(2);
  });
});

describe("BarsController v2", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("load passes adj; fetchBars only sends it for daily+", async () => {
    const seen: (boolean | undefined)[] = [];
    const c = new BarsController(async (symbol, tf, _to, _limit, adj) => {
      seen.push(adj);
      return res(symbol, tf, [bar(1)], false);
    });
    await c.load("AAPL.US", "1D", false);
    expect(seen).toEqual([false]);
    expect(c.adjusted).toBe(false);
  });

  test("whenLoaded resolves after the matching load, false on failure", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const w = c.whenLoaded("AAPL.US", "1h");
    const p = c.load("AAPL.US", "1h");
    calls[0]!.resolve(res("AAPL.US", "1h", [bar(1)]));
    await p;
    expect(await w).toBe(true);
    expect(await c.whenLoaded("AAPL.US", "1h")).toBe(true); // already loaded

    const w2 = c.whenLoaded("AAPL.US", "5m");
    const p2 = c.load("AAPL.US", "5m").catch(() => false);
    calls[1]!.reject(new Error("boom"));
    await p2;
    expect(await w2).toBe(false);
  });

  test("ensureHistory pages back until covered, waiting for in-flight backfill", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1D");
    calls[0]!.resolve(res("AAPL.US", "1D", [bar(300), bar(400)]));
    await p;
    void c.loadOlder(); // a scroll-triggered backfill is already running
    const e = c.ensureHistory(100);
    calls[1]!.resolve(res("AAPL.US", "1D", [bar(200), bar(250)]));
    await tick();
    await tick();
    expect(calls.length).toBe(3);
    expect(calls[2]!.to).toBe(200);
    calls[2]!.resolve(res("AAPL.US", "1D", [bar(50), bar(150)]));
    expect(await e).toBe(true);
    expect(c.bars.map((b) => b.time)).toEqual([50, 150, 200, 250, 300, 400]);
  });

  test("ensureHistory stops when history runs out", async () => {
    const { calls, fetcher } = manualFetcher();
    const c = new BarsController(fetcher);
    const p = c.load("AAPL.US", "1M");
    calls[0]!.resolve(res("AAPL.US", "1M", [bar(300)]));
    await p;
    const e = c.ensureHistory(-Infinity);
    await tick();
    calls[1]!.resolve(res("AAPL.US", "1M", [bar(100)], false));
    expect(await e).toBe(true);
    expect(calls.length).toBe(2);
  });
});
