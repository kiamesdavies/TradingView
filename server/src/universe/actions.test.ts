// applyCorporateActions: affected symbols get their full history re-fetched; failures stay queued for the
// backfill; a long outage checks the most recent sessions.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { recentSessions } from "./calendar";
import { ACTIONS_CATCHUP_SESSIONS, applyCorporateActions, backfillPlan, type JobCtx } from "./jobs";
import { MARKETS } from "./markets";
import { Limiter } from "./ratelimit";
import { initUniverseSchema, kvGet, kvSet } from "./schema";
import { saveLongStats, upsertSymbols } from "./store";

function setup(dates: string[]) {
  const db = new Database(":memory:");
  initUniverseSchema(db);
  upsertSymbols(db, "US", [
    { symbol: "XYZ.US", code: "XYZ", name: "XYZ", exchange: "NYSE", kind: "stock", isin: null },
    { symbol: "ABC.US", code: "ABC", name: "ABC", exchange: "NYSE", kind: "stock", isin: null },
  ]);
  const ins = db.query("INSERT INTO universe_bars (symbol, date, open, high, low, close, adj_close, volume) VALUES (?, ?, 1, 1, 1, 400, 400, 1)");
  for (const d of dates) for (const s of ["XYZ.US", "ABC.US"]) ins.run(s, d);
  for (const s of ["XYZ.US", "ABC.US"]) {
    saveLongStats(db, s, "US", { firstDate: dates[0]!, lastDate: dates[dates.length - 1]!, rows: dates.length, ath: 404, athDate: dates[0]!, atl: 396, atlDate: dates[0]! }, dates.length, 1);
  }
  return db;
}

const NOW = Date.UTC(2026, 8, 25, 23);

function makeCtx(db: Database, api: JobCtx["api"]): JobCtx {
  return {
    db,
    api,
    credits: { ensure: async () => {}, record: () => {} } as unknown as JobCtx["credits"],
    refreshFundamentals: async () => ({}),
    now: () => NOW,
    markets: [MARKETS[0]!],
    market: MARKETS[0]!,
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
  };
}

const longRow = (db: Database, s: string) => db.query<{ status: string; attempts: number }, [string]>("SELECT status, attempts FROM universe_long WHERE symbol = ?").get(s)!;

describe("applyCorporateActions", () => {
  test("a split re-fetches the full history; a failed re-fetch is left to the backfill job", async () => {
    const sessions = recentSessions("2026-09-25", 6).reverse();
    const db = setup(sessions.slice(0, 5));
    const splitDay = sessions[5]!;
    kvSet(db, "actions_through:US", sessions[4]!);
    let fail = true;
    const eodCalls: string[] = [];
    const api: JobCtx["api"] = {
      async raw(path, params = {}) {
        if (path === "/eod-bulk-last-day/US") return params.type === "splits" && params.date === splitDay ? [{ code: "XYZ", date: splitDay, split: "4/1" }] : [];
        if (path.startsWith("/eod/")) {
          eodCalls.push(`${path}?from=${params.from}`);
          if (fail) throw Object.assign(new Error("timeout"), { status: 504 });
          return [{ date: sessions[0], close: 400, adjusted_close: 100 }];
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const ctx = makeCtx(db, api);
    await applyCorporateActions(ctx, splitDay);
    expect(eodCalls).toEqual(["/eod/XYZ.US?from=1900-01-01"]);
    expect(kvGet(db, "actions_through:US")).toBe(splitDay);
    expect(longRow(db, "XYZ.US")).toEqual({ status: "error", attempts: 1 });
    expect(longRow(db, "ABC.US")).toEqual({ status: "ok", attempts: 0 });

    // the backfill retries errors after 6 hours
    expect(backfillPlan(ctx, "US").todo).toEqual([]);
    const later = { ...ctx, now: () => NOW + 7 * 3600_000 };
    expect(backfillPlan(later, "US").todo).toEqual(["XYZ.US"]);

    fail = false;
    kvSet(db, "actions_through:US", sessions[4]!);
    await applyCorporateActions(ctx, splitDay);
    expect(longRow(db, "XYZ.US")).toEqual({ status: "ok", attempts: 0 });
    const r = db.query<{ adj_close: number }, [string]>("SELECT adj_close FROM universe_bars WHERE symbol = 'XYZ.US' AND date = ?").get(sessions[0]!)!;
    expect(r.adj_close).toBe(100);
  });

  test("after a long outage the most recent sessions are the ones checked", async () => {
    const all = recentSessions("2026-09-25", 90).reverse();
    const db = setup(all.slice(0, 2));
    kvSet(db, "actions_through:US", all[1]!);
    const checked: string[] = [];
    const ctx = makeCtx(db, {
      async raw(_path, params = {}) {
        if (params.type === "splits") checked.push(String(params.date));
        return [];
      },
    });
    const latest = all[all.length - 1]!;
    await applyCorporateActions(ctx, latest);
    expect(checked).toEqual(all.slice(-ACTIONS_CATCHUP_SESSIONS));
    expect(kvGet(db, "actions_through:US")).toBe(latest);
  });
});
