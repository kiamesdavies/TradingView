// Process-wide bar cache wired to the shared DB and the EODHD client.
import type { BarsResponse, Timeframe, UnixSeconds } from "@eodview/shared";
import { db } from "../db";
import { eodhd } from "../eodhd/client";
import { cacheSettings } from "../config/config";
import { BarCache, DEFAULT_LIMIT } from "./engine";

export { TF_SPEC, MAX_LIMIT, DEFAULT_LIMIT } from "./engine";

export const barCache = new BarCache({ db, client: eodhd, settings: cacheSettings });

/** Up to `limit` bars strictly before `to` (or the latest), ascending. See engine.ts for caching rules. */
export function getBars(symbol: string, tf: Timeframe, to?: UnixSeconds, limit = DEFAULT_LIMIT): Promise<BarsResponse> {
  return barCache.getBars(symbol, tf, to, limit);
}
