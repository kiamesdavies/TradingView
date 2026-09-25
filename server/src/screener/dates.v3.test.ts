// Date-relative filters (earnings / IPO / news) follow the selected market's calendar day; ALL uses UTC.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { MarketInfo } from "@eodview/shared";
import { METRICS_TABLE } from "../universe/metricsSchema";
import { todayIn, wallToUnix } from "./dates";
import { compileFilter, createScreenerEngine, dateCtx } from "./query";
import { makeColResolver, SCREENER_COLUMNS } from "./sql";

// 23:00 UTC on Sep 23 = 09:00 Sep 24 in Sydney, 19:00 Sep 23 in New York
const NOW = new Date("2026-09-23T23:00:00Z");

describe("market calendar context", () => {
  test("today and close per market; ALL = UTC; unknown = New York", () => {
    expect(dateCtx("AU", NOW)).toEqual({ today: "2026-09-24", tz: "Australia/Sydney", close: { hour: 16, minute: 10, tz: "Australia/Sydney" } });
    expect(dateCtx("US", NOW).today).toBe("2026-09-23");
    expect(dateCtx("ALL", NOW)).toMatchObject({ today: "2026-09-23", tz: "UTC" });
    expect(dateCtx("ZZ", NOW).tz).toBe("America/New_York");
    expect(todayIn(new Date("2026-09-24T22:30:00Z"), "Europe/Stockholm")).toBe("2026-09-25");
  });

  test("wallToUnix is DST-aware in any zone", () => {
    expect(wallToUnix("2026-09-24", 0, 0, "Australia/Sydney")).toBe(Date.UTC(2026, 8, 23, 14) / 1000); // AEST +10
    expect(wallToUnix("2026-10-05", 0, 0, "Australia/Sydney")).toBe(Date.UTC(2026, 9, 4, 13) / 1000); // AEDT +11
    expect(wallToUnix("2026-09-24", 17, 30, "Europe/Stockholm")).toBe(Date.UTC(2026, 8, 24, 15, 30) / 1000);
    expect(wallToUnix("2026-09-24", 16, 0, "UTC")).toBe(Date.UTC(2026, 8, 24, 16) / 1000);
  });

  test("news 'today' / 'after close' use the market's midnight and close", () => {
    const ctx = { col: makeColResolver(), now: NOW, ...dateCtx("AU", NOW) };
    expect(compileFilter({ id: "news_date", value: "today" }, ctx, () => null).params).toEqual([Date.UTC(2026, 8, 23, 14) / 1000]);
    expect(compileFilter({ id: "news_date", value: "todayafter" }, ctx, () => null).params).toEqual([Date.UTC(2026, 8, 24, 6, 10) / 1000]);
    const us = { col: makeColResolver(), now: NOW, ...dateCtx("US", NOW) };
    expect(compileFilter({ id: "news_date", value: "todayafter" }, us, () => null).params).toEqual([Date.UTC(2026, 8, 23, 20) / 1000]);
  });

  test("earnings 'today' matches each market's own day", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE ${METRICS_TABLE} (${SCREENER_COLUMNS.map((c) => `"${c.col}" ${c.type}${c.col === "symbol" ? " PRIMARY KEY" : ""}`).join(", ")})`);
    const ins = db.query(`INSERT INTO ${METRICS_TABLE} (symbol, code, kind, market, earnings_date, ipo_date, price) VALUES (?, ?, 'stock', ?, ?, ?, 1)`);
    ins.run("BHP.AU", "BHP", "AU", "2026-09-24", "2026-09-24");
    ins.run("OLD.AU", "OLD", "AU", "2026-09-23", "2026-09-23");
    ins.run("AAPL.US", "AAPL", "US", "2026-09-23", "2026-09-23");
    const mi = (code: string): MarketInfo => ({ code, name: code, country: "", currency: "", timezone: "", enabled: true, symbols: 0, withPrices: 0, withFundamentals: 0, lastPriceDate: null });
    const engine = createScreenerEngine(db, { now: () => NOW, markets: () => [mi("US"), mi("AU")] });
    const run = (market: string, id: string) =>
      engine.query({ market, universe: "all", filters: [{ id, value: "today" }], view: "overview", sort: { column: "ticker", dir: "asc" }, offset: 0, limit: 50 }).rows.map((r) => r.symbol);
    expect(run("AU", "earningsdate")).toEqual(["BHP.AU"]);
    expect(run("AU", "ipodate")).toEqual(["BHP.AU"]);
    expect(run("US", "earningsdate")).toEqual(["AAPL.US"]);
    expect(run("ALL", "earningsdate").sort()).toEqual(["AAPL.US", "OLD.AU"]); // UTC day 2026-09-23
  });
});
