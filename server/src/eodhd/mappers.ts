// Pure mapping of raw EODHD JSON into shared types. No I/O; covered by mappers.test.ts.
import type { AssetClass, Bar, Quote, SymbolInfo } from "@eodview/shared";

export type EodPeriod = "d" | "w" | "m";
export type IntradayInterval = "1m" | "5m" | "1h";

export interface EodhdUser {
  name?: string;
  email?: string;
  subscriptionType?: string;
  apiRequests?: number;
  dailyRateLimit?: number;
}

/** Streamable = an EODHD websocket feed exists for the exchange. */
export const STREAMABLE_EXCHANGES: ReadonlySet<string> = new Set(["US", "FOREX", "CC"]);

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Numbers, numeric strings → number; null, "NA", "" and garbage → NaN. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && v !== "NA") return Number(v);
  return NaN;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Round to 10 significant digits to hide float noise from the adjustment multiplication. */
const tidy = (x: number): number => Number(x.toPrecision(10));

/** "2024-01-02" → 1704153600 (00:00 UTC). NaN when malformed. */
export function dateToUnix(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}

/** Monday 00:00 UTC of the week containing t. */
export function weekStart(t: number): number {
  const day = Math.floor(t / 86400);
  const dow = (day + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
  return (day - dow) * 86400;
}

/** 1st of the month 00:00 UTC containing t. */
export function monthStart(t: number): number {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/**
 * EOD rows → bars.
 *
 * Adjustment choice: EODHD returns raw (split-unadjusted) OHLC plus `adjusted_close`. We scale
 * open/high/low/close by `adjusted_close / close` so historic splits (and dividends) do not create
 * cliffs in the chart, and divide volume by the same ratio so volume stays in today's share units.
 * The last bars (ratio ≈ 1) therefore match live ticks exactly. Intraday data is not adjusted by
 * EODHD, so intraday bars older than the most recent split/dividend differ from daily bars.
 *
 * With `adjusted = false` the raw (as-traded) OHLC and volume are returned unchanged (the ADJ toggle off).
 *
 * Weekly/monthly bars are re-stamped to Monday / the 1st of the month (EODHD stamps them with the
 * first trading day), so they line up with the client's live-candle bucketing.
 */
export function mapEod(raw: unknown, period: EodPeriod = "d", adjusted = true): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    let time = dateToUnix(str(r.date));
    const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    const adj = num(r.adjusted_close);
    const ratio = adjusted && Number.isFinite(adj) && adj > 0 && close > 0 ? adj / close : 1;
    const vol = num(r.volume);
    if (period === "w") time = weekStart(time);
    else if (period === "m") time = monthStart(time);
    out.push({
      time,
      open: tidy(open * ratio),
      high: tidy(high * ratio),
      low: tidy(low * ratio),
      close: tidy(close * ratio),
      volume: Number.isFinite(vol) ? Math.round(vol / ratio) : 0,
    });
  }
  return sortDedupe(out);
}

/** Intraday rows → bars; rows with any null/NA price are dropped. */
export function mapIntraday(raw: unknown): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const time = num(r.timestamp);
    const open = num(r.open), high = num(r.high), low = num(r.low), close = num(r.close);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    const vol = num(r.volume);
    out.push({ time, open, high, low, close, volume: Number.isFinite(vol) ? vol : 0 });
  }
  return sortDedupe(out);
}

/** Ascending by time; on duplicate timestamps the later row wins. */
export function sortDedupe(bars: Bar[]): Bar[] {
  bars.sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  for (const b of bars) {
    if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

export function assetClassOf(exchange: string, type: string): AssetClass {
  const ex = exchange.toUpperCase();
  const t = type.toLowerCase();
  if (ex === "FOREX") return "forex";
  if (ex === "CC") return "crypto";
  if (ex === "INDX" || t === "index") return "index";
  if (t.includes("etf")) return "etf";
  if (t.includes("stock") || t === "preferred" || t === "common") return ex === "US" ? "us_stock" : "stock";
  return "other";
}

export function mapSearch(raw: unknown): SymbolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SymbolInfo[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isObj(r)) continue;
    const code = str(r.Code).trim();
    const exchange = str(r.Exchange).trim().toUpperCase();
    if (!code || !exchange) continue;
    const symbol = `${code}.${exchange}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const type = str(r.Type);
    const info: SymbolInfo = {
      symbol,
      code,
      exchange,
      name: str(r.Name),
      type,
      assetClass: assetClassOf(exchange, type),
      streamable: STREAMABLE_EXCHANGES.has(exchange),
    };
    const country = str(r.Country);
    const currency = str(r.Currency);
    if (country && country !== "Unknown") info.country = country;
    if (currency) info.currency = currency;
    out.push(info);
  }
  return out;
}

/** /real-time returns a single object for one symbol and an array for several. Entries without a price are dropped. */
export function mapRealtime(raw: unknown): Quote[] {
  const rows = Array.isArray(raw) ? raw : isObj(raw) ? [raw] : [];
  const out: Quote[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const symbol = str(r.code).trim();
    const price = num(r.close);
    if (!symbol || !Number.isFinite(price)) continue;
    const prev = num(r.previousClose);
    let change = num(r.change);
    let changePct = num(r.change_p);
    if (!Number.isFinite(change)) change = Number.isFinite(prev) ? price - prev : 0;
    if (!Number.isFinite(changePct)) changePct = Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : 0;
    const vol = num(r.volume);
    const ts = num(r.timestamp);
    out.push({
      symbol,
      price,
      change,
      changePct,
      volume: Number.isFinite(vol) ? vol : 0,
      prevClose: Number.isFinite(prev) ? prev : price - change,
      time: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
    });
  }
  return out;
}

export function mapUser(raw: unknown): EodhdUser {
  if (!isObj(raw)) return {};
  const u: EodhdUser = {};
  if (typeof raw.name === "string") u.name = raw.name;
  if (typeof raw.email === "string") u.email = raw.email;
  if (typeof raw.subscriptionType === "string") u.subscriptionType = raw.subscriptionType;
  const req = num(raw.apiRequests);
  const lim = num(raw.dailyRateLimit);
  if (Number.isFinite(req)) u.apiRequests = req;
  if (Number.isFinite(lim)) u.dailyRateLimit = lim;
  return u;
}
