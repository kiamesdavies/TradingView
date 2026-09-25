// applyCorporateActions: failed re-pulls are retried, and a long outage checks the most recent sessions.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { recentSessions } from "./calendar";
import { ACTIONS_CATCHUP_SESSIONS, applyCorporateActions, type JobCtx } from "./jobs";
import { initUniverseSchema, kvGet, kvSet } from "./schema";
import { upsertSymbols } from "./store";

function setup(dates: string[]) {
  const db = new Database(":memory:");
  initUniverseSchema(db);
  upsertSymbols(db, [
    { symbol: "XYZ.US", code: "XYZ", name: "XYZ", exchange: "NYSE", kind: "stock", isin: null },
    { symbol: "ABC.US", code: "ABC", name: "ABC", exchange: "NYSE", kind: "stock", isin: null },
  ]);
  const ins = db.query("INSERT INTO universe_bars (symbol, date, open, high, low, close, adj_close, volume) VALUES (?, ?, 1, 1, 1, 400, 400, 1)");
  for (const d of dates) for (const s of ["XYZ.US", "ABC.US"]) ins.run(s, d);
  return db;
}

function makeCtx(db: Database, api: JobCtx["api"]): JobCtx {
  return {
    db,
    api,
    credits: { ensure: async () => {}, record: () => {} } as unknown as JobCtx["credits"],
    refreshFundamentals: async () => ({}),
    now: () => Date.UTC(2026, 8, 25, 23),
    historyDays: 30,
    progress: () => {},
    yieldNow: async () => {},
    job: "prices",
  };
}

describe("applyCorporateActions", () => {
  test("a failed re-pull is queued and retried on the next run", async () => {
    const sessions = recentSessions("2026-09-25", 6).reverse();
    const db = setup(sessions.slice(0, 5));
    const splitDay = sessions[5]!;
    kvSet(db, "actions_through", sessions[4]!);
    let fail = true;
    const eodCalls: string[] = [];
    const api: JobCtx["api"] = {
      async raw(path, params = {}) {
        if (path === "/eod-bulk-last-day/US") return params.type === "splits" && params.date === splitDay ? [{ code: "XYZ", date: splitDay, split: "4/1" }] : [];
        if (path.startsWith("/eod/")) {
          eodCalls.push(path);
          if (fail) throw Object.assign(new Error("timeout"), { status: 504 });
          return [{ date: sessions[0], close: 400, adjusted_close: 100 }];
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const ctx = makeCtx(db, api);
    await applyCorporateActions(ctx, splitDay);
    expect(eodCalls).toEqual(["/eod/XYZ.US"]);
    expect(kvGet(db, "actions_through")).toBe(splitDay);
    expect(JSON.parse(kvGet(db, "repull_pending")!)).toEqual({ "XYZ.US": { date: splitDay, attempts: 0 } });

    fail = false;
    await applyCorporateActions(ctx, splitDay); // watermark already at latest: only the retry runs
    expect(eodCalls).toEqual(["/eod/XYZ.US", "/eod/XYZ.US"]);
    expect(kvGet(db, "repull_pending")).toBeNull();
    const r = db.query<{ adj_close: number }, [string]>("SELECT adj_close FROM universe_bars WHERE symbol = 'XYZ.US' AND date = ?").get(sessions[0]!)!;
    expect(r.adj_close).toBe(100);
  });

  test("gives up after repeated failures", async () => {
    const sessions = recentSessions("2026-09-25", 3).reverse();
    const db = setup(sessions.slice(0, 2));
    kvSet(db, "actions_through", sessions[2]!);
    kvSet(db, "repull_pending", JSON.stringify({ "XYZ.US": { date: sessions[2], attempts: 0 }, "GONE.US": { date: sessions[2], attempts: 0 } }));
    let calls = 0;
    const ctx = makeCtx(db, { raw: async () => { calls++; throw Object.assign(new Error("boom"), { status: 500 }); } });
    for (let i = 0; i < 4; i++) await applyCorporateActions(ctx, sessions[2]!);
    expect(JSON.parse(kvGet(db, "repull_pending")!)).toEqual({ "XYZ.US": { date: sessions[2], attempts: 4 } }); // inactive GONE dropped
    await applyCorporateActions(ctx, sessions[2]!);
    expect(kvGet(db, "repull_pending")).toBeNull();
    expect(calls).toBe(5);
  });

  test("after a long outage the most recent sessions are the ones checked", async () => {
    const all = recentSessions("2026-09-25", 90).reverse();
    const db = setup(all.slice(0, 2));
    kvSet(db, "actions_through", all[1]!);
    const checked: string[] = [];
    const ctx = makeCtx(db, {
      async raw(path, params = {}) {
        if (params.type === "splits") checked.push(String(params.date));
        return [];
      },
    });
    const latest = all[all.length - 1]!;
    await applyCorporateActions(ctx, latest);
    expect(checked).toEqual(all.slice(-ACTIONS_CATCHUP_SESSIONS));
    expect(kvGet(db, "actions_through")).toBe(latest);
  });
});
