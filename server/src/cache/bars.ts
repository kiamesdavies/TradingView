// Process-wide bar cache wired to the shared DB and the EODHD client.
import type { BarsResponse, Timeframe, UnixSeconds } from "@eodview/shared";
import { db } from "../db";
import { eodhd } from "../eodhd/client";
import { cacheSettings } from "../config/config";
import { mapEod } from "../eodhd/mappers";
import { BarCache, DEFAULT_LIMIT } from "./engine";

export { TF_SPEC, MAX_LIMIT, DEFAULT_LIMIT } from "./engine";

export const barCache = new BarCache({
  db,
  client: eodhd,
  settings: cacheSettings,
  // Same /eod endpoint (same in-flight de-dupe key as eodhd.eod), mapped without the adjustment ratio.
  unadjustedEod: async (symbol, from, to, period = "d") =>
    mapEod(await eodhd.raw(`/eod/${encodeURIComponent(symbol.trim())}`, { from, to, period }, symbol), period, false),
});

/**
 * Up to `limit` bars strictly before `to` (or the latest), ascending. See engine.ts for caching rules.
 * `adjusted = false` returns raw (as-traded) OHLCV for 1D/1W/1M; intraday ignores it.
 */
export function getBars(
  symbol: string,
  tf: Timeframe,
  to?: UnixSeconds,
  limit = DEFAULT_LIMIT,
  adjusted = true,
): Promise<BarsResponse> {
  return barCache.getBars(symbol, tf, to, limit, adjusted);
}
