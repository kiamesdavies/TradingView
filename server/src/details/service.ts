// Details service: fetches and caches the upstream pieces, then assembles overview / news / events.
// Dependencies are injected (see index.ts for the process-wide instance) so tests can use fakes.
import type { Bar, ChartEvent, NewsItem, Quote, SymbolInfo, SymbolOverview } from "@eodview/shared";
import { EodhdError } from "../eodhd/request";
import { dividendEvents, earningsEvents, selectEvents, splitEvents } from "./events";
import { classifyExtended, regularTradeTime } from "./extended";
import { mapNews } from "./news";
import { averageVolume, buildOverview } from "./overview";
import { symbolKind, type ParsedSymbol } from "./symbol";
import { nyClock } from "./time";
import type { LogoResult, LogoStore } from "./logo";

type Raw = Record<string, any>;

export interface DetailsDeps {
  raw(path: string, params?: Record<string, string | number | undefined>, what?: string): Promise<unknown>;
  realtime(symbols: string[]): Promise<Quote[]>;
  search(q: string): Promise<SymbolInfo[]>;
  getFundamentals(symbol: string, maxAgeSec: number): Promise<Raw>;
  getCachedFundamentals(symbol: string): { data: Raw; fetchedAt: number } | null;
  /** Latest daily bars (adjusted), ascending. */
  dailyBars(symbol: string, limit: number): Promise<Bar[]>;
  logos: LogoStore;
  nowMs?: () => number;
  log?: (msg: string) => void;
  /** Override OVERVIEW_NEWS_WAIT_MS (tests). */
  newsWaitMs?: number;
}

export const FUNDAMENTALS_MAX_AGE_SEC = 24 * 3600;
const OVERVIEW_TTL_MS = 60_000;
const QUOTE_TTL_MS = 5_000;
const EXTENDED_TTL_MS = 15_000;
const NEWS_TTL_MS = 10 * 60_000;
/** EODHD /news is slow (4–9 s without a date bound); a `from` bound roughly halves it. */
const NEWS_LOOKBACK_DAYS = 60;
/** The overview waits this long for news; a slower fetch still completes in the background and fills the cache. */
const OVERVIEW_NEWS_WAIT_MS = 2_500;
const CORP_ACTIONS_TTL_MS = 24 * 3600_000;
const NAME_TTL_MS = 24 * 3600_000;
export const NEWS_MIN_FETCH = 20;
export const NEWS_MAX_LIMIT = 50;
const CACHE_MAX = 500;

/** Small TTL map with insertion-order eviction. */
class TtlCache<V> {
  private map = new Map<string, { at: number; value: V }>();
  constructor(private ttlMs: number, private now: () => number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > CACHE_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** Shares one promise between concurrent identical calls. */
function dedupe<T>(pending: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = pending.get(key);
  if (hit) return hit;
  const p = fn().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** EODHD "no data / not on plan" answers are treated as empty instead of failing the whole response. */
const isAbsent = (e: unknown): boolean => e instanceof EodhdError && (e.code === "not_found" || e.code === "plan");

interface OverviewBase {
  fundamentals: Raw | null;
  fetchedAt: number | null;
  avgVolume30d: number | null;
  fallbackName?: string;
}

export function createDetailsService(deps: DetailsDeps) {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.warn(`[details] ${m}`));
  const baseCache = new TtlCache<OverviewBase>(OVERVIEW_TTL_MS, nowMs);
  const quoteCache = new TtlCache<Quote | null>(QUOTE_TTL_MS, nowMs);
  const extCache = new TtlCache<Raw | null>(EXTENDED_TTL_MS, nowMs);
  const newsCache = new TtlCache<{ fetched: number; items: NewsItem[] }>(NEWS_TTL_MS, nowMs);
  const divCache = new TtlCache<unknown>(CORP_ACTIONS_TTL_MS, nowMs);
  const splitCache = new TtlCache<unknown>(CORP_ACTIONS_TTL_MS, nowMs);
  const nameCache = new TtlCache<string | null>(NAME_TTL_MS, nowMs);
  const pending = new Map<string, Promise<any>>();

  async function cached<V>(cache: TtlCache<V>, key: string, fn: () => Promise<V>): Promise<V> {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    return dedupe(pending, `${key}`, async () => {
      const v = await fn();
      cache.set(key, v);
      return v;
    });
  }

  // ---------- news ----------
  async function news(symbol: string, limit = NEWS_MIN_FETCH): Promise<NewsItem[]> {
    const want = Math.max(1, Math.min(NEWS_MAX_LIMIT, Math.floor(limit) || NEWS_MIN_FETCH));
    const hit = newsCache.get(symbol);
    if (hit && (hit.fetched >= want || hit.items.length < hit.fetched)) return hit.items.slice(0, want);
    const fetchN = Math.max(want, NEWS_MIN_FETCH);
    const items = await dedupe(pending, `news|${symbol}|${fetchN}`, async () => {
      const from = new Date(nowMs() - NEWS_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      const list = mapNews(await deps.raw("/news", { s: symbol, limit: fetchN, offset: 0, from }, `${symbol} news`));
      newsCache.set(symbol, { fetched: fetchN, items: list });
      return list;
    });
    return items.slice(0, want);
  }

  // ---------- overview ----------
  function quote(symbol: string): Promise<Quote | null> {
    return cached(quoteCache, `q|${symbol}`, async () => (await deps.realtime([symbol])).find((q) => q.symbol.toUpperCase() === symbol) ?? null);
  }

  function delayed(symbol: string): Promise<Raw | null> {
    return cached(extCache, `x|${symbol}`, async () => {
      const res = (await deps.raw("/us-quote-delayed", { s: symbol }, `${symbol} extended quote`)) as Raw;
      const data = res && typeof res === "object" ? (res.data as Raw | undefined) : undefined;
      const entry = data?.[symbol] ?? (data ? Object.values(data)[0] : undefined);
      return entry && typeof entry === "object" ? (entry as Raw) : null;
    });
  }

  async function lookupName(sym: ParsedSymbol): Promise<string | undefined> {
    const name = await cached(nameCache, `n|${sym.symbol}`, async () => {
      const hits = await deps.search(sym.code);
      return hits.find((h) => h.symbol.toUpperCase() === sym.symbol)?.name ?? null;
    }).catch(() => null);
    return name ?? undefined;
  }

  async function base(sym: ParsedSymbol): Promise<OverviewBase> {
    const kind = symbolKind(sym.exchange);
    return cached(baseCache, `b|${sym.symbol}`, async () => {
      const soft = <T>(what: string, p: Promise<T>, fallback: T): Promise<T> =>
        p.catch((e) => {
          if (!isAbsent(e)) log(`${sym.symbol} ${what}: ${(e as Error).message}`);
          return fallback;
        });
      const fundP: Promise<Raw | null> =
        kind === "security"
          ? deps.getFundamentals(sym.symbol, FUNDAMENTALS_MAX_AGE_SEC).catch((e) => {
              if (isAbsent(e)) return null;
              throw e;
            })
          : Promise.resolve(null);
      const [fundamentals, bars] = await Promise.all([fundP, soft("daily bars", deps.dailyBars(sym.symbol, 30), [] as Bar[])]);
      const out: OverviewBase = {
        fundamentals,
        fetchedAt: fundamentals ? deps.getCachedFundamentals(sym.symbol)?.fetchedAt ?? Math.floor(nowMs() / 1000) : null,
        avgVolume30d: averageVolume(bars, 30),
      };
      if (!fundamentals?.General?.Name) out.fallbackName = await lookupName(sym);
      return out;
    });
  }

  /** First news item, waiting at most OVERVIEW_NEWS_WAIT_MS (the fetch keeps running and fills the cache). */
  function latestNews(symbol: string): Promise<NewsItem | null> {
    const p = news(symbol, 1).then(
      (items) => items[0] ?? null,
      (e) => {
        if (!isAbsent(e)) log(`${symbol} news: ${(e as Error).message}`);
        return null;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.newsWaitMs ?? OVERVIEW_NEWS_WAIT_MS);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  async function overview(sym: ParsedSymbol): Promise<SymbolOverview> {
    const kind = symbolKind(sym.exchange);
    const isUs = sym.exchange === "US";
    const [b, q, ext, latest] = await Promise.all([
      base(sym),
      quote(sym.symbol).catch((e) => {
        log(`${sym.symbol} quote: ${(e as Error).message}`);
        return null;
      }),
      isUs
        ? delayed(sym.symbol).catch((e) => {
            if (!isAbsent(e)) log(`${sym.symbol} extended quote: ${(e as Error).message}`);
            return null;
          })
        : Promise.resolve(null),
      latestNews(sym.symbol),
    ]);
    const regularPrice = q?.price ?? (typeof ext?.previousClosePrice === "number" ? ext.previousClosePrice : null);
    const extended = ext
      ? classifyExtended(
          { ethPrice: ext.ethPrice, ethTimeMs: ext.ethTime, regularPrice, regularTime: regularTradeTime(q?.time) },
          nowMs(),
        )
      : null;
    return buildOverview({
      sym,
      kind,
      fundamentals: b.fundamentals,
      fundamentalsFetchedAt: b.fetchedAt,
      quote: q,
      extended,
      latestNews: latest,
      avgVolume30d: b.avgVolume30d,
      fallbackName: b.fallbackName,
      nowMs: nowMs(),
    });
  }

  // ---------- events ----------
  async function events(sym: ParsedSymbol, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<ChartEvent[]> {
    if (symbolKind(sym.exchange) !== "security") return [];
    const today = nyClock(nowMs()).day;
    const absentAs = <T>(fallback: T) => (e: unknown): T => {
      if (isAbsent(e)) return fallback;
      throw e;
    };
    const [fund, divs, splits] = await Promise.all([
      deps.getFundamentals(sym.symbol, FUNDAMENTALS_MAX_AGE_SEC).catch(absentAs<Raw | null>(null)),
      cached(divCache, `d|${sym.symbol}`, () => deps.raw(`/div/${encodeURIComponent(sym.symbol)}`, { from: "1970-01-01" }, `${sym.symbol} dividends`)).catch(absentAs<unknown>([])),
      cached(splitCache, `s|${sym.symbol}`, () => deps.raw(`/splits/${encodeURIComponent(sym.symbol)}`, { from: "1970-01-01" }, `${sym.symbol} splits`)).catch(absentAs<unknown>([])),
    ]);
    return selectEvents(
      [...earningsEvents(fund?.Earnings?.History, today), ...dividendEvents(divs, today), ...splitEvents(splits, today)],
      from,
      to,
    );
  }

  // ---------- logo ----------
  function logo(sym: ParsedSymbol): Promise<LogoResult> {
    const hint = deps.getCachedFundamentals(sym.symbol)?.data?.General?.LogoURL;
    return deps.logos.get(sym.symbol, sym.code, sym.exchange, typeof hint === "string" ? hint : null);
  }

  return { overview, news, events, logo };
}

export type DetailsService = ReturnType<typeof createDetailsService>;
