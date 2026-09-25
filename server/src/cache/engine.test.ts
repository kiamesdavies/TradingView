import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Bar } from "@eodview/shared";
import type { EodPeriod, IntradayInterval } from "../eodhd/mappers";
import { EodhdError } from "../eodhd/request";
import { BarCache, WINDOW_SEC, tailFrom } from "./engine";

const DAY = 86400;
const settings = { dailyTailTtlSec: 600, intradayLatestTtlSec: 60, intradayHistoryTtlSec: 3600 };
const b = (time: number, close: number, volume = 1): Bar => ({ time, open: close, high: close, low: close, close, volume });

/** Daily series of n bars ending at `lastDay`, close = index. */
const dailySeries = (lastDay: number, n: number, scale = 1) =>
  Array.from({ length: n }, (_, i) => b(lastDay - (n - 1 - i) * DAY, (i + 1) * scale));

function fakeClient(opts: {
  eod?: (symbol: string, from: string | undefined, period: EodPeriod) => Bar[] | Promise<Bar[]>;
  intraday?: (symbol: string, interval: IntradayInterval, from: number, to: number) => Bar[] | Promise<Bar[]>;
}) {
  const calls = { eod: [] as (string | undefined)[], intraday: [] as number[] };
  return {
    calls,
    client: {
      async eod(symbol: string, from?: string, _to?: string, period: EodPeriod = "d") {
        calls.eod.push(from);
        return opts.eod ? opts.eod(symbol, from, period) : [];
      },
      async intraday(symbol: string, interval: IntradayInterval, from?: number, to?: number) {
        calls.intraday.push(from!);
        return opts.intraday ? opts.intraday(symbol, interval, from!, to!) : [];
      },
    },
  };
}

function setup(client: ReturnType<typeof fakeClient>["client"], start: number) {
  let clock = start;
  const cache = new BarCache({ db: new Database(":memory:"), client, settings, now: () => clock, log: () => {} });
  return { cache, tick: (s: number) => (clock += s), setClock: (t: number) => (clock = t) };
}

describe("daily cache", () => {
  const LAST = Date.UTC(2024, 5, 28) / 1000;
  const NOW = LAST + 20 * 3600;

  test("first call fetches full history once; pagination by `to` is served from SQLite", async () => {
    const hist = dailySeries(LAST, 1200);
    const f = fakeClient({ eod: () => hist });
    const { cache } = setup(f.client, NOW);

    const r1 = await cache.getBars("aapl.us", "1D", undefined, 500);
    expect(r1.symbol).toBe("AAPL.US");
    expect(r1.bars).toHaveLength(500);
    expect(r1.bars.at(-1)!.time).toBe(LAST);
    expect(r1.hasMore).toBe(true);
    expect(f.calls.eod).toEqual([undefined]);

    const r2 = await cache.getBars("AAPL.US", "1D", r1.bars[0].time, 500);
    expect(r2.bars.at(-1)!.time).toBe(r1.bars[0].time - DAY);
    const r3 = await cache.getBars("AAPL.US", "1D", r2.bars[0].time, 500);
    expect(r3.bars).toHaveLength(200);
    expect(r3.hasMore).toBe(false);
    expect(r3.bars[0].time).toBe(hist[0].time);
    expect(f.calls.eod).toHaveLength(1);
  });

  test("tail refresh after TTL fetches only recent bars and upserts", async () => {
    let hist = dailySeries(LAST, 50);
    const f = fakeClient({
      eod: (_s, from) => (from ? hist.filter((x) => x.time >= Date.parse(from) / 1000) : hist),
    });
    const { cache, tick } = setup(f.client, NOW);
    await cache.getBars("X.US", "1D");
    tick(300);
    await cache.getBars("X.US", "1D");
    expect(f.calls.eod).toHaveLength(1); // still fresh

    hist = [...hist.slice(0, -1), b(LAST, 999), b(LAST + DAY, 51)]; // today's bar updated + a new bar
    tick(400);
    const r = await cache.getBars("X.US", "1D", undefined, 3);
    expect(f.calls.eod).toEqual([undefined, new Date((LAST - 7 * DAY) * 1000).toISOString().slice(0, 10)]);
    expect(r.bars.map((x) => x.close)).toEqual([49, 999, 51]);

    // older pages never trigger a refresh
    tick(10_000);
    await cache.getBars("X.US", "1D", LAST - 10 * DAY, 5);
    expect(f.calls.eod).toHaveLength(2);
  });

  test("changed adjusted history (split/dividend) triggers full refetch", async () => {
    let hist = dailySeries(LAST, 30);
    const f = fakeClient({ eod: (_s, from) => (from ? hist.filter((x) => x.time >= Date.parse(from) / 1000) : hist) });
    const { cache, tick } = setup(f.client, NOW);
    await cache.getBars("X.US", "1D");
    hist = dailySeries(LAST, 30, 0.5); // whole history re-based
    tick(700);
    const r = await cache.getBars("X.US", "1D", undefined, 30);
    expect(f.calls.eod).toHaveLength(3); // initial, tail, full refetch
    expect(r.bars[0].close).toBe(0.5);
    expect(r.bars).toHaveLength(30);
  });

  test("refresh failure serves stale data; no cache → error propagates", async () => {
    let fail = false;
    const f = fakeClient({
      eod: () => {
        if (fail) throw new EodhdError(429, "EODHD rate limit reached; try again later", "rate_limited", 429);
        return dailySeries(LAST, 10);
      },
    });
    const { cache, tick } = setup(f.client, NOW);
    await cache.getBars("X.US", "1D");
    fail = true;
    tick(700);
    expect((await cache.getBars("X.US", "1D")).bars).toHaveLength(10);
    await cache.getBars("X.US", "1D"); // within backoff: no new upstream call
    expect(f.calls.eod).toHaveLength(2);
    await expect(cache.getBars("Y.US", "1D")).rejects.toMatchObject({ status: 429 });
  });

  test("concurrent first loads share one upstream request", async () => {
    const f = fakeClient({ eod: async () => { await Bun.sleep(5); return dailySeries(LAST, 10); } });
    const { cache } = setup(f.client, NOW);
    await Promise.all([cache.getBars("X.US", "1D"), cache.getBars("X.US", "1D"), cache.getBars("x.us", "1D")]);
    expect(f.calls.eod).toHaveLength(1);
  });

  test("unknown symbol with empty history → no bars, hasMore false", async () => {
    const f = fakeClient({ eod: () => [] });
    const { cache } = setup(f.client, NOW);
    expect(await cache.getBars("NONE.US", "1W")).toEqual({ symbol: "NONE.US", tf: "1W", bars: [], hasMore: false });
  });

  test("tailFrom aligns weekly to Mondays and monthly to month starts", () => {
    const mon = Date.UTC(2024, 5, 24) / 1000;
    expect(tailFrom(mon, "w")).toBe(Date.UTC(2024, 5, 10) / 1000);
    expect(tailFrom(Date.UTC(2024, 0, 1) / 1000, "m")).toBe(Date.UTC(2023, 10, 1) / 1000);
  });
});

describe("intraday cache", () => {
  // Synthetic 5m feed: a bar every 5 minutes between 13:30 and 20:00 UTC on weekdays after START_DATA.
  const START_DATA = Date.UTC(2024, 0, 1) / 1000;
  const NOW = Date.UTC(2024, 2, 1, 18, 2) / 1000; // Fri 18:02 UTC
  function fiveMin(from: number, to: number): Bar[] {
    const out: Bar[] = [];
    for (let t = Math.ceil(from / 300) * 300; t <= to && t <= NOW - 300; t += 300) {
      if (t < START_DATA) continue;
      const tod = t % DAY;
      const dow = (Math.floor(t / DAY) + 3) % 7;
      if (dow < 5 && tod >= 13.5 * 3600 && tod < 20 * 3600) out.push(b(t, t / 300, 10));
    }
    return out;
  }

  test("latest 15m bars are aggregated from 5m windows and strictly ascending", async () => {
    const f = fakeClient({ intraday: (_s, _i, from, to) => fiveMin(from, to) });
    const { cache } = setup(f.client, NOW);
    const r = await cache.getBars("AAPL.US", "15m", undefined, 100);
    expect(r.bars).toHaveLength(100);
    expect(r.hasMore).toBe(true);
    for (let i = 1; i < r.bars.length; i++) expect(r.bars[i].time).toBeGreaterThan(r.bars[i - 1].time);
    for (const x of r.bars) expect(x.time % 900).toBe(0);
    const last = r.bars.at(-1)!;
    expect(last.time).toBe(Date.UTC(2024, 2, 1, 17, 45) / 1000); // partial live bucket (17:45, 17:50, 17:55)
    expect(last.volume).toBe(30);
    // every requested window is aligned and within EODHD limits
    for (const from of f.calls.intraday) expect(from % WINDOW_SEC["5m"]).toBe(0);
  });

  test("backfill with `to` returns bars strictly before it; hitting data start → hasMore false", async () => {
    const f = fakeClient({ intraday: (_s, _i, from, to) => fiveMin(from, to) });
    const { cache } = setup(f.client, NOW);
    const to = Date.UTC(2024, 0, 3, 15, 0) / 1000;
    const r = await cache.getBars("AAPL.US", "5m", to, 1000);
    expect(r.bars.at(-1)!.time).toBe(to - 300);
    expect(r.bars[0].time).toBe(Date.UTC(2024, 0, 1, 13, 30) / 1000);
    expect(r.hasMore).toBe(false);
  });

  test("4h buckets from 1h on UTC 4h boundaries", async () => {
    const f = fakeClient({
      intraday: (_s, _i, from, to) => fiveMin(from, to).filter((x) => x.time % 3600 === 0 || x.time % 3600 === 1800 && x.time % DAY === 13.5 * 3600),
    });
    const { cache } = setup(f.client, NOW);
    const r = await cache.getBars("AAPL.US", "4h", undefined, 10);
    for (const x of r.bars) expect(x.time % (4 * 3600)).toBe(0);
    expect(r.bars).toHaveLength(10);
  });

  test("windows are cached: latest with short TTL, history longer", async () => {
    const f = fakeClient({ intraday: (_s, _i, from, to) => fiveMin(from, to) });
    const { cache, tick } = setup(f.client, NOW);
    await cache.getBars("AAPL.US", "5m", undefined, 50);
    const n1 = f.calls.intraday.length;
    await cache.getBars("AAPL.US", "5m", undefined, 50);
    expect(f.calls.intraday.length).toBe(n1);
    tick(61);
    await cache.getBars("AAPL.US", "5m", undefined, 50);
    expect(f.calls.intraday.length).toBe(n1 + 1); // only the latest window refetched
  });

  test("symbol without intraday data stops after an empty run", async () => {
    const f = fakeClient({ intraday: () => [] });
    const { cache } = setup(f.client, NOW);
    const r = await cache.getBars("NONE.XETRA", "1m");
    expect(r).toEqual({ symbol: "NONE.XETRA", tf: "1m", bars: [], hasMore: false });
    // empty-run windows + one "latest data" probe
    expect(f.calls.intraday.length).toBe(Math.ceil((14 * DAY) / WINDOW_SEC["1m"]) + 1);
    await cache.getBars("NONE.XETRA", "1m");
    expect(f.calls.intraday.length).toBe(Math.ceil((14 * DAY) / WINDOW_SEC["1m"]) + 1); // all cached
  });
});

describe("stale intraday feed", () => {
  test("empty recent windows → probe finds where data ends and walks back from there", async () => {
    const NOW = Date.UTC(2024, 8, 25, 12) / 1000;
    const dataEnd = NOW - 60 * DAY;
    const data: Bar[] = [];
    for (let t = dataEnd - 10 * DAY; t < dataEnd; t += 60) data.push(b(Math.floor(t / 60) * 60, 1));
    const f = fakeClient({ intraday: (_s, _i, from, to) => data.filter((x) => x.time >= from && x.time <= to) });
    const { cache } = setup(f.client, NOW);
    const r = await cache.getBars("BTC-USD.CC", "1m", undefined, 500);
    expect(r.bars).toHaveLength(500);
    expect(r.hasMore).toBe(true);
    expect(r.bars.at(-1)!.time).toBe(data.at(-1)!.time);
    const calls = f.calls.intraday.length;
    await cache.getBars("BTC-USD.CC", "1m", undefined, 500); // hint + windows cached
    expect(f.calls.intraday.length).toBe(calls);
  });
});
