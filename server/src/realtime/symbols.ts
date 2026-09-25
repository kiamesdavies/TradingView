// Pure helpers: EODHD symbol <-> upstream websocket feed mapping, and upstream message parsing.
import type { Symbol, Tick } from "@eodview/shared";

export type Feed = "us" | "forex" | "crypto";
export const FEEDS: readonly Feed[] = ["us", "forex", "crypto"];

const FEED_BY_EXCHANGE: Record<string, Feed> = { US: "us", FOREX: "forex", CC: "crypto" };
const EXCHANGE_BY_FEED: Record<Feed, string> = { us: "US", forex: "FOREX", crypto: "CC" };

export interface UpstreamRef { feed: Feed; code: string }

/** Split `TICKER.EXCHANGE` on the LAST dot (tickers such as `BRK.B.US` keep their inner dot). */
export function splitSymbol(symbol: Symbol): { code: string; exchange: string } | null {
  const i = symbol.lastIndexOf(".");
  if (i <= 0 || i === symbol.length - 1) return null;
  return { code: symbol.slice(0, i), exchange: symbol.slice(i + 1).toUpperCase() };
}

/** `AAPL.US` → {feed:"us", code:"AAPL"}; `EURUSD.FOREX` → forex; `BTC-USD.CC` → crypto; anything else → null (not streamable). */
export function toUpstream(symbol: Symbol): UpstreamRef | null {
  const parts = splitSymbol(symbol);
  if (!parts) return null;
  const feed = FEED_BY_EXCHANGE[parts.exchange];
  if (!feed) return null;
  return { feed, code: parts.code.toUpperCase() };
}

export function isStreamable(symbol: Symbol): boolean {
  return toUpstream(symbol) !== null;
}

/** Inverse of toUpstream: ("us","AAPL") → "AAPL.US". */
export function fromUpstream(feed: Feed, code: string): Symbol {
  return `${code.toUpperCase()}.${EXCHANGE_BY_FEED[feed]}`;
}

export type UpstreamEvent =
  | { kind: "authorized" }
  | { kind: "error"; status: number; message: string }
  | { kind: "tick"; tick: Tick }
  | { kind: "ignored" };

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

/**
 * Parse one upstream text frame. Shapes observed live (Sep 2026):
 *   {"status_code":200,"message":"Authorized"}                 (after open)
 *   {"status":403,"message":"Server error"}                    (bad key, then the socket closes)
 *   us:     {"s":"AAPL","p":335.95,"c":[],"v":1,"dp":false,"ms":"extended-hours","t":1790329995797}
 *   crypto: {"s":"BTC-USD","p":"84588","q":"0.002","dc":"0.2196","dd":"185.7","t":1790330111002}   (numeric strings)
 *   forex:  {"s":"EURUSD","a":1.13896,"b":1.13895,"dc":"0.0619","dd":"0.0007","ppms":true,"t":1790330110001}
 */
export function parseUpstreamMessage(feed: Feed, raw: string): UpstreamEvent {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { kind: "ignored" };
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { kind: "ignored" };
  const o = m as Record<string, unknown>;

  const status = typeof o.status_code === "number" ? o.status_code : typeof o.status === "number" ? o.status : undefined;
  if (status !== undefined && typeof o.s !== "string") {
    const message = typeof o.message === "string" ? o.message : "";
    if (status === 200 && /authori[sz]ed/i.test(message)) return { kind: "authorized" };
    if (status >= 400) return { kind: "error", status, message: message || `status ${status}` };
    return { kind: "ignored" };
  }

  if (typeof o.s !== "string" || o.s === "") return { kind: "ignored" };
  let price: number;
  let volume: number;
  if (feed === "forex") {
    const a = num(o.a);
    const b = num(o.b);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) price = Math.round(((a + b) / 2) * 1e8) / 1e8;
    else price = Number.isFinite(a) && a > 0 ? a : b;
    volume = 0;
  } else {
    price = num(o.p);
    volume = num(feed === "crypto" ? o.q : o.v);
  }
  if (!Number.isFinite(price) || price <= 0) return { kind: "ignored" };
  if (!Number.isFinite(volume) || volume < 0) volume = 0;
  const t = num(o.t);
  const time = Number.isFinite(t) && t > 0 ? Math.round(t) : Date.now();
  return { kind: "tick", tick: { symbol: fromUpstream(feed, o.s), price, volume, time } };
}
