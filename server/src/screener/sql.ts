// Tiny SQL-fragment helpers for the screener. Column names only ever come from the METRIC_COLUMNS whitelist;
// every value is a bound parameter.
import { METRIC_COLUMN_SET } from "../universe/metricsSchema";

export type SqlParam = string | number;
export interface Pred { sql: string; params: SqlParam[] }

export interface CompileCtx {
  /** Quoted column reference, or `NULL` when the table lacks the column. Throws for non-whitelisted names. */
  col(name: string): string;
  /** New York calendar date "YYYY-MM-DD". */
  today: string;
  now: Date;
}

export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
}

/** Column resolver bound to the columns the table actually has (all of METRIC_COLUMNS when `present` is undefined). */
export function makeColResolver(present?: ReadonlySet<string>): (name: string) => string {
  return (name: string) => {
    if (!METRIC_COLUMN_SET.has(name)) throw new Error(`screener references unknown metric column "${name}"`);
    if (present && !present.has(name)) return "NULL";
    return quoteIdent(name);
  };
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
