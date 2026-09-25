// Credit reserve for low-priority jobs, periodic history refresh, small-split detection, per-symbol fundamentals
// failures and the partial-session re-check cap.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BudgetExhausted, CreditGuard } from "./credits";
import {
  backfillPlan, creditKeep, DEFAULT_LOW_PRIORITY_RESERVE, fundamentalsQueue, isGlobalFundamentalsError, PARTIAL_RECHECKS,
  runFundamentals, runPrices, type JobCtx,
} from "./jobs";
import { HISTORY_REFRESH_SEC, isDue, refreshSlotStart, splitSuspects, type BackfillCandidate } from "./longstats";
import { getMarket, MARKETS } from "./markets";
import { Limiter } from "./ratelimit";
import { initUniverseSchema, kvGet } from "./schema";
import { saveLongStats, upsertSymbols } from "./store";

const US = MARKETS[0]!;
const ST = getMarket("ST")!;

function makeCtx(db: Database, over: Partial<JobCtx> = {}): JobCtx {
  return {
    db,
    api: { raw: async (p: string) => { throw new Error(`unexpected ${p}`); } },
    credits: { ensure: async () => {}, record: () => {} } as unknown as JobCtx["credits"],
    refreshFundamentals: async () => ({}),
    now: () => Date.UTC(2026, 8, 25, 12),
    markets: [US],
    market: US,
    historyYears: 5,
    backfillMaxSymbols: null,
    fundamentalsMaxPerRun: 500,
    bulkActionMarkets: new Set(["US"]),
    limiter: new Limiter({ ratePerMin: 1e9, concurrency: 4 }),
    retry: { retries: 0 },
    progress: () => {},
    yieldNow: async () => {},
    job: "prices",
    jobKey: "prices:US",
    ...over,
  };
}

function stocks(db: Database, market: string, codes: string[]) {
  upsertSymbols(db, market, codes.map((c) => ({ symbol: `${c}.${market}`, code: c, name: c, exchange: market, kind: "stock" as const, isin: null })));
}

describe("credit reserve for backfill / fundamentals", () => {
  test("ensure(cost, keep) leaves `keep` credits of the budget unused", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    const g = new CreditGuard(db, { budget: 40000, now: () => 0 });
    g.record("fundamentals:US", 37_500);
    await g.ensure(10); // prices: may use the rest
    const e = await g.ensure(10, 3000).catch((x) => x);
    expect(e).toBeInstanceOf(BudgetExhausted);
    expect((e as Error).message).toContain("3000 kept");
    await g.ensure(10, 2000); // 37510 + 10 <= 38000
  });

  test("the account-level check keeps the reserve too", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    const g = new CreditGuard(db, { budget: 1e9, reserve: 15000, getUsage: async () => ({ apiRequests: 83_000, dailyRateLimit: 100_000 }), now: () => 0 });
    await g.ensure(100); // 83100 <= 85000
    expect(await g.ensure(100, 3000).catch((x) => x)).toBeInstanceOf(BudgetExhausted); // > 82000
  });

  test("only backfill and fundamentals keep the reserve (re-fetches run by prices do not)", () => {
    expect(creditKeep({ job: "backfill" })).toBe(DEFAULT_LOW_PRIORITY_RESERVE);
    expect(creditKeep({ job: "fundamentals", lowPriorityReserve: 500 })).toBe(500);
    expect(creditKeep({ job: "prices", lowPriorityReserve: 500 })).toBe(0);
    expect(creditKeep({ job: "fx" })).toBe(0);
  });

  test("runFundamentals asks the guard with the reserve", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    stocks(db, "US", ["A"]);
    const keeps: number[] = [];
    const ctx = makeCtx(db, {
      job: "fundamentals", jobKey: "fundamentals", lowPriorityReserve: 1234,
      credits: { ensure: async (_c: number, keep = 0) => { keeps.push(keep); }, record: () => {} } as unknown as JobCtx["credits"],
      refreshFundamentals: async () => ({ General: { Type: "Common Stock" } }),
    });
    await runFundamentals(ctx);
    expect(keeps).toEqual([1234]);
  });
});

describe("periodic history refresh (markets without the bulk actions feed)", () => {
  const cand = (symbol: string, fetchedAt: number): BackfillCandidate => ({ symbol, dollarVolumeUsd: 1, status: "ok", fetchedAt, attempts: 0 });

  test("each 'ok' history is due once per period, spread evenly over the days", () => {
    const t0 = 1_800_000_000, day = 86400;
    const syms = Array.from({ length: 6000 }, (_, i) => `S${i}.ST`);
    const fetched = new Map(syms.map((s) => [s, t0]));
    const perDay: number[] = [];
    for (let d = 1; d <= 120; d++) {
      const now = t0 + d * day;
      let n = 0;
      for (const s of syms) {
        if (isDue(cand(s, fetched.get(s)!), { nowSec: now, cap: null, limit: 1e9, refreshSec: HISTORY_REFRESH_SEC })) {
          n++;
          fetched.set(s, now); // re-fetched
        }
      }
      perDay.push(n);
    }
    // 6000 symbols / 60 days = 100 a day, every day, in both periods
    expect(perDay.reduce((a, b) => a + b, 0)).toBe(12_000);
    expect(Math.min(...perDay)).toBeGreaterThan(50);
    expect(Math.max(...perDay)).toBeLessThan(160);
    // no refresh without refreshSec (bulk-feed markets)
    expect(isDue(cand("S1.ST", t0), { nowSec: t0 + 400 * day, cap: null, limit: 10 })).toBe(false);
  });

  test("slot start is at most one period back and stable per symbol", () => {
    const now = 1_800_000_000;
    const a = refreshSlotStart("VOLV-B.ST", now, HISTORY_REFRESH_SEC);
    expect(a).toBeLessThanOrEqual(now);
    expect(now - a).toBeLessThan(HISTORY_REFRESH_SEC);
    expect(refreshSlotStart("VOLV-B.ST", now + HISTORY_REFRESH_SEC, HISTORY_REFRESH_SEC)).toBe(a + HISTORY_REFRESH_SEC);
  });

  test("backfillPlan refreshes ST histories after new symbols, but never US (bulk split/dividend feed)", () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    stocks(db, "ST", ["OLD", "NEW"]);
    stocks(db, "US", ["USO"]);
    const stats = { firstDate: "2000-01-03", lastDate: "2026-01-02", rows: 100, ath: 2, athDate: "2020-01-02", atl: 1, atlDate: "2001-01-02" };
    const longAgo = Math.floor(Date.UTC(2025, 0, 1) / 1000);
    saveLongStats(db, "OLD.ST", "ST", stats, 100, longAgo);
    saveLongStats(db, "USO.US", "US", stats, 100, longAgo);
    const ctx = makeCtx(db, { market: ST });
    expect(backfillPlan(ctx, "ST").todo).toEqual(["NEW.ST", "OLD.ST"]);
    expect(backfillPlan(ctx, "US").todo).toEqual([]);
    expect(backfillPlan({ ...ctx, bulkActionMarkets: new Set(["US", "ST"]) }, "ST").todo).toEqual(["NEW.ST"]);
  });
});

describe("split suspects", () => {
  const flat = (n: number, r = 1) => Array.from({ length: n }, (_, i) => ({ symbol: `F${i}`, prev: 100, close: 100 * r * (1 + ((i % 5) - 2) / 1000) }));
  const run = (rows: Array<{ symbol: string; prev: number; close: number }>) =>
    splitSuspects(new Map(rows.map((r) => [r.symbol, r.prev])), rows.map((r) => ({ symbol: r.symbol, close: r.close })));

  test("3:2 and 5:4 splits (and reverses) are caught; ordinary moves are not", () => {
    const got = run([
      ...flat(40),
      { symbol: "THREE2", prev: 90, close: 60.2 }, // 3-for-2 plus a small move
      { symbol: "FIVE4", prev: 100, close: 80.5 }, // 5-for-4
      { symbol: "REV32", prev: 60, close: 90 }, // 2-for-3 reverse
      { symbol: "DOWN10", prev: 100, close: 90 },
      { symbol: "DOWN28", prev: 100, close: 72 }, // between the 3:2 and 4:3 factors
      { symbol: "UP12", prev: 100, close: 112 },
      { symbol: "TWO1", prev: 100, close: 50 }, // large split: always
    ]);
    expect(new Set(got)).toEqual(new Set(["THREE2", "FIVE4", "REV32", "TWO1"]));
  });

  test("a market-wide move is not a split (ratios are relative to the market's median)", () => {
    const got = run([...flat(40, 0.8), { symbol: "SAME", prev: 100, close: 80 }, { symbol: "HALF", prev: 100, close: 40 }]);
    expect(got).toEqual(["HALF"]);
  });
});

describe("fundamentals: per-symbol failures back off, only global errors end the slice", () => {
  const err = (status: number, upstreamStatus?: number, code?: string) => Object.assign(new Error(`e${status}`), { status, upstreamStatus, code });

  test("classification", () => {
    expect(isGlobalFundamentalsError(err(502, 401, "unauthorized"))).toBe(true);
    expect(isGlobalFundamentalsError(err(429, 429, "rate_limited"))).toBe(true);
    expect(isGlobalFundamentalsError(err(502, undefined, "network"))).toBe(true); // unreachable
    expect(isGlobalFundamentalsError(err(503, undefined, "no_key"))).toBe(true);
    expect(isGlobalFundamentalsError(err(504, undefined, "network"))).toBe(false); // one slow payload
    expect(isGlobalFundamentalsError(err(502, 500, "upstream"))).toBe(false);
    expect(isGlobalFundamentalsError(err(402, 402, "plan"))).toBe(false);
  });

  test("a failing symbol is skipped until its retry time; the rest of the queue proceeds", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    stocks(db, "US", ["BAD", "GOOD1", "GOOD2"]);
    let now = Date.UTC(2026, 8, 25, 12);
    const calls: string[] = [];
    const ctx = makeCtx(db, {
      job: "fundamentals", jobKey: "fundamentals", now: () => now,
      refreshFundamentals: async (s) => {
        calls.push(s);
        if (s === "BAD.US") throw err(502, 500, "upstream");
        return { General: { Type: "Common Stock" } };
      },
    });
    const r = await runFundamentals(ctx);
    expect(r.note).toContain("1 failed (retry later)");
    expect(calls.sort()).toEqual(["BAD.US", "GOOD1.US", "GOOD2.US"]);
    const q = (t: number) => fundamentalsQueue(db, t, "2026-09-25", 10, ["US"]);
    expect(q(now)).toEqual([]); // BAD waits an hour
    expect(q(now + 3601_000)).toEqual(["BAD.US"]);

    // second failure doubles the wait
    now += 3601_000;
    await runFundamentals(ctx);
    const row = db.query<{ attempts: number; retry_at: number }, []>("SELECT attempts, retry_at FROM universe_fund_retry").get()!;
    expect(row.attempts).toBe(2);
    expect(row.retry_at - Math.floor(now / 1000)).toBe(7200);
  });

  test("a rejected key ends the slice", async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    stocks(db, "US", ["A", "B"]);
    const ctx = makeCtx(db, { job: "fundamentals", jobKey: "fundamentals", refreshFundamentals: async () => { throw err(502, 401, "unauthorized"); } });
    expect(await runFundamentals(ctx).catch((e) => (e as Error).message)).toBe("e502");
    expect(db.query("SELECT 1 FROM universe_fund_retry").get()).toBeNull();
  });
});

describe("partial sessions", () => {
  test(`re-checked at most ${PARTIAL_RECHECKS} times, then accepted`, async () => {
    const db = new Database(":memory:");
    initUniverseSchema(db);
    const codes = Array.from({ length: 10 }, (_, i) => `C${i}`);
    stocks(db, "US", codes);
    db.query("INSERT INTO universe_sessions (market, date, rows, fetched_at) VALUES ('US', '2026-09-23', 10, 1)").run();
    let bulkCalls = 0;
    const now = Date.UTC(2026, 8, 25, 3); // 23:00 New York on the 24th: session 2026-09-24 expected
    const ctx = makeCtx(db, {
      now: () => now,
      api: {
        async raw(path, params = {}) {
          if (path === "/eod-bulk-last-day/US" && !params.type) {
            bulkCalls++;
            return codes.slice(0, 7).map((code) => ({ code, date: "2026-09-24", open: 10, high: 10, low: 10, close: 10, adjusted_close: 10, volume: 1 }));
          }
          return [];
        },
      },
    });
    for (let i = 1; i <= PARTIAL_RECHECKS; i++) {
      const r = await runPrices(ctx);
      expect(r.note).toContain(`re-check ${i}/${PARTIAL_RECHECKS}`);
      expect(r.nextRunAt).toBe(now + 3600_000);
    }
    const last = await runPrices(ctx);
    expect(last.note).toContain("accepted");
    expect(last.nextRunAt).toBeGreaterThan(now + 12 * 3600_000); // the next session's attempt
    expect(bulkCalls).toBe(PARTIAL_RECHECKS + 1);
    expect(kvGet(db, "prices_partial:US")).toBe(`2026-09-24:${PARTIAL_RECHECKS}`);
  });
});
