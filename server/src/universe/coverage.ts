// Per-market metric coverage (fraction of non-null values per universe_metrics column among a market's
// symbols that have a price). Pure SQL building + a small TTL cache; see coverage.test.ts.
import type { Database } from "bun:sqlite";
import { METRIC_COLUMNS, METRICS_TABLE } from "./metricsSchema";

const COLS = METRIC_COLUMNS.map((c) => c.col);

/** One aggregate query: n + COUNT(col) per column, for one market or all of `markets`. */
export function coverageQuery(markets: string[]): { sql: string; params: string[] } {
  const counts = COLS.map((c, i) => `COUNT("${c}") AS c${i}`).join(", ");
  const where = markets.length === 1 ? `market = ?` : `market IN (${markets.map(() => "?").join(", ")})`;
  return { sql: `SELECT COUNT(*) AS n, ${counts} FROM ${METRICS_TABLE} WHERE price IS NOT NULL AND ${markets.length ? where : "1"}`, params: markets };
}

/** Aggregate row → column → fraction in [0, 1] (all 0 when the market has no priced symbols). */
export function toFractions(row: Record<string, number> | null | undefined): Record<string, number> {
  const n = row?.n ?? 0;
  const out: Record<string, number> = {};
  COLS.forEach((c, i) => {
    const k = row?.[`c${i}`] ?? 0;
    out[c] = n > 0 ? Math.round((k / n) * 10000) / 10000 : 0;
  });
  return out;
}

export function computeCoverage(db: Database, markets: string[]): Record<string, number> {
  if (!markets.length) return toFractions(null);
  const { sql, params } = coverageQuery(markets);
  return toFractions(db.query<Record<string, number>, string[]>(sql).get(...params));
}

/** Tiny TTL cache that is also invalidated when `version()` changes (bumped after every metrics run). */
export class VersionedCache<V> {
  private entries = new Map<string, { at: number; version: number; value: V }>();
  constructor(private ttlMs: number, private version: () => number, private now: () => number = Date.now) {}

  get(key: string, compute: () => V): V {
    const hit = this.entries.get(key);
    const v = this.version(), t = this.now();
    if (hit && hit.version === v && t - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.entries.set(key, { at: t, version: v, value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
