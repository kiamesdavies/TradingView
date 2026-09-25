// SymbolOverview assembly from raw fundamentals + live quote parts. Pure (clock passed in).
import type {
  EarningsPoint,
  ExtendedQuote,
  KeyStat,
  NewsItem,
  Quote,
  RevenuePoint,
  SymbolOverview,
  SymbolProfile,
} from "@eodview/shared";
import { earningsRows, isUpcoming, numOrNull } from "./events";
import type { ParsedSymbol, SymbolKind } from "./symbol";
import { dateToDay, nyClock } from "./time";
import { issuerCountry } from "../universe/derive";

type Raw = Record<string, any>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Raw => (isObj(v) ? v : {});
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v !== "NA" ? v.trim() : undefined);
/** 0 means "not available" for these EODHD fields (e.g. P/E of a loss-maker). */
const positive = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};
/** Fraction (0.2762) → percent (27.62). */
const fracPct = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n === null ? null : round(n * 100, 4);
};

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export const EARNINGS_QUARTERS = 8;
export const REVENUE_QUARTERS = 8;

export const logoPath = (symbol: string): string => `/api/symbols/${encodeURIComponent(symbol)}/logo`;

export interface OverviewInput {
  sym: ParsedSymbol;
  kind: SymbolKind;
  /** Raw EODHD fundamentals; null for forex/crypto/indices or when unavailable. */
  fundamentals: Raw | null;
  fundamentalsFetchedAt: number | null;
  quote: Quote | null;
  extended: ExtendedQuote | null;
  latestNews: NewsItem | null;
  avgVolume30d: number | null;
  /** Display name when there are no fundamentals (e.g. from symbol search). */
  fallbackName?: string;
  nowMs: number;
}

const KIND_TYPE: Record<SymbolKind, string> = {
  security: "Common Stock",
  forex: "Currency",
  crypto: "Crypto",
  index: "Index",
  other: "Other",
};

export function buildProfile(sym: ParsedSymbol, kind: SymbolKind, f: Raw | null, fallbackName?: string): SymbolProfile {
  const g = obj(f?.General);
  const type = text(g.Type) ?? KIND_TYPE[kind];
  const profile: SymbolProfile = {
    symbol: sym.symbol,
    name: text(g.Name) ?? fallbackName ?? sym.code,
    exchange: text(g.Exchange) ?? sym.exchange,
    type,
    isEtf: /etf/i.test(type),
  };
  const set = <K extends keyof SymbolProfile>(k: K, v: SymbolProfile[K] | undefined) => {
    if (v !== undefined && v !== null) profile[k] = v;
  };
  set("sector", text(g.Sector) ?? text(obj(f?.ETF_Data).Category));
  set("industry", text(g.Industry));
  set("country", issuerCountry(g) ?? undefined);
  set("currency", text(g.CurrencyCode));
  set("description", text(g.Description));
  set("website", text(g.WebURL) ?? text(obj(f?.ETF_Data).Company_URL));
  if (kind === "security") set("logoUrl", logoPath(sym.symbol));
  set("ipoDate", text(g.IPODate));
  set("employees", positive(g.FullTimeEmployees) ?? undefined);
  return profile;
}

export function buildEarnings(f: Raw | null, todayDay: number): { points: EarningsPoint[]; next: SymbolOverview["nextEarnings"] } {
  const rows = earningsRows(obj(f?.Earnings).History);
  const reported = rows.filter((r) => r.epsActual !== null).slice(-EARNINGS_QUARTERS);
  const upcoming = rows
    .filter((r) => isUpcoming(r, todayDay))
    .sort((a, b) => a.reportDate!.localeCompare(b.reportDate!))[0];
  const points: EarningsPoint[] = reported.map((r) => ({
    period: r.period,
    ...(r.reportDate ? { reportDate: r.reportDate } : {}),
    ...(r.timing ? { timing: r.timing } : {}),
    epsActual: r.epsActual,
    epsEstimate: r.epsEstimate,
    surprisePct: r.surprisePct === null ? null : round(r.surprisePct, 4),
    upcoming: false,
  }));
  let next: SymbolOverview["nextEarnings"] = null;
  if (upcoming) {
    points.push({
      period: upcoming.period,
      reportDate: upcoming.reportDate,
      ...(upcoming.timing ? { timing: upcoming.timing } : {}),
      epsActual: null,
      epsEstimate: upcoming.epsEstimate,
      surprisePct: null,
      upcoming: true,
    });
    next = {
      date: upcoming.reportDate!,
      ...(upcoming.timing ? { timing: upcoming.timing } : {}),
      epsEstimate: upcoming.epsEstimate,
      daysUntil: dateToDay(upcoming.reportDate!) - todayDay,
    };
  }
  return { points, next };
}

export function buildRevenue(f: Raw | null): RevenuePoint[] {
  const q = obj(obj(obj(f?.Financials).Income_Statement).quarterly);
  return Object.values(q)
    .filter((r): r is Raw => isObj(r) && typeof r.date === "string" && Number.isFinite(dateToDay(r.date)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-REVENUE_QUARTERS)
    .map((r) => ({ period: r.date as string, revenue: numOrNull(r.totalRevenue) }));
}

export function buildAnalyst(f: Raw | null): SymbolOverview["analyst"] {
  const a = f?.AnalystRatings;
  if (!isObj(a)) return null;
  const count = (v: unknown) => Math.max(0, Math.round(numOrNull(v) ?? 0));
  const res = {
    rating: positive(a.Rating),
    targetPrice: positive(a.TargetPrice) ?? positive(obj(f?.Highlights).WallStreetTargetPrice),
    strongBuy: count(a.StrongBuy),
    buy: count(a.Buy),
    hold: count(a.Hold),
    sell: count(a.Sell),
    strongSell: count(a.StrongSell),
  };
  const any = res.rating !== null || res.targetPrice !== null || res.strongBuy + res.buy + res.hold + res.sell + res.strongSell > 0;
  return any ? res : null;
}

/**
 * Ordered key stats. The first four (next earnings, volume, avg volume 30D, market cap) are always
 * present for securities; later ones are dropped when EODHD has no value. Percent stats use 5.2 = 5.2%.
 */
export function buildStats(
  kind: SymbolKind,
  f: Raw | null,
  quote: Quote | null,
  avgVolume30d: number | null,
  next: SymbolOverview["nextEarnings"],
): KeyStat[] {
  const stat = (key: string, label: string, value: number | string | null, format: KeyStat["format"]): KeyStat => ({ key, label, value, format });
  const volume = stat("volume", "Volume", quote ? quote.volume : null, "volume");
  const avgVol = stat("avg_volume_30d", "Average volume (30D)", avgVolume30d, "volume");
  if (kind !== "security") return [volume, avgVol];

  const h = obj(f?.Highlights), v = obj(f?.Valuation), s = obj(f?.SharesStats), t = obj(f?.Technicals);
  const sd = obj(f?.SplitsDividends), g = obj(f?.General), etf = obj(f?.ETF_Data);
  const isEtf = /etf/i.test(text(g.Type) ?? "");

  const head: KeyStat[] = [
    stat("next_earnings", "Next earnings report", next ? next.daysUntil : null, "days"),
    volume,
    avgVol,
    stat("market_cap", "Market capitalization", positive(h.MarketCapitalization) ?? (isEtf ? positive(etf.TotalAssets) : null), "money"),
  ];
  const etfYieldPct = numOrNull(etf.Yield); // ETF_Data.Yield is already a percent
  const divYield = numOrNull(sd.ForwardAnnualDividendYield) ?? numOrNull(h.DividendYield) ?? (etfYieldPct === null ? null : etfYieldPct / 100);
  const rest: KeyStat[] = [
    stat("pe", "P/E", positive(h.PERatio) ?? positive(v.TrailingPE), "ratio"),
    stat("forward_pe", "Forward P/E", positive(v.ForwardPE), "ratio"),
    stat("eps_ttm", "EPS (TTM)", numOrNull(h.DilutedEpsTTM) ?? numOrNull(h.EarningsShare), "money"),
    stat("revenue_ttm", "Revenue (TTM)", positive(h.RevenueTTM), "money"),
    stat("net_margin", "Net margin", fracPct(h.ProfitMargin), "pct"),
    stat("dividend_yield", "Dividend yield (FWD)", divYield === null ? null : round(divYield * 100, 4), "pct"),
    stat("beta", "Beta", numOrNull(t.Beta), "ratio"),
    stat("high_52w", "52 week high", positive(t["52WeekHigh"]), "money"),
    stat("low_52w", "52 week low", positive(t["52WeekLow"]), "money"),
    stat("shares_outstanding", "Shares outstanding", positive(s.SharesOutstanding), "number"),
    stat("float", "Shares float", positive(s.SharesFloat), "number"),
    stat("short_float", "Short % of float", fracPct(s.ShortPercentFloat ?? t.ShortPercent), "pct"),
    stat("insiders", "Insider ownership", numOrNull(s.PercentInsiders), "pct"),
    stat("institutions", "Institutional ownership", numOrNull(s.PercentInstitutions), "pct"),
    stat("employees", "Employees", positive(g.FullTimeEmployees), "number"),
    stat("next_earnings_date", "Next earnings date", next ? next.date : null, "date"),
    stat("ipo_date", "IPO date", text(g.IPODate) ?? text(etf.Inception_Date) ?? null, "date"),
  ];
  if (isEtf) {
    // market_cap already carries the fund's total assets for ETFs
    rest.unshift(stat("expense_ratio", "Expense ratio", fracPct(etf.NetExpenseRatio), "pct"));
  }
  return [...head, ...rest.filter((x) => x.value !== null)];
}

export function buildOverview(input: OverviewInput): SymbolOverview {
  const { sym, kind, quote } = input;
  const f = kind === "security" ? input.fundamentals : null;
  const todayDay = nyClock(input.nowMs).day; // earnings dates are exchange-local (US) dates
  const { points, next } = buildEarnings(f, todayDay);
  return {
    profile: buildProfile(sym, kind, f, input.fallbackName),
    quote,
    extended: input.extended,
    stats: buildStats(kind, f, quote, input.avgVolume30d, next),
    nextEarnings: next,
    earnings: points,
    revenue: buildRevenue(f),
    analyst: buildAnalyst(f),
    latestNews: input.latestNews,
    fundamentalsAsOf: f ? input.fundamentalsFetchedAt : null,
  };
}

/** Mean volume of the last `n` bars that have volume; null when none. */
export function averageVolume(bars: { volume: number }[], n = 30): number | null {
  const vols = bars.slice(-n).map((b) => b.volume).filter((v) => Number.isFinite(v) && v > 0);
  return vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null;
}
