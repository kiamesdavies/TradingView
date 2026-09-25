// Per-request metering hook for EODHD calls. Code that must pay for its upstream calls (the agent API) runs inside
// `callMeter.run(meter, fn)`; every real HTTP request the client starts in that async context is passed to
// `meter.charge()` first, which may throw to refuse the call (e.g. a daily credit budget is spent).
// Calls outside a metered context (the UI, the universe pipeline) are unaffected.
import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryValue } from "./request";

export interface CallMeter {
  /** Called before each upstream request; throw to refuse it. */
  charge(path: string, params: Record<string, QueryValue>): void;
}

export const callMeter = new AsyncLocalStorage<CallMeter>();

/**
 * EODHD credit cost of one request (EODHD pricing): fundamentals 10, news 5, intraday 5, /real-time 1 per symbol,
 * /user free, everything else (eod, search, calendar, dividends, splits…) 1.
 */
export function eodhdCallCost(path: string, params: Record<string, QueryValue> = {}): number {
  if (path === "/user") return 0;
  if (path.startsWith("/fundamentals/")) return 10;
  if (path === "/news" || path.startsWith("/news/")) return 5;
  if (path.startsWith("/intraday/")) return 5;
  if (path.startsWith("/real-time/")) {
    const extra = typeof params.s === "string" ? params.s.split(",").filter((x) => x.trim()).length : 0;
    return 1 + extra;
  }
  return 1;
}
