// Pure parsers for the EODHD payloads the universe pipeline consumes (see parsers.test.ts).
import { timingOf } from "./derive";
import { MARKETS, type MarketDef } from "./markets";
import { isoDate, num, str, values } from "./util";

export type UniverseKind = "stock" | "etf";

export interface UniverseSymbolRow {
  symbol: string; // "AAPL.US", "SIVE.ST"
  code: string;
  name: string;
  exchange: string;
  kind: UniverseKind;
  isin: string | null;
  /** Quote currency from the symbol list (e.g. "GBX" for pence-quoted LSE lines). */
  currency?: string | null;
}

/** /exchange-symbol-list/{EX} → the market's listed common stocks (and ETFs where the market admits them). */
export function filterSymbolList(raw: unknown, market: MarketDef = US_MARKET): UniverseSymbolRow[] {
  const f = market.filter;
  const stockEx = f.stockExchanges ? new Set(f.stockExchanges) : null;
  const etfEx = f.etfExchanges ? new Set(f.etfExchanges) : null;
  const curs = f.currencies ? new Set(f.currencies) : null;
  const out = new Map<string, UniverseSymbolRow>();
  for (const r of values<Record<string, unknown>>(raw)) {
    const code = str(r?.Code);
    const type = str(r?.Type);
    const exchange = str(r?.Exchange)?.toUpperCase() ?? "";
    if (!code || !type || /[\s^/]/.test(code)) continue;
    if (f.excludeCode && f.excludeCode.test(code)) continue;
    const currency = str(r?.Currency);
    let kind: UniverseKind | null = null;
    if (f.stockTypes.includes(type) && (!stockEx || stockEx.has(exchange))) kind = "stock";
    else if (f.etfs && type === "ETF" && (!etfEx || etfEx.has(exchange))) kind = "etf";
    if (!kind) continue;
    if (curs && kind === "stock" && !(currency && curs.has(currency))) continue;
    const symbol = `${code}.${market.code}`;
    out.set(symbol, {
      symbol, code, name: str(r?.Name) ?? code, exchange: f.exchangeAlias?.[exchange] ?? (exchange || market.code), kind, isin: str(r?.Isin), currency,
    });
  }
  return [...out.values()];
}

const US_MARKET = MARKETS[0]!;

export interface BulkBar {
  code: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
  // filter=extended only
  marketCap: number | null;
  beta: number | null;
  hi250: number | null;
  lo250: number | null;
  avgVol50: number | null;
}

/** /eod-bulk-last-day/{EX} rows (plain or filter=extended). Rows without a usable close are dropped. */
export function parseBulk(raw: unknown): BulkBar[] {
  const out: BulkBar[] = [];
  for (const r of values<Record<string, unknown>>(raw)) {
    const code = str(r?.code);
    const date = isoDate(r?.date);
    const close = num(r?.close);
    if (!code || !date || close === null || close <= 0) continue;
    const adj = num(r?.adjusted_close);
    out.push({
      code,
      date,
      open: num(r?.open) ?? close,
      high: num(r?.high) ?? close,
      low: num(r?.low) ?? close,
      close,
      adjClose: adj !== null && adj > 0 ? adj : close,
      volume: num(r?.volume) ?? 0,
      marketCap: positive(r?.MarketCapitalization),
      beta: num(r?.Beta),
      hi250: positive(r?.hi_250d),
      lo250: positive(r?.lo_250d),
      avgVol50: positive(r?.avgvol_50d),
    });
  }
  return out;
}

function positive(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/** Most frequent date among bulk rows (the session the payload is for). */
export function dominantDate(rows: { date: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [d, c] of counts) if (c > n) { best = d; n = c; }
  return best;
}

export interface CorporateAction { code: string; date: string; kind: "split" | "dividend" }

/** /eod-bulk-last-day/{EX}?type=splits|dividends */
export function parseActions(raw: unknown, kind: "split" | "dividend"): CorporateAction[] {
  const out: CorporateAction[] = [];
  for (const r of values<Record<string, unknown>>(raw)) {
    const code = str(r?.code);
    const date = isoDate(r?.date);
    if (code && date) out.push({ code, date, kind });
  }
  return out;
}

export interface CalendarEarnings {
  symbol: string;
  reportDate: string;
  timing: "bmo" | "amc" | null;
  hasActual: boolean;
}

/** /calendar/earnings (worldwide) → rows whose symbol passes `accept` (default: US only). */
export function parseEarningsCalendar(raw: unknown, accept: (symbol: string) => boolean = (s) => s.endsWith(".US")): CalendarEarnings[] {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).earnings : raw;
  const out: CalendarEarnings[] = [];
  for (const r of values<Record<string, unknown>>(list)) {
    const code = str(r?.code);
    const reportDate = isoDate(r?.report_date);
    if (!code || !reportDate || !accept(code)) continue;
    out.push({ symbol: code, reportDate, timing: timingOf(r?.before_after_market), hasActual: num(r?.actual) !== null });
  }
  return out;
}

export interface EarningsDates { next: { date: string; timing: "bmo" | "amc" | null } | null; last: string | null }

/**
 * Per symbol: next report on/after its market's `today`, and the latest report before it (or today, when already
 * reported). `today` is a date or a function of the symbol (markets in different time zones).
 */
export function earningsBySymbol(rows: CalendarEarnings[], todayOf: string | ((symbol: string) => string)): Map<string, EarningsDates> {
  const out = new Map<string, EarningsDates>();
  for (const r of rows) {
    const today = typeof todayOf === "string" ? todayOf : todayOf(r.symbol);
    const e = out.get(r.symbol) ?? { next: null, last: null };
    const past = r.reportDate < today || (r.reportDate === today && r.hasActual);
    if (past) {
      if (!e.last || r.reportDate > e.last) e.last = r.reportDate;
    } else if (!e.next || r.reportDate < e.next.date) {
      e.next = { date: r.reportDate, timing: r.timing };
    }
    out.set(r.symbol, e);
  }
  return out;
}

/** /fundamentals/{IDX}.INDX?filter=Components → ["AAPL.US", "AZN.ST", …] */
export function parseIndexComponents(raw: unknown): string[] {
  const rows = raw && typeof raw === "object" && (raw as Record<string, unknown>).Components ? (raw as Record<string, unknown>).Components : raw;
  const out = new Set<string>();
  for (const r of values<Record<string, unknown>>(rows)) {
    const code = str(r?.Code);
    if (!code) continue;
    const ex = str(r?.Exchange) ?? "US";
    const us = ex === "US" || /nyse|nasdaq|amex|bats/i.test(ex);
    // US class shares use "-" in EODHD tickers (BRK-B); other exchanges keep their own codes.
    out.add(us ? `${code.replace(/\./g, "-")}.US` : `${code}.${ex.toUpperCase()}`);
  }
  return [...out];
}

/** /news → newest article time per symbol (unix seconds), plus the oldest time seen in the page. */
export function parseNews(raw: unknown): { latest: Map<string, number>; oldest: number | null; count: number } {
  const latest = new Map<string, number>();
  let oldest: number | null = null;
  let count = 0;
  for (const a of values<Record<string, unknown>>(raw)) {
    const t = Date.parse(String(a?.date ?? ""));
    if (!Number.isFinite(t)) continue;
    count++;
    const sec = Math.floor(t / 1000);
    if (oldest === null || sec < oldest) oldest = sec;
    for (const s of values<unknown>(a?.symbols)) {
      if (typeof s !== "string" || !s.includes(".")) continue;
      if ((latest.get(s) ?? 0) < sec) latest.set(s, sec);
    }
  }
  return { latest, oldest, count };
}

export interface ExchangeDetails { timezone: string | null; close: string | null; holidays: string[]; workingDays: string | null }

/** /exchange-details/{EX} → IANA zone, local close "HH:MM", full-day holiday dates (early closes are ignored). */
export function parseExchangeDetails(raw: unknown): ExchangeDetails {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  const holidays = new Set<string>();
  for (const h of values<Record<string, unknown>>(r.ExchangeHolidays)) {
    const d = isoDate(h?.Date);
    const type = str(h?.Type)?.toLowerCase();
    if (d && (!type || type === "official" || type === "bank")) holidays.add(d);
  }
  const close = str(r.TradingHours?.Close);
  return {
    timezone: str(r.Timezone),
    close: close && /^\d{2}:\d{2}/.test(close) ? close.slice(0, 5) : null,
    holidays: [...holidays].sort(),
    workingDays: str(r.TradingHours?.WorkingDays),
  };
}
