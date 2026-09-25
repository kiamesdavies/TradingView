// EODHD REST client factory: the key is read via `getKey` on every call; identical in-flight requests are shared.
import type { Bar, Quote, SymbolInfo } from "@eodview/shared";
import {
  mapEod,
  mapIntraday,
  mapRealtime,
  mapSearch,
  mapUser,
  type EodPeriod,
  type EodhdUser,
  type IntradayInterval,
} from "./mappers";
import { EodhdError, InFlight, eodhdGet, noKeyError, requestKey, type FetchFn, type QueryValue } from "./request";

/** Max span (seconds) EODHD serves in one intraday request. */
export const INTRADAY_MAX_RANGE_SEC: Record<IntradayInterval, number> = {
  "1m": 120 * 86400,
  "5m": 600 * 86400,
  "1h": 7200 * 86400,
};

/** /real-time accepts several symbols per call; keep batches modest. */
const REALTIME_BATCH = 15;

export interface EodhdClient {
  search(q: string): Promise<SymbolInfo[]>;
  eod(symbol: string, from?: string, to?: string, period?: EodPeriod): Promise<Bar[]>;
  intraday(symbol: string, interval: IntradayInterval, fromUnix?: number, toUnix?: number): Promise<Bar[]>;
  realtime(symbols: string[]): Promise<Quote[]>;
  user(): Promise<EodhdUser>;
  /** Unmapped GET for endpoints without a dedicated method (fundamentals, news, calendar, bulk, logos…). `path` starts with "/". */
  raw(path: string, params?: Record<string, QueryValue>, what?: string): Promise<unknown>;
}

export function createEodhdClient(getKey: () => string | null, fetchFn: FetchFn = fetch): EodhdClient {
  const inflight = new InFlight();

  function get(path: string, params: Record<string, QueryValue>, what: string): Promise<unknown> {
    const key = getKey();
    if (!key) return Promise.reject(noKeyError());
    // The de-dupe key includes a key fingerprint so a key swap never reuses a request made with the old key.
    const dedupe = `${key.length}:${key.slice(-4)}|${requestKey(path, params)}`;
    return inflight.run(dedupe, () => eodhdGet(path, params, key, what, fetchFn));
  }

  const seg = (s: string): string => encodeURIComponent(s.trim());

  return {
    async search(q) {
      const query = q.trim();
      if (!query) return [];
      return mapSearch(await get(`/search/${seg(query)}`, { limit: 20 }, `search "${query}"`));
    },

    async eod(symbol, from, to, period = "d") {
      return mapEod(await get(`/eod/${seg(symbol)}`, { from, to, period }, symbol), period);
    },

    async intraday(symbol, interval, fromUnix, toUnix) {
      if (fromUnix !== undefined && toUnix !== undefined && toUnix - fromUnix > INTRADAY_MAX_RANGE_SEC[interval]) {
        throw new EodhdError(400, `intraday ${interval} range exceeds EODHD's maximum`, "bad_request");
      }
      const params = { interval, from: fromUnix, to: toUnix };
      return mapIntraday(await get(`/intraday/${seg(symbol)}`, params, `${symbol} ${interval}`));
    },

    async realtime(symbols) {
      const uniq = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
      if (!uniq.length) return [];
      const batches: string[][] = [];
      for (let i = 0; i < uniq.length; i += REALTIME_BATCH) batches.push(uniq.slice(i, i + REALTIME_BATCH));
      const results = await Promise.all(
        batches.map(async ([first, ...rest]) =>
          mapRealtime(await get(`/real-time/${seg(first)}`, { s: rest.length ? rest.join(",") : undefined }, "quotes")),
        ),
      );
      return results.flat();
    },

    async user() {
      return mapUser(await get("/user", {}, "user info"));
    },

    raw(path, params = {}, what = path) {
      return get(path, params, what);
    },
  };
}
