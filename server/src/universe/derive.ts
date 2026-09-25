// Pure derivation of universe_metrics fundamental/ownership/analyst/ETF columns from raw EODHD fundamentals JSON.
// Values arrive as numbers, numeric strings, "NA" or null; everything is parsed defensively (see derive.test.ts).
// Price-dependent ratios (P/E, P/S, market cap, yield, target upside…) are recomputed daily from the stored
// inputs via priceDependent(), so they track the latest close instead of the fetch-day price.
import { majorOf } from "./fx";
import { addDays, cagr, daysBetween, div, isoDate, num, pctChange, pos, str, times100, values } from "./util";

type Raw = Record<string, any>;
export type Row = Record<string, number | string | null>;

/** Columns written from fundamentals that do not depend on the latest price. */
export const STATIC_FUND_COLUMNS = [
  "sector", "industry", "country", "currency", "ipo_date", "employees", "shares_outstanding", "shares_float", "beta",
  "peg", "ev_ebitda", "ev_sales", "eps_ttm", "payout_ratio", "dividend_growth_3y",
  "eps_growth_this_y", "eps_growth_next_y", "eps_growth_qoq", "eps_growth_ttm", "eps_growth_past_3y", "eps_growth_past_5y",
  "eps_growth_next_5y", "sales_growth_qoq", "sales_growth_ttm", "sales_growth_past_3y", "sales_growth_past_5y", "eps_surprise_pct",
  "roa", "roe", "roic", "gross_margin", "oper_margin", "net_margin", "current_ratio", "quick_ratio", "lt_debt_eq", "debt_eq",
  "insider_own", "insider_trans", "inst_own", "inst_trans", "short_float", "short_ratio",
  "analyst_recom", "target_price",
  "etf_expense_ratio", "etf_aum", "etf_sponsor", "etf_category", "etf_holdings_count",
] as const;

/** Columns recomputed from the latest price + stored inputs. */
export const PRICE_FUND_COLUMNS = ["market_cap", "pe", "forward_pe", "ps", "pb", "pcash", "pfcf", "dividend_yield", "target_upside_pct"] as const;

export interface FundInputs {
  sharesOutstanding: number | null;
  marketCapFallback: number | null;
  epsTtm: number | null;
  epsNextY: number | null;
  forwardPeFallback: number | null;
  revenueTtm: number | null;
  psFallback: number | null;
  bookPerShare: number | null;
  pbFallback: number | null;
  cashSti: number | null;
  fcfTtm: number | null;
  divRate: number | null;
  divYieldFallback: number | null; // %
  targetPrice: number | null;
}

export interface EarningsInfo {
  next: { date: string; timing: "bmo" | "amc" | null } | null;
  last: string | null;
}

export interface DerivedFundamentals {
  kind: "stock" | "etf";
  cols: Row;
  inputs: FundInputs;
  earnings: EarningsInfo;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function timingOf(v: unknown): "bmo" | "amc" | null {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s.startsWith("before")) return "bmo";
  if (s.startsWith("after")) return "amc";
  return null;
}

interface Stmt { date: string; row: Raw }
/** Statements sorted newest first, with a valid date. */
function statements(section: unknown): Stmt[] {
  const out: Stmt[] = [];
  if (section && typeof section === "object") {
    for (const [k, row] of Object.entries(section as Raw)) {
      const date = isoDate((row as Raw)?.date) ?? isoDate(k);
      if (date && row && typeof row === "object") out.push({ date, row: row as Raw });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Sum of `field` over quarters [from, from+4) when all four exist and span about a year. */
function ttm(qs: Stmt[], field: string, from = 0, map: (r: Raw) => number | null = (r) => num(r[field])): number | null {
  if (qs.length < from + 4) return null;
  const span = daysBetween(qs[from + 3]!.date, qs[from]!.date);
  if (span < 250 || span > 300) return null;
  let s = 0;
  for (let i = from; i < from + 4; i++) {
    const v = map(qs[i]!.row);
    if (v === null) return null;
    s += v;
  }
  return s;
}

/** Index of the entry about one year before entry `i` (±25 days), or -1. */
function yearAgo(list: { date: string }[], i: number): number {
  const target = addDays(list[i]!.date, -365);
  for (let j = i + 1; j < list.length; j++) if (Math.abs(daysBetween(list[j]!.date, target)) <= 25) return j;
  return -1;
}

function latest(qs: Stmt[], ys: Stmt[]): Raw | null {
  return qs[0]?.row ?? ys[0]?.row ?? null;
}

function totalDebt(bs: Raw): number | null {
  const total = num(bs.shortLongTermDebtTotal);
  if (total !== null) return total;
  const st = num(bs.shortTermDebt), lt = num(bs.longTermDebt);
  return st === null && lt === null ? null : (st ?? 0) + (lt ?? 0);
}

function yearsBetween(a: string, b: string): number {
  return Math.round(daysBetween(a, b) / 365.25);
}

/** CAGR between the newest entry and the one `years` fiscal years back (matched by date). */
function cagrYears(list: { date: string; v: number | null }[], years: number): number | null {
  if (!list.length) return null;
  const end = list[0]!;
  const start = list.find((x) => yearsBetween(x.date, end.date) === years);
  return start ? cagr(end.v, start.v, years) : null;
}

export function deriveFundamentals(raw: Raw, today: string): DerivedFundamentals {
  const G: Raw = raw?.General ?? {};
  const H: Raw = raw?.Highlights ?? {};
  const V: Raw = raw?.Valuation ?? {};
  const S: Raw = raw?.SharesStats ?? {};
  const T: Raw = raw?.Technicals ?? {};
  const SD: Raw = raw?.SplitsDividends ?? {};
  const AR: Raw = raw?.AnalystRatings ?? {};
  const E: Raw = raw?.Earnings ?? {};
  const F: Raw = raw?.Financials ?? {};
  const ETF: Raw | null = raw?.ETF_Data && typeof raw.ETF_Data === "object" ? raw.ETF_Data : null;
  const kind: "stock" | "etf" = ETF || /etf|fund/i.test(String(G.Type ?? "")) ? "etf" : "stock";

  const cols: Row = {};
  for (const c of STATIC_FUND_COLUMNS) cols[c] = null;

  // ---- descriptive
  cols.sector = str(G.Sector) ?? str(G.GicSector);
  cols.industry = str(G.Industry) ?? str(G.GicIndustry);
  cols.country = issuerCountry(G) ?? str(ETF?.Domicile);
  cols.currency = str(G.CurrencyCode);
  // Foreign filers / ADRs: EODHD quotes price, market cap, trailing EPS and book value in the trading currency but
  // statements, revenue and estimates in the reporting currency (BABA: USD vs CNY). Ratios mixing the two are off
  // by the FX rate, so statement-based price inputs are dropped when the currencies differ.
  const fxMismatch = reportingCurrencyDiffers(raw, cols.currency);
  cols.ipo_date = isoDate(G.IPODate) ?? isoDate(ETF?.Inception_Date);
  const emp = pos(G.FullTimeEmployees);
  cols.employees = emp === null ? null : Math.round(emp);

  const isQ = statements(F.Income_Statement?.quarterly), isY = statements(F.Income_Statement?.yearly);
  const bsQ = statements(F.Balance_Sheet?.quarterly), bsY = statements(F.Balance_Sheet?.yearly);
  const cfQ = statements(F.Cash_Flow?.quarterly), cfY = statements(F.Cash_Flow?.yearly);

  const outstandingQ = values<Raw>(raw?.outstandingShares?.quarterly)
    .map((x) => ({ date: isoDate(x?.dateFormatted) ?? "", v: pos(x?.shares) }))
    .filter((x) => x.date && x.v !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const shares = pos(S.SharesOutstanding) ?? outstandingQ[0]?.v ?? pos(bsQ[0]?.row.commonStockSharesOutstanding);
  cols.shares_outstanding = shares;
  cols.shares_float = pos(S.SharesFloat);
  cols.beta = num(T.Beta);

  // ---- earnings history (quarterly EPS)
  const hist = values<Raw>(E.History)
    .map((h) => ({
      date: isoDate(h?.date) ?? "",
      reportDate: isoDate(h?.reportDate),
      actual: num(h?.epsActual),
      estimate: num(h?.epsEstimate),
      surprise: num(h?.surprisePercent),
      timing: timingOf(h?.beforeAfterMarket),
    }))
    .filter((h) => h.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const reported = hist.filter((h) => h.actual !== null && (!h.reportDate || h.reportDate <= today));
  const upcoming = hist
    .filter((h) => h.actual === null && h.reportDate && h.reportDate >= today)
    .sort((a, b) => (a.reportDate! < b.reportDate! ? -1 : 1));
  const earnings: EarningsInfo = {
    next: upcoming[0] ? { date: upcoming[0].reportDate!, timing: upcoming[0].timing } : null,
    last: reported.map((h) => h.reportDate).filter((d): d is string => !!d).sort().pop() ?? null,
  };

  const sumEps = (from: number): number | null => {
    if (reported.length < from + 4) return null;
    const span = daysBetween(reported[from + 3]!.date, reported[from]!.date);
    if (span < 250 || span > 300) return null;
    return reported.slice(from, from + 4).reduce((s, h) => s + h.actual!, 0);
  };
  const epsTtm = num(H.DilutedEpsTTM) ?? num(H.EarningsShare) ?? (fxMismatch ? null : sumEps(0));
  cols.eps_ttm = epsTtm;
  if (reported[0]) {
    const j = yearAgo(reported, 0);
    cols.eps_growth_qoq = j >= 0 ? pctChange(reported[0].actual, reported[j]!.actual) : null;
    cols.eps_surprise_pct = reported[0].surprise ?? pctChange(reported[0].actual, reported[0].estimate);
  }
  cols.eps_growth_ttm = pctChange(sumEps(0), sumEps(4));

  // ---- estimates (Earnings.Trend)
  const trend = values<Raw>(E.Trend);
  // Trend keeps old snapshots too (several "0y" rows): use the newest entry for each period.
  const tp = (p: string): Raw | null => {
    let best: Raw | null = null;
    for (const t of trend) {
      if (t?.period !== p) continue;
      if (!best || String(t.date ?? "") > String(best.date ?? "")) best = t;
    }
    return best;
  };
  const t0 = tp("0y"), t1 = tp("+1y"), t5 = tp("+5y");
  const estThis = num(t0?.earningsEstimateAvg) ?? num(H.EPSEstimateCurrentYear);
  const estNext = num(t1?.earningsEstimateAvg) ?? num(H.EPSEstimateNextYear);
  cols.eps_growth_this_y = pctChange(estThis, num(t0?.earningsEstimateYearAgoEps)) ?? times100(num(t0?.growth));
  cols.eps_growth_next_y = pctChange(estNext, estThis);
  const peg = pos(H.PEGRatio);
  cols.peg = peg;
  const trailingPe = pos(H.PERatio) ?? pos(V.TrailingPE);
  cols.eps_growth_next_5y = times100(num(t5?.growth)) ?? (peg && trailingPe ? trailingPe / peg : null);

  // ---- annual EPS (Earnings.Annual includes a partial current year: keep fiscal-year-end rows only)
  const fyMonth = MONTHS.indexOf(String(G.FiscalYearEnd ?? "").toLowerCase()) + 1 || (isY[0] ? Number(isY[0].date.slice(5, 7)) : 0);
  const annual = values<Raw>(E.Annual)
    .map((a) => ({ date: isoDate(a?.date) ?? "", v: num(a?.epsActual) }))
    .filter((a) => a.date && (!fyMonth || Number(a.date.slice(5, 7)) === fyMonth))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  cols.eps_growth_past_3y = cagrYears(annual, 3);
  cols.eps_growth_past_5y = cagrYears(annual, 5);

  // ---- revenue growth
  const revQ = isQ.map((q) => ({ date: q.date, v: num(q.row.totalRevenue) }));
  if (revQ[0]) {
    const j = yearAgo(revQ, 0);
    cols.sales_growth_qoq = j >= 0 ? pctChange(revQ[0].v, revQ[j]!.v) : null;
  }
  cols.sales_growth_ttm = pctChange(ttm(isQ, "totalRevenue", 0), ttm(isQ, "totalRevenue", 4));
  const revY = isY.map((y) => ({ date: y.date, v: num(y.row.totalRevenue) }));
  cols.sales_growth_past_3y = cagrYears(revY, 3);
  cols.sales_growth_past_5y = cagrYears(revY, 5);

  // ---- profitability
  const revenueTtm = pos(H.RevenueTTM) ?? ttm(isQ, "totalRevenue") ?? pos(isY[0]?.row.totalRevenue);
  cols.roa = times100(num(H.ReturnOnAssetsTTM));
  cols.roe = times100(num(H.ReturnOnEquityTTM));
  const grossTtm = num(H.GrossProfitTTM) ?? ttm(isQ, "grossProfit");
  cols.gross_margin = revenueTtm ? times100(div(grossTtm, revenueTtm)) : null;
  // EODHD reports 0 (not NA) for loss-makers' TTM margins: treat 0 as missing and prefer the statement-based ratio.
  const nz = (v: unknown): number | null => (num(v) === 0 ? null : num(v));
  const margin = (field: string, reported: unknown): number | null => {
    const fromStatements = revenueTtm ? times100(div(ttm(isQ, field), revenueTtm)) : null;
    return times100(nz(reported)) ?? fromStatements; // a bare 0 with no statements stays unknown
  };
  cols.oper_margin = margin("operatingIncome", H.OperatingMarginTTM);
  cols.net_margin = margin("netIncome", H.ProfitMargin);

  const bs = latest(bsQ, bsY);
  const equity = bs ? num(bs.totalStockholderEquity) : null;
  const debt = bs ? totalDebt(bs) : null;
  if (bs) {
    const ca = num(bs.totalCurrentAssets), cl = pos(bs.totalCurrentLiabilities);
    cols.current_ratio = div(ca, cl);
    cols.quick_ratio = ca !== null && cl ? (ca - (num(bs.inventory) ?? 0)) / cl : null;
    if (equity !== null && equity > 0) {
      const lt = num(bs.longTermDebt) ?? num(bs.longTermDebtTotal);
      cols.lt_debt_eq = lt === null ? (debt === null ? null : 0) : lt / equity;
      cols.debt_eq = debt === null ? null : debt / equity;
    }
  }
  const opInc = ttm(isQ, "operatingIncome") ?? num(isY[0]?.row.operatingIncome);
  if (opInc !== null && equity !== null) {
    const pretax = ttm(isQ, "incomeBeforeTax") ?? num(isY[0]?.row.incomeBeforeTax);
    const tax = ttm(isQ, "incomeTaxExpense") ?? num(isY[0]?.row.incomeTaxExpense);
    let rate = pretax && pretax > 0 && tax !== null ? tax / pretax : 0.21;
    rate = Math.min(0.5, Math.max(0, rate));
    const invested = (debt ?? 0) + equity;
    cols.roic = invested > 0 ? ((opInc * (1 - rate)) / invested) * 100 : null;
  }

  // ---- dividends
  cols.payout_ratio = times100(num(SD.PayoutRatio));
  const dps = cfY.map((y) => {
    const paid = num(y.row.dividendsPaid);
    const sh = pos(bsY.find((b) => b.date === y.date)?.row.commonStockSharesOutstanding);
    return { date: y.date, v: paid !== null && sh ? Math.abs(paid) / sh : null };
  });
  cols.dividend_growth_3y = cagrYears(dps, 3);

  // ---- valuation (static parts)
  cols.ev_ebitda = num(V.EnterpriseValueEbitda);
  cols.ev_sales = num(V.EnterpriseValueRevenue);

  // ---- ownership
  const insiderPct = num(S.PercentInsiders);
  cols.insider_own = insiderPct;
  cols.inst_own = num(S.PercentInstitutions);
  const insiders = values<Raw>(raw?.InsiderTransactions);
  if (insiders.length) {
    const since = addDays(today, -182);
    let net = 0;
    for (const t of insiders) {
      const d = isoDate(t?.transactionDate) ?? isoDate(t?.date);
      const code = String(t?.transactionCode ?? "").toUpperCase();
      const amt = num(t?.transactionAmount);
      if (!d || d < since || amt === null || (code !== "P" && code !== "S")) continue;
      const ad = String(t?.transactionAcquiredDisposed ?? (code === "P" ? "A" : "D")).toUpperCase();
      net += ad === "A" ? Math.abs(amt) : -Math.abs(amt);
    }
    const held = shares && insiderPct && insiderPct > 0 ? (shares * insiderPct) / 100 : null;
    cols.insider_trans = held ? (net / held) * 100 : null;
  }
  const inst = values<Raw>(raw?.Holders?.Institutions);
  if (inst.length) {
    let chg = 0, before = 0;
    for (const h of inst) {
      const cur = num(h?.currentShares), c = num(h?.change);
      if (cur === null || c === null) continue;
      chg += c;
      before += cur - c;
    }
    cols.inst_trans = before > 0 ? (chg / before) * 100 : null;
  }
  const shortFrac = num(S.ShortPercentFloat) ?? num(T.ShortPercent);
  cols.short_float = times100(shortFrac);
  cols.short_ratio = num(T.ShortRatio) ?? num(S.ShortRatio);

  // ---- analysts
  const rating = num(AR.Rating);
  cols.analyst_recom = rating !== null && rating >= 1 && rating <= 5 ? 6 - rating : null;
  const target = pos(AR.TargetPrice) ?? pos(H.WallStreetTargetPrice);
  cols.target_price = target;

  // ---- ETF
  let etfYield: number | null = null;
  if (ETF) {
    cols.etf_expense_ratio = times100(num(ETF.NetExpenseRatio)) ?? times100(num(ETF.Ongoing_Charge));
    cols.etf_aum = pos(ETF.TotalAssets);
    cols.etf_sponsor = str(ETF.Company_Name);
    cols.etf_category = str(G.Category) ?? str(ETF.Category) ?? dominantAssetClass(ETF.Asset_Allocation);
    const hc = pos(ETF.Holdings_Count) ?? (values(ETF.Holdings).length || null);
    cols.etf_holdings_count = hc === null ? null : Math.round(hc);
    etfYield = num(ETF.Yield);
  }

  // ---- price-dependent inputs
  const q = latest(bsQ, bsY);
  const cashSti = q ? pos(q.cashAndShortTermInvestments) ?? sumPos(q.cash, q.shortTermInvestments) ?? pos(q.cashAndEquivalents) : null;
  const fcfTtm =
    ttm(cfQ, "freeCashFlow") ??
    ttm(cfQ, "", 0, (r) => {
      const ocf = num(r.totalCashFromOperatingActivities), capex = num(r.capitalExpenditures);
      return ocf === null ? null : ocf - Math.abs(capex ?? 0);
    }) ??
    num(cfY[0]?.row.freeCashFlow);
  const divRate = num(SD.ForwardAnnualDividendRate) ?? (fxMismatch ? null : num(H.DividendShare));
  const inputs: FundInputs = {
    sharesOutstanding: shares,
    marketCapFallback: pos(H.MarketCapitalization),
    epsTtm,
    // Mismatch: estimates are in the reporting currency; EODHD's ForwardPE is computed consistently.
    epsNextY: fxMismatch ? null : estNext,
    forwardPeFallback: pos(V.ForwardPE),
    // Mismatch: EODHD's own PriceSalesTTM divides USD market cap by CNY revenue too, so no P/S at all.
    revenueTtm: fxMismatch ? null : revenueTtm,
    psFallback: fxMismatch ? null : pos(V.PriceSalesTTM),
    bookPerShare: fxMismatch ? null : num(H.BookValue),
    pbFallback: pos(V.PriceBookMRQ),
    cashSti: fxMismatch ? null : cashSti,
    fcfTtm: fxMismatch ? null : fcfTtm,
    divRate,
    divYieldFallback: etfYield ?? times100(num(SD.ForwardAnnualDividendYield) ?? num(H.DividendYield)),
    targetPrice: target,
  };
  return { kind, cols, inputs, earnings };
}

const US_NAMES = new Set(["usa", "us", "united states", "united states of america"]);

/**
 * EODHD sets General.CountryName to "USA" for most US-listed foreign issuers (BABA: CountryName "USA",
 * AddressData.Country "China"), so a non-US headquarters address wins.
 */
export function issuerCountry(G: Raw): string | null {
  const name = str(G?.CountryName);
  const addr = str(G?.AddressData?.Country) ?? str(G?.AddressData?.country);
  if (addr && !US_NAMES.has(addr.toLowerCase())) return addr;
  return name ?? addr;
}

/** Statement currency (Financials.*.currency_symbol, else Earnings.History currency) differs from the trading one. */
function reportingCurrencyDiffers(raw: Raw, trading: string | number | null): boolean {
  if (typeof trading !== "string" || !trading) return false;
  const F: Raw = raw?.Financials ?? {};
  let rep: string | null = null;
  for (const k of ["Income_Statement", "Balance_Sheet", "Cash_Flow"]) {
    rep = str(F[k]?.currency_symbol);
    if (rep) break;
  }
  if (!rep) {
    const hist = values<Raw>(raw?.Earnings?.History).filter((h) => str(h?.currency));
    hist.sort((a, b) => (String(a?.date ?? "") < String(b?.date ?? "") ? 1 : -1));
    rep = str(hist[0]?.currency);
  }
  // Pence-quoted LSE stocks (GBX) report in GBP: same currency, different unit (handled by priceDependent's factor).
  return !!rep && majorOf(rep).currency !== majorOf(trading).currency;
}

function sumPos(a: unknown, b: unknown): number | null {
  const x = num(a), y = num(b);
  if (x === null && y === null) return null;
  const s = (x ?? 0) + (y ?? 0);
  return s > 0 ? s : null;
}

function dominantAssetClass(alloc: unknown): string | null {
  let best: string | null = null, bestV = -Infinity;
  if (alloc && typeof alloc === "object") {
    for (const [k, v] of Object.entries(alloc as Raw)) {
      const n = num((v as Raw)?.["Net_Assets_%"]);
      if (n !== null && n > bestV) { bestV = n; best = k; }
    }
  }
  return best;
}

/**
 * Ratios that move with the price. `price` null → fetch-time fallbacks. `unitFactor` converts the quote price
 * into the major currency unit the per-share fundamentals use (0.01 for GBX/pence), so market_cap is in the
 * major unit; the analyst target is quoted like the price and is compared unconverted.
 */
export function priceDependent(inp: FundInputs, price: number | null, unitFactor = 1): Row {
  const quote = price !== null && price > 0 ? price : null;
  const p = quote === null ? null : quote * unitFactor;
  const mcap = p && inp.sharesOutstanding ? p * inp.sharesOutstanding : inp.marketCapFallback;
  const out: Row = {};
  out.market_cap = mcap;
  out.pe = p && inp.epsTtm !== null && inp.epsTtm > 0 ? p / inp.epsTtm : null;
  out.forward_pe = p && inp.epsNextY !== null && inp.epsNextY > 0 ? p / inp.epsNextY : inp.epsNextY !== null && inp.epsNextY <= 0 ? null : inp.forwardPeFallback;
  out.ps = mcap && inp.revenueTtm ? mcap / inp.revenueTtm : inp.psFallback;
  out.pb = p && inp.bookPerShare !== null && inp.bookPerShare > 0 ? p / inp.bookPerShare : inp.bookPerShare !== null && inp.bookPerShare <= 0 ? null : inp.pbFallback;
  out.pcash = mcap && inp.cashSti ? mcap / inp.cashSti : null;
  out.pfcf = mcap && inp.fcfTtm !== null && inp.fcfTtm > 0 ? mcap / inp.fcfTtm : null;
  out.dividend_yield =
    p && inp.divRate !== null && inp.divRate > 0 ? (inp.divRate / p) * 100 : inp.divYieldFallback ?? (inp.divRate === 0 ? 0 : null);
  out.target_upside_pct = quote && inp.targetPrice ? (inp.targetPrice / quote - 1) * 100 : null;
  return out;
}
