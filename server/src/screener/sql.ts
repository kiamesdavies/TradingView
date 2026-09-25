// Tiny SQL-fragment helpers for the screener. Column names only ever come from the METRIC_COLUMNS whitelist
// (plus the v3 multi-market columns below); every value is a bound parameter.
import { METRIC_COLUMNS, METRIC_COLUMN_SET, type MetricColumn } from "../universe/metricsSchema";

export type SqlParam = string | number;
export interface Pred { sql: string; params: SqlParam[] }

export interface CompileCtx {
  /** Quoted column reference, or `NULL` when the table lacks the column. Throws for non-whitelisted names. */
  col(name: string): string;
  /** Calendar date "YYYY-MM-DD" in `tz` (the selected market's zone; UTC for ALL; New York by default). */
  today: string;
  now: Date;
  /** IANA zone of `today` and of date-relative day boundaries (default America/New_York). */
  tz?: string;
  /** The market's regular close ("after market close" filters); default 16:00 America/New_York. */
  close?: { hour: number; minute: number; tz: string };
  /** v3: size/liquidity filters compare USD columns (market != US). */
  usd?: boolean;
}

/**
 * v3 metric columns written by the pipeline (module P). Listed here too so the screener works against both the
 * old and the new schema: columns the table lacks resolve to NULL (or a fallback, see `makeColResolver`).
 */
export const V3_METRIC_COLUMNS: MetricColumn[] = [
  { col: "market", type: "TEXT", desc: "EODHD exchange code of the listing market: US, ST, LSE, …" },
  { col: "fx_to_usd", type: "REAL", desc: "listing currency → USD rate" },
  { col: "price_usd", type: "REAL", desc: "price in USD" },
  { col: "market_cap_usd", type: "REAL", desc: "market cap in USD" },
  { col: "dollar_volume_usd", type: "REAL", desc: "price * avg_volume in USD" },
  { col: "perf_3y", type: "REAL", desc: "%" },
  { col: "perf_5y", type: "REAL", desc: "%" },
  { col: "ath", type: "REAL", desc: "all-time high (adjusted)" },
  { col: "ath_date", type: "TEXT", desc: "YYYY-MM-DD" },
  { col: "ath_pct", type: "REAL", desc: "price vs all-time high % (<=0)" },
  { col: "atl_pct", type: "REAL", desc: "price vs all-time low % (>=0)" },
  { col: "indices", type: "TEXT", desc: "index ids the symbol belongs to, comma-separated: FTSE,FTMC" },
];

/** Every column name the screener may reference. */
export const SCREENER_COLUMN_SET: ReadonlySet<string> = new Set([...METRIC_COLUMN_SET, ...V3_METRIC_COLUMNS.map((c) => c.col)]);
/** METRIC_COLUMNS plus the v3 columns the pipeline has not declared (yet) — the table shape tests create. */
export const SCREENER_COLUMNS: MetricColumn[] = [
  ...METRIC_COLUMNS, ...V3_METRIC_COLUMNS.filter((c) => !METRIC_COLUMN_SET.has(c.col)),
];

/** USD column → listing-currency column it equals for USD listings (used when the pipeline left the USD column NULL). */
export const USD_FALLBACK: Readonly<Record<string, string>> = {
  market_cap_usd: "market_cap", price_usd: "price", dollar_volume_usd: "dollar_volume",
};
/** Listing-currency column → USD column, applied to filter predicates when `ctx.usd`. */
export const USD_REMAP: Readonly<Record<string, string>> = {
  market_cap: "market_cap_usd", price: "price_usd", dollar_volume: "dollar_volume_usd",
};
export const DEFAULT_MARKET = "US";

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
}

/**
 * Column resolver bound to the columns the table actually has (all known columns when `present` is undefined).
 * Special cases (v3):
 *  - `market` → `COALESCE("market", 'US')` (rows written before multi-market support are US listings);
 *  - `*_usd` → `COALESCE("x_usd", <x when the row is a US/USD listing>)`.
 */
export function makeColResolver(present?: ReadonlySet<string>): (name: string) => string {
  const plain = (name: string) => {
    if (!SCREENER_COLUMN_SET.has(name)) throw new Error(`screener references unknown metric column "${name}"`);
    if (present && !present.has(name)) return "NULL";
    return quoteIdent(name);
  };
  return (name: string) => {
    const ref = plain(name);
    if (name === "market") return ref === "NULL" ? `'${DEFAULT_MARKET}'` : `COALESCE(${ref}, '${DEFAULT_MARKET}')`;
    const base = USD_FALLBACK[name];
    if (base) {
      const mkt = plain("market");
      const isUsd = `(${mkt === "NULL" ? `'${DEFAULT_MARKET}'` : `COALESCE(${mkt}, '${DEFAULT_MARKET}')`} = '${DEFAULT_MARKET}' OR ${plain("currency")} = 'USD')`;
      const fb = `CASE WHEN ${isUsd} THEN ${plain(base)} END`;
      return ref === "NULL" ? `(${fb})` : `COALESCE(${ref}, ${fb})`;
    }
    return ref;
  };
}

/** Wrap a resolver so listing-currency size/liquidity columns read their USD counterparts. */
export function usdCtx(ctx: CompileCtx): CompileCtx {
  if (!ctx.usd) return ctx;
  return { ...ctx, col: (n) => ctx.col(USD_REMAP[n] ?? n) };
}

export const TRUE_PRED: Pred = { sql: "1", params: [] };

export function and(preds: Pred[]): Pred {
  if (!preds.length) return TRUE_PRED;
  return { sql: preds.map((p) => `(${p.sql})`).join(" AND "), params: preds.flatMap((p) => p.params) };
}

export function or(preds: Pred[]): Pred {
  if (!preds.length) return { sql: "0", params: [] };
  return { sql: preds.map((p) => `(${p.sql})`).join(" OR "), params: preds.flatMap((p) => p.params) };
}

export type Op = "<" | "<=" | ">" | ">=" | "=" | "<>";
