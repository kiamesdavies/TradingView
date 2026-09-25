import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { computeCoverage, coverageQuery, toFractions, VersionedCache } from "./coverage";
import { initUniverseSchema } from "./schema";

describe("market coverage", () => {
  const db = new Database(":memory:");
  initUniverseSchema(db);
  const ins = db.query("INSERT INTO universe_metrics (symbol, market, price, pe, ath) VALUES (?, ?, ?, ?, ?)");
  ins.run("A.US", "US", 10, 5, 12);
  ins.run("B.US", "US", 10, null, 11);
  ins.run("C.US", "US", 10, null, null);
  ins.run("D.US", "US", null, 7, 1); // no price → not counted
  ins.run("E.ST", "ST", 10, null, 20);

  test("fraction of non-null values among priced symbols", () => {
    const us = computeCoverage(db, ["US"]);
    expect(us.price).toBe(1);
    expect(us.pe).toBeCloseTo(1 / 3, 4);
    expect(us.ath).toBeCloseTo(2 / 3, 4);
    expect(us.symbol).toBe(1);
    const st = computeCoverage(db, ["ST"]);
    expect(st.pe).toBe(0);
    expect(st.ath).toBe(1);
    const all = computeCoverage(db, ["US", "ST"]);
    expect(all.ath).toBe(0.75);
    const none = computeCoverage(db, ["LSE"]);
    expect(none.price).toBe(0);
    expect(computeCoverage(db, []).price).toBe(0);
  });

  test("query binds market codes", () => {
    const q = coverageQuery(["US", "ST"]);
    expect(q.params).toEqual(["US", "ST"]);
    expect(q.sql).toContain("market IN (?, ?)");
    expect(toFractions(null).pe).toBe(0);
  });

  test("cache: TTL and version invalidation", () => {
    let version = 1, t = 0, computed = 0;
    const cache = new VersionedCache<number>(600_000, () => version, () => t);
    const get = () => cache.get("US", () => ++computed);
    expect(get()).toBe(1);
    expect(get()).toBe(1);
    t = 600_001;
    expect(get()).toBe(2);
    version = 2;
    expect(get()).toBe(3);
  });
});
