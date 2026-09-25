// FX normalisation (pure; see fx.test.ts).
//
// Some exchanges quote in a minor unit: LSE mostly in pence (GBX), Johannesburg in cents (ZAC), Tel Aviv in
// agorot (ILA). EODHD's per-share fundamentals for such stocks (EPS, book value, dividend/share, market cap)
// are in the MAJOR unit (verified LLOY.LSE: price 108.9 GBX, EPS 0.08 GBP, MarketCapitalization in GBP), while
// prices and analyst targets are in the quote (minor) unit. Rates are fetched as <MAJOR>USD.FOREX.
import { num, values } from "./util";

/** Minor-unit currency codes → major currency + factor (minor × factor = major). */
export const MINOR_UNITS: Record<string, { major: string; factor: number }> = {
  GBX: { major: "GBP", factor: 0.01 },
  GBp: { major: "GBP", factor: 0.01 },
  ZAC: { major: "ZAR", factor: 0.01 },
  ZAc: { major: "ZAR", factor: 0.01 },
  ILA: { major: "ILS", factor: 0.01 },
  ILa: { major: "ILS", factor: 0.01 },
};

/** Major currency and the factor that converts an amount in `cur` into it. Unknown/empty → itself, 1. */
export function majorOf(cur: string | null | undefined): { currency: string; factor: number } {
  if (!cur) return { currency: "", factor: 1 };
  const m = MINOR_UNITS[cur] ?? MINOR_UNITS[cur.toUpperCase()];
  return m ? { currency: m.major, factor: m.factor } : { currency: cur.toUpperCase(), factor: 1 };
}

export const isMinorUnit = (cur: string | null | undefined): boolean => !!cur && majorOf(cur).factor !== 1;

/** EODHD forex symbols needed to convert the given currencies to USD (majors only, USD excluded, sorted). */
export function fxSymbols(currencies: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const c of currencies) {
    const { currency } = majorOf(c);
    if (currency && currency !== "USD" && /^[A-Z]{3}$/.test(currency)) out.add(`${currency}USD.FOREX`);
  }
  return [...out].sort();
}

/** /real-time payload (single object or array) → major currency → USD rate. Uses close, else previousClose. */
export function parseFxQuotes(raw: unknown): Map<string, number> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const out = new Map<string, number>();
  for (const q of values<Record<string, unknown>>(list)) {
    const code = typeof q?.code === "string" ? q.code : "";
    const m = /^([A-Z]{3})USD\.FOREX$/.exec(code);
    if (!m) continue;
    const close = num(q.close);
    const prev = num(q.previousClose);
    const rate = close !== null && close > 0 ? close : prev !== null && prev > 0 ? prev : null;
    if (rate !== null) out.set(m[1]!, rate);
  }
  return out;
}

/** Rate that converts one unit of `cur` (possibly a minor unit) into USD; null when unknown. */
export function rateToUsd(cur: string | null | undefined, rates: ReadonlyMap<string, number>): number | null {
  if (!cur) return null;
  const { currency, factor } = majorOf(cur);
  if (currency === "USD") return factor;
  const r = rates.get(currency);
  return r === undefined ? null : r * factor;
}

/**
 * Quote currency of a symbol's prices: the exchange symbol list's Currency (authoritative for the listing),
 * else fundamentals' General.CurrencyCode, else the market default.
 */
export function quoteCurrency(listCurrency: string | null | undefined, fundCurrency: string | null | undefined, marketCurrency: string): string {
  const ok = (c: string | null | undefined): c is string => !!c && /^[A-Za-z]{3}$/.test(c) && c.toUpperCase() !== "NA";
  if (ok(listCurrency)) return MINOR_UNITS[listCurrency] ? listCurrency : listCurrency.toUpperCase();
  if (ok(fundCurrency)) return MINOR_UNITS[fundCurrency] ? fundCurrency : fundCurrency.toUpperCase();
  return marketCurrency;
}

/** USD value of an amount in `cur` (null in → null out). */
export function toUsd(amount: number | null | undefined, rate: number | null): number | null {
  if (amount === null || amount === undefined || rate === null || !Number.isFinite(amount)) return null;
  const v = amount * rate;
  return Number.isFinite(v) ? v : null;
}
