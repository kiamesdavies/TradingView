// Symbol validation and classification for the details API. Pure.
import { HttpError } from "../http";

const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9_\-^=&.]{0,30}\.[A-Za-z0-9]{1,10}$/;

export interface ParsedSymbol {
  symbol: string;   // "AAPL.US"
  code: string;     // "AAPL"
  exchange: string; // "US"
}

/** Validate a `TICKER.EXCHANGE` path parameter (400 otherwise) and normalize it to upper case. */
export function parseDetailsSymbol(raw: string | undefined | null): ParsedSymbol {
  const s = (raw ?? "").trim();
  if (!s) throw new HttpError(400, "symbol is required");
  if (!SYMBOL_RE.test(s) || s.includes("..")) {
    throw new HttpError(400, `invalid symbol "${s.slice(0, 40)}" (expected TICKER.EXCHANGE, e.g. AAPL.US)`);
  }
  const symbol = s.toUpperCase();
  const dot = symbol.lastIndexOf(".");
  return { symbol, code: symbol.slice(0, dot), exchange: symbol.slice(dot + 1) };
}

/** Exchanges without company fundamentals, earnings, dividends or splits. */
const NO_FUNDAMENTALS: ReadonlySet<string> = new Set(["FOREX", "CC", "INDX", "MONEY", "GBOND", "COMM", "EUFUND"]);

export type SymbolKind = "security" | "forex" | "crypto" | "index" | "other";

export function symbolKind(exchange: string): SymbolKind {
  const ex = exchange.toUpperCase();
  if (ex === "FOREX") return "forex";
  if (ex === "CC") return "crypto";
  if (ex === "INDX") return "index";
  if (NO_FUNDAMENTALS.has(ex)) return "other";
  return "security";
}

export function hasFundamentals(exchange: string): boolean {
  return symbolKind(exchange) === "security";
}
