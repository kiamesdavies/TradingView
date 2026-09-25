// Pure parsers for the EODHD payloads the universe pipeline consumes (see parsers.test.ts).
import { timingOf } from "./derive";
import { isoDate, num, str, values } from "./util";

export type UniverseKind = "stock" | "etf";

export interface UniverseSymbolRow {
  symbol: string; // "AAPL.US"
  code: string;
  name: string;
  exchange: string;
  kind: UniverseKind;
  isin: string | null;
}

const STOCK_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "NYSE MKT"]);
const ETF_EXCHANGES = new Set(["NYSE ARCA", "NASDAQ", "BATS", "NYSE", "AMEX"]);

/** /exchange-symbol-list/US → listed common stocks and ETFs. */
export function filterSymbolList(raw: unknown): UniverseSymbolRow[] {
  const out = new Map<string, UniverseSymbolRow>();
  for (const r of values<Record<string, unknown>>(raw)) {
    const code = str(r?.Code);
    const type = str(r?.Type);
    const exchange = str(r?.Exchange)?.toUpperCase() ?? "";
    if (!code || !type || /[\s^/]/.test(code)) continue;
    let kind: UniverseKind | null = null;
    if (type === "Common Stock" && STOCK_EXCHANGES.has(exchange)) kind = "stock";
    else if (type === "ETF" && ETF_EXCHANGES.has(exchange)) kind = "etf";
    if (!kind) continue;
    const symbol = `${code}.US`;
    out.set(symbol, { symbol, code, name: str(r?.Name) ?? code, exchange: exchange === "NYSE MKT" ? "AMEX" : exchange, kind, isin: str(r?.Isin) });
  }
  return [...out.values()];
}

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

/** /eod-bulk-last-day/US rows (plain or filter=extended). Rows without a usable close are dropped. */
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

/** /eod-bulk-last-day/US?type=splits|dividends */
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

/** /calendar/earnings → US rows only. */
export function parseEarningsCalendar(raw: unknown): CalendarEarnings[] {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).earnings : raw;
  const out: CalendarEarnings[] = [];
  for (const r of values<Record<string, unknown>>(list)) {
    const code = str(r?.code);
    const reportDate = isoDate(r?.report_date);
    if (!code || !reportDate || !code.endsWith(".US")) continue;
    out.push({ symbol: code, reportDate, timing: timingOf(r?.before_after_market), hasActual: num(r?.actual) !== null });
  }
  return out;
}

export interface EarningsDates { next: { date: string; timing: "bmo" | "amc" | null } | null; last: string | null }

/** Per symbol: next report on/after `today`, and the latest report before `today` (or today, when already reported). */
export function earningsBySymbol(rows: CalendarEarnings[], today: string): Map<string, EarningsDates> {
  const out = new Map<string, EarningsDates>();
  for (const r of rows) {
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

/** /fundamentals/GSPC.INDX?filter=Components → ["AAPL.US", …] */
export function parseIndexComponents(raw: unknown): string[] {
  const rows = raw && typeof raw === "object" && (raw as Record<string, unknown>).Components ? (raw as Record<string, unknown>).Components : raw;
  const out = new Set<string>();
  for (const r of values<Record<string, unknown>>(rows)) {
    const code = str(r?.Code);
    if (!code) continue;
    const ex = str(r?.Exchange) ?? "US";
    out.add(`${code.replace(/\./g, "-")}.${ex === "US" || /nyse|nasdaq|amex|bats/i.test(ex) ? "US" : ex}`);
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
      if (typeof s !== "string" || !s.endsWith(".US")) continue;
      if ((latest.get(s) ?? 0) < sec) latest.set(s, sec);
    }
  }
  return { latest, oldest, count };
}
