// Market data routes: health, symbol search, bars, quote snapshots.
import { TIMEFRAMES, type Quote, type SymbolInfo, type Timeframe } from "@eodview/shared";
import { HttpError, json, type Router } from "../http";
import { cacheSettings, config } from "../config/config";
import { eodhd } from "../eodhd/client";
import { getBars, MAX_LIMIT, DEFAULT_LIMIT } from "../cache/bars";

const MAX_QUOTE_SYMBOLS = 100;
const SEARCH_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 500;

const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9._\-^=&]{0,39}$/;

/** Validate and normalize an EODHD `TICKER.EXCHANGE` symbol from user input. */
export function parseSymbol(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) throw new HttpError(400, "symbol is required");
  if (!SYMBOL_RE.test(s) || s.includes("..")) throw new HttpError(400, `invalid symbol "${s.slice(0, 40)}"`);
  return s.toUpperCase();
}

function parseTf(raw: string | null): Timeframe {
  const tf = (raw ?? "1D") as Timeframe;
  if (!TIMEFRAMES.includes(tf)) throw new HttpError(400, `tf must be one of ${TIMEFRAMES.join(", ")}`);
  return tf;
}

function parseIntParam(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return Math.floor(n);
}

const searchCache = new Map<string, { at: number; results: SymbolInfo[] }>();
const quoteCache = new Map<string, { at: number; quote: Quote }>();

async function search(q: string): Promise<SymbolInfo[]> {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;
  const results = await eodhd.search(q);
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  return results;
}

async function quotes(symbols: string[]): Promise<Quote[]> {
  const ttl = cacheSettings.quoteTtlSec * 1000;
  const now = Date.now();
  const missing = symbols.filter((s) => {
    const hit = quoteCache.get(s);
    return !hit || now - hit.at >= ttl;
  });
  if (missing.length) {
    for (const q of await eodhd.realtime(missing)) quoteCache.set(q.symbol.toUpperCase(), { at: now, quote: q });
    for (const [k, v] of quoteCache) if (now - v.at > 10 * ttl) quoteCache.delete(k);
  }
  const out: Quote[] = [];
  for (const s of symbols) {
    const hit = quoteCache.get(s);
    if (hit) out.push({ ...hit.quote, symbol: s });
  }
  return out;
}

export function register(router: Router): void {
  router.get("/api/health", () => json({ ok: true, hasKey: config.getKey() !== null }));

  router.get("/api/search", async (_req, _p, url) => {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 64);
    if (!q) return json([]);
    return json(await search(q));
  });

  router.get("/api/bars", async (_req, _p, url) => {
    const symbol = parseSymbol(url.searchParams.get("symbol"));
    const tf = parseTf(url.searchParams.get("tf"));
    const to = parseIntParam(url.searchParams.get("to"), "to");
    const limitRaw = parseIntParam(url.searchParams.get("limit"), "limit") ?? DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw));
    return json(await getBars(symbol, tf, to, limit));
  });

  router.get("/api/quotes", async (_req, _p, url) => {
    const raw = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!raw.length) return json([]);
    if (raw.length > MAX_QUOTE_SYMBOLS) throw new HttpError(400, `at most ${MAX_QUOTE_SYMBOLS} symbols per request`);
    const symbols = [...new Set(raw.map((s) => parseSymbol(s)))];
    return json(await quotes(symbols));
  });
}
