// Finviz-style filter registry: every filter/option of Finviz's screener that can be computed from the
// `universe_metrics` columns compiles to a parameterised SQL predicate. Option values are Finviz's URL codes
// where practical (e.g. cap "largeover", pe "u15", sma50 "pa10", rsi "os30", earningsdate "todaybefore").
// Filters that cannot be computed are listed with available:false and a reason.
import type { ScreenerFilterDef, ScreenerGroup, ScreenerOption } from "@eodview/shared";
import {
  addDays, addMonths, addYears, MARKET_TZ, monthEnd, monthStart, wallToUnix, weekStart,
} from "./dates";
import { indexBySlug, indexMember } from "./indexes";
import { type CompileCtx, type Op, type Pred, type SqlParam } from "./sql";

export type Build = (ctx: CompileCtx) => Pred;
export interface OptionSpec extends ScreenerOption { build: Build }
export type CustomUnit = NonNullable<ScreenerFilterDef["custom"]>["unit"];

/** Options generated at request time from DISTINCT values of a text column. */
export interface DynamicSource {
  col: string;
  /** Finviz-like display label for a raw DB value. */
  label?: (raw: string) => string;
  /** Restrict the DISTINCT scan (e.g. only ETFs). SQL over whitelisted columns, no params. */
  kind?: "stock" | "etf";
}

export interface FilterSpec {
  id: string;
  /** Finviz URL prefix (`${code}_${option}`); defaults to `id`. */
  code?: string;
  /** Finviz option code → our option value, where they differ (both are accepted). */
  aliases?: Record<string, string>;
  /** US-only concept: outside the US it is available only when the market's data coverage says so. */
  usOnly?: boolean;
  /** Columns whose non-null fraction decides per-market availability (default: custom col, else all read columns). */
  coverageCols?: string[];
  /** Options valid in queries but listed per market by the engine (market index membership). */
  late?: (value: string) => Build | null;
  label: string;
  group: ScreenerGroup;
  appliesTo: ScreenerFilterDef["appliesTo"];
  options: OptionSpec[];
  /** Custom min/max compare this column (raw units: dollars, shares, percent points, YYYY-MM-DD). */
  custom?: { unit: CustomUnit; col: string };
  dynamic?: DynamicSource;
  available: boolean;
  unavailableReason?: string;
}

// ---------------------------------------------------------------- builders

const cmp = (col: string, op: Op, v: SqlParam): Build => (c) => ({ sql: `${c.col(col)} ${op} ?`, params: [v] });
/** lo <= col < hi (either bound optional) */
const within = (col: string, lo: number | null, hi: number | null, hiInclusive = false): Build => (c) => {
  const parts: string[] = [];
  const params: SqlParam[] = [];
  if (lo !== null) { parts.push(`${c.col(col)} >= ?`); params.push(lo); }
  if (hi !== null) { parts.push(`${c.col(col)} ${hiInclusive ? "<=" : "<"} ?`); params.push(hi); }
  return { sql: parts.join(" AND ") || "1", params };
};
const isIn = (col: string, vals: string[]): Build => (c) => ({
  sql: `${c.col(col)} IN (${vals.map(() => "?").join(", ")})`, params: [...vals],
});
const raw = (fn: (c: CompileCtx) => string): Build => (c) => ({ sql: fn(c), params: [] });

const opt = (value: string, label: string, build: Build): OptionSpec => ({ value, label, build });

type Fmt = (v: number) => string;
const plain: Fmt = (v) => String(v);
const pct: Fmt = (v) => `${v}%`;
const signedPct: Fmt = (v) => `${v > 0 ? "+" : ""}${v}%`;
const dollars: Fmt = (v) => `$${v}`;
/** thousands → "50K" / "1M" / "1.5M" */
const kVol: Fmt = (v) => (v >= 1000 ? `${v / 1000}M` : `${v}K`);
/** millions → "$50M" / "$1B" */
const mMoney: Fmt = (v) => (v >= 1000 ? `$${v / 1000}B` : `$${v}M`);

/** "Under X" options (strict <), value `u<v>`; `scale` converts the code value to column units. */
function unders(col: string, vals: number[], fmt: Fmt = plain, scale = 1, labelPrefix = "Under "): OptionSpec[] {
  return vals.map((v) => opt(`u${v}`, `${labelPrefix}${fmt(v)}`, cmp(col, "<", v * scale)));
}
function overs(col: string, vals: number[], fmt: Fmt = plain, scale = 1, labelPrefix = "Over "): OptionSpec[] {
  return vals.map((v) => opt(`o${v}`, `${labelPrefix}${fmt(v)}`, cmp(col, ">", v * scale)));
}
function steps(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Finviz growth vocabulary: Negative, Positive, Positive Low (0-10%), High (>X%), Under/Over 5..30%. */
function growthOptions(col: string, high = 25): OptionSpec[] {
  return [
    opt("neg", "Negative (<0%)", cmp(col, "<", 0)),
    opt("pos", "Positive (>0%)", cmp(col, ">", 0)),
    opt("poslow", "Positive Low (0-10%)", within(col, 0, 10, true)),
    opt("high", `High (>${high}%)`, cmp(col, ">", high)),
    ...unders(col, [5, 10, 15, 20, 25, 30], pct),
    ...overs(col, [5, 10, 15, 20, 25, 30], pct),
  ];
}

/** Finviz return-ratio vocabulary (ROA/ROE/ROIC). */
function returnOptions(col: string, veryPos: number, veryNeg: number): OptionSpec[] {
  return [
    opt("pos", "Positive (>0%)", cmp(col, ">", 0)),
    opt("neg", "Negative (<0%)", cmp(col, "<", 0)),
    opt("verypos", `Very Positive (>${veryPos}%)`, cmp(col, ">", veryPos)),
    opt("veryneg", `Very Negative (<${veryNeg}%)`, cmp(col, "<", veryNeg)),
    ...[-50, -45, -40, -35, -30, -25, -20, -15, -10, -5].map((v) => opt(`u${v}`, `Under ${v}%`, cmp(col, "<", v))),
    ...[5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((v) => opt(`o${v}`, `Over +${v}%`, cmp(col, ">", v))),
  ];
}

/** Finviz margin vocabulary. */
function marginOptions(col: string, high: number): OptionSpec[] {
  return [
    opt("pos", "Positive (>0%)", cmp(col, ">", 0)),
    opt("neg", "Negative (<0%)", cmp(col, "<", 0)),
    opt("high", `High (>${high}%)`, cmp(col, ">", high)),
    ...[90, 80, 70, 60, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0, -10, -20, -30, -50, -70, -100]
      .map((v) => opt(`u${v}`, `Under ${v}%`, cmp(col, "<", v))),
    ...[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90].map((v) => opt(`o${v}`, `Over ${v}%`, cmp(col, ">", v))),
  ];
}

/** Valuation ratio vocabulary (P/E etc.): Low/Profitable/High + Under/Over lists. */
function ratioOptions(col: string, o: { low?: number; high?: number; profitable?: boolean; negative?: boolean; u: number[]; o: number[] }): OptionSpec[] {
  const out: OptionSpec[] = [];
  if (o.negative) out.push(opt("neg", "Negative (<0)", cmp(col, "<", 0)));
  if (o.low !== undefined) out.push(opt("low", `Low (<${o.low})`, o.profitable ? within(col, 0, o.low) : cmp(col, "<", o.low)));
  if (o.profitable) out.push(opt("profitable", "Profitable (>0)", cmp(col, ">", 0)));
  if (o.high !== undefined) out.push(opt("high", `High (>${o.high})`, cmp(col, ">", o.high)));
  // Finviz "Under N" for valuation ratios implies a positive ratio (unprofitable companies are excluded).
  out.push(...o.u.map((v) => opt(`u${v}`, `Under ${v}`, within(col, 0, v))));
  out.push(...overs(col, o.o));
  return out;
}

function numFilter(
  id: string, label: string, group: ScreenerGroup, options: OptionSpec[], col: string, unit: CustomUnit,
  appliesTo: FilterSpec["appliesTo"] = "stock",
): FilterSpec {
  return { id, label, group, appliesTo, options, custom: { unit, col }, available: true };
}

function optFilter(id: string, label: string, group: ScreenerGroup, options: OptionSpec[], appliesTo: FilterSpec["appliesTo"] = "all"): FilterSpec {
  return { id, label, group, appliesTo, options, available: true };
}

function unavailable(id: string, label: string, group: ScreenerGroup, reason: string, appliesTo: FilterSpec["appliesTo"] = "stock"): FilterSpec {
  return { id, label, group, appliesTo, options: [], available: false, unavailableReason: reason };
}

// ---------------------------------------------------------------- descriptive

const EXCHANGE_LABELS: Record<string, string> = {
  NASDAQ: "NASDAQ", NYSE: "NYSE", AMEX: "AMEX", "NYSE MKT": "AMEX", "NYSE ARCA": "NYSE Arca", BATS: "Cboe BZX (BATS)", CBOE: "CBOE",
};
const SECTOR_LABELS: Record<string, string> = {
  "Financial Services": "Financial", "Consumer Discretionary": "Consumer Cyclical", "Consumer Staples": "Consumer Defensive",
  "Health Care": "Healthcare", "Information Technology": "Technology", Materials: "Basic Materials",
};
const USA_NAMES = ["USA", "United States", "United States of America", "US"];
const REGIONS: Record<string, { label: string; countries: string[] }> = {
  asia: { label: "Asia", countries: ["China", "Hong Kong", "India", "Indonesia", "Israel", "Japan", "Kazakhstan", "Macau", "Malaysia", "Philippines", "Singapore", "South Korea", "Korea", "Taiwan", "Thailand", "Vietnam", "United Arab Emirates", "Turkey", "Jordan", "Cyprus", "Mongolia"] },
  europe: { label: "Europe", countries: ["Austria", "Belgium", "Denmark", "Finland", "France", "Germany", "Greece", "Guernsey", "Iceland", "Ireland", "Isle of Man", "Italy", "Jersey", "Luxembourg", "Monaco", "Netherlands", "Norway", "Poland", "Portugal", "Russia", "Spain", "Sweden", "Switzerland", "United Kingdom", "UK", "Malta", "Gibraltar", "Czech Republic", "Hungary", "Ukraine", "Lithuania", "Estonia", "Latvia"] },
  latinamerica: { label: "Latin America", countries: ["Argentina", "Bahamas", "Belize", "Bermuda", "Brazil", "British Virgin Islands", "Cayman Islands", "Chile", "Colombia", "Costa Rica", "Dominican Republic", "Mexico", "Panama", "Peru", "Puerto Rico", "Uruguay", "Venezuela", "Guatemala"] },
  bric: { label: "BRIC", countries: ["Brazil", "Russia", "India", "China"] },
};

const capMoney = (b: number) => b * 1e9;
const descriptive: FilterSpec[] = [
  {
    id: "exch", label: "Exchange", group: "descriptive", appliesTo: "all", options: [], available: true,
    dynamic: { col: "exchange", label: (r) => EXCHANGE_LABELS[r.toUpperCase()] ?? r },
    aliases: { nasd: "nasdaq" },
  },
  {
    id: "idx", label: "Index", group: "descriptive", appliesTo: "stock", available: true, usOnly: true,
    coverageCols: ["in_sp500", "in_ndx", "in_dji"],
    late: (v) => { const o = indexBySlug(v); return o ? indexMember(o.id) : null; },
    options: [
      opt("sp500", "S&P 500", cmp("in_sp500", "=", 1)),
      opt("ndx", "NASDAQ 100", cmp("in_ndx", "=", 1)),
      opt("dji", "DJIA", cmp("in_dji", "=", 1)),
    ],
  },
  {
    id: "sec", label: "Sector", group: "descriptive", appliesTo: "stock", options: [], available: true,
    dynamic: { col: "sector", label: (r) => SECTOR_LABELS[r] ?? r, kind: "stock" },
    aliases: { financial: "financialservices" },
  },
  {
    id: "ind", label: "Industry", group: "descriptive", appliesTo: "all", available: true,
    options: [
      opt("stocksonly", "Stocks only (ex-Funds)", cmp("kind", "=", "stock")),
      opt("exchangetradedfund", "Exchange Traded Fund", cmp("kind", "=", "etf")),
    ],
    dynamic: { col: "industry", kind: "stock" },
  },
  {
    id: "geo", label: "Country", group: "descriptive", appliesTo: "all", available: true,
    options: [
      opt("usa", "USA", isIn("country", USA_NAMES)),
      opt("notusa", "Foreign (ex-USA)", (c) => ({
        sql: `${c.col("country")} IS NOT NULL AND ${c.col("country")} NOT IN (${USA_NAMES.map(() => "?").join(", ")})`,
        params: [...USA_NAMES],
      })),
      ...Object.entries(REGIONS).map(([k, r]) => opt(k, r.label, isIn("country", r.countries))),
    ],
    dynamic: { col: "country", label: (r) => (USA_NAMES.includes(r) ? "USA" : r) },
  },
  numFilter("cap", "Market Cap.", "descriptive", [
    opt("mega", "Mega ($200bln and more)", within("market_cap", capMoney(200), null)),
    opt("large", "Large ($10bln to $200bln)", within("market_cap", capMoney(10), capMoney(200))),
    opt("mid", "Mid ($2bln to $10bln)", within("market_cap", capMoney(2), capMoney(10))),
    opt("small", "Small ($300mln to $2bln)", within("market_cap", 300e6, capMoney(2))),
    opt("micro", "Micro ($50mln to $300mln)", within("market_cap", 50e6, 300e6)),
    opt("nano", "Nano (under $50mln)", within("market_cap", 0, 50e6)),
    opt("largeover", "+Large (over $10bln)", within("market_cap", capMoney(10), null)),
    opt("midover", "+Mid (over $2bln)", within("market_cap", capMoney(2), null)),
    opt("smallover", "+Small (over $300mln)", within("market_cap", 300e6, null)),
    opt("microover", "+Micro (over $50mln)", within("market_cap", 50e6, null)),
    opt("largeunder", "-Large (under $200bln)", within("market_cap", 0, capMoney(200))),
    opt("midunder", "-Mid (under $10bln)", within("market_cap", 0, capMoney(10))),
    opt("smallunder", "-Small (under $2bln)", within("market_cap", 0, capMoney(2))),
    opt("microunder", "-Micro (under $300mln)", within("market_cap", 0, 300e6)),
  ], "market_cap", "money"),
  { code: "fa_div", ...numFilter("div", "Dividend Yield", "descriptive", [
    opt("none", "None (0%)", (c) => ({ sql: `${c.col("dividend_yield")} IS NULL OR ${c.col("dividend_yield")} = 0`, params: [] })),
    opt("pos", "Positive (>0%)", cmp("dividend_yield", ">", 0)),
    opt("high", "High (>5%)", cmp("dividend_yield", ">", 5)),
    opt("veryhigh", "Very High (>10%)", cmp("dividend_yield", ">", 10)),
    ...overs("dividend_yield", steps(1, 10, 1), pct),
  ], "dividend_yield", "pct", "all"), coverageCols: ["dividend_yield", "payout_ratio", "fundamentals_at"] },
  { usOnly: true, ...numFilter("sh_short", "Float Short", "descriptive", [
    opt("low", "Low (<5%)", cmp("short_float", "<", 5)),
    opt("high", "High (>20%)", cmp("short_float", ">", 20)),
    ...unders("short_float", [5, 10, 15, 20, 25, 30], pct),
    ...overs("short_float", [5, 10, 15, 20, 25, 30], pct),
  ], "short_float", "pct") },
  numFilter("an_recom", "Analyst Recom.", "descriptive", [
    opt("strongbuy", "Strong Buy (1)", within("analyst_recom", null, 1.5)),
    opt("buybetter", "Buy or better", within("analyst_recom", null, 2.5)),
    opt("buy", "Buy", within("analyst_recom", 1.5, 2.5)),
    opt("holdbetter", "Hold or better", within("analyst_recom", null, 3.5)),
    opt("hold", "Hold", within("analyst_recom", 2.5, 3.5)),
    opt("holdworse", "Hold or worse", within("analyst_recom", 2.5, null)),
    opt("sell", "Sell", within("analyst_recom", 3.5, 4.5)),
    opt("sellworse", "Sell or worse", within("analyst_recom", 3.5, null)),
    opt("strongsell", "Strong Sell (5)", within("analyst_recom", 4.5, null)),
  ], "analyst_recom", "number"),
  numFilter("earningsdate", "Earnings Date", "descriptive", earningsOptions(), "earnings_date", "date"),
  numFilter("sh_avgvol", "Average Volume", "descriptive", [
    ...unders("avg_volume", [50, 100, 500, 750, 1000], kVol, 1000),
    ...overs("avg_volume", [50, 100, 200, 300, 400, 500, 750, 1000, 2000], kVol, 1000),
    opt("100to500", "100K to 500K", within("avg_volume", 100e3, 500e3, true)),
    opt("100to1000", "100K to 1M", within("avg_volume", 100e3, 1e6, true)),
    opt("500to1000", "500K to 1M", within("avg_volume", 500e3, 1e6, true)),
    opt("500to10000", "500K to 10M", within("avg_volume", 500e3, 10e6, true)),
  ], "avg_volume", "volume", "all"),
  numFilter("sh_relvol", "Relative Volume", "descriptive", [
    ...overs("rel_volume", [10, 5, 3, 2, 1.5, 1, 0.75, 0.5, 0.25]),
    ...unders("rel_volume", [2, 1.5, 1, 0.75, 0.5, 0.25, 0.1]),
  ], "rel_volume", "number", "all"),
  numFilter("sh_curvol", "Current Volume", "descriptive", [
    ...unders("volume", [50, 100, 500, 750, 1000], kVol, 1000),
    opt("o0", "Over 0", cmp("volume", ">", 0)),
    ...overs("volume", [50, 100, 200, 300, 400, 500, 750, 1000, 2000, 5000, 10000, 20000], kVol, 1000),
  ], "volume", "volume", "all"),
  numFilter("sh_price", "Price $", "descriptive", [
    ...unders("price", [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50], dollars),
    ...overs("price", [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100], dollars),
    ...([[1, 5], [1, 10], [1, 20], [5, 10], [5, 20], [5, 50], [10, 20], [10, 50], [20, 50], [50, 100]] as const)
      .map(([lo, hi]) => opt(`${lo}to${hi}`, `$${lo} to $${hi}`, within("price", lo, hi, true))),
  ], "price", "money", "all"),
  // Not a Finviz filter: turnover in USD, the comparable liquidity measure across markets.
  numFilter("sh_dollarvol", "Dollar Volume", "descriptive", [
    opt("u1", "Under $1M", cmp("dollar_volume_usd", "<", 1e6)),
    ...[1, 5, 10, 20, 50, 100].map((v) => opt(`o${v}`, `Over $${v}M`, cmp("dollar_volume_usd", ">", v * 1e6))),
  ], "dollar_volume_usd", "money", "all"),
  {
    id: "market", label: "Market", group: "descriptive", appliesTo: "all", options: [], available: true,
    dynamic: { col: "market" }, coverageCols: [],
  },
  {
    id: "currency", label: "Currency", group: "descriptive", appliesTo: "all", options: [], available: true,
    dynamic: { col: "currency", label: (r) => r.toUpperCase() },
  },
  numFilter("targetprice", "Target Price", "descriptive", [
    ...[50, 40, 30, 20, 10, 5].map((v) => opt(`a${v}`, `${v}% Above Price`, cmp("target_upside_pct", ">=", v))),
    opt("above", "Above Price", cmp("target_upside_pct", ">", 0)),
    opt("below", "Below Price", cmp("target_upside_pct", "<", 0)),
    ...[5, 10, 20, 30, 40, 50].map((v) => opt(`b${v}`, `${v}% Below Price`, cmp("target_upside_pct", "<=", -v))),
  ], "target_upside_pct", "pct"),
  numFilter("ipodate", "IPO Date", "descriptive", ipoOptions(), "ipo_date", "date", "all"),
  numFilter("sh_outstanding", "Shares Outstanding", "descriptive", [
    ...unders("shares_outstanding", [1, 5, 10, 20, 50, 100], (v) => `${v}M`, 1e6),
    ...overs("shares_outstanding", [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], (v) => `${v}M`, 1e6),
  ], "shares_outstanding", "volume"),
  numFilter("sh_float", "Float", "descriptive", [
    ...unders("shares_float", [1, 5, 10, 20, 50, 100], (v) => `${v}M`, 1e6),
    ...overs("shares_float", [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000], (v) => `${v}M`, 1e6),
    ...[10, 20, 30, 40, 50].map((v) => opt(`u${v}p`, `Under ${v}% of outstanding`, floatPct("<", v))),
    ...[50, 60, 70, 80, 90].map((v) => opt(`o${v}p`, `Over ${v}% of outstanding`, floatPct(">", v))),
  ], "shares_float", "volume"),
  numFilter("employees", "Employees", "descriptive", [
    ...unders("employees", [10, 50, 100, 500, 1000, 5000, 10000]),
    ...overs("employees", [10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000]),
  ], "employees", "number"),
  unavailable("sh_opt", "Option/Short", "descriptive", "Optionable/shortable flags are not provided by EODHD"),
];

function floatPct(op: Op, v: number): Build {
  return (c) => ({
    sql: `${c.col("shares_outstanding")} > 0 AND ${c.col("shares_float")} * 100.0 / ${c.col("shares_outstanding")} ${op} ?`,
    params: [v],
  });
}

function earningsOptions(): OptionSpec[] {
  // Past days also match `last_earnings_date` (the pipeline moves `earnings_date` to the next report once one is out).
  const between = (lo: (t: string) => string, hi: (t: string) => string): Build => (c) => {
    const l = lo(c.today), h = hi(c.today);
    return {
      sql: `${c.col("earnings_date")} BETWEEN ? AND ? OR ${c.col("last_earnings_date")} BETWEEN ? AND ?`,
      params: [l, h, l, h],
    };
  };
  const day = (off: number, timing?: "bmo" | "amc"): Build => (c) => {
    const d = addDays(c.today, off);
    const base = `(${c.col("earnings_date")} = ? OR ${c.col("last_earnings_date")} = ?)`;
    // Timing is only known for the next report; for past days it is the company's usual timing.
    return timing
      ? { sql: `${base} AND ${c.col("earnings_timing")} = ?`, params: [d, d, timing] }
      : { sql: base, params: [d, d] };
  };
  return [
    opt("today", "Today", day(0)),
    opt("todaybefore", "Today Before Market Open", day(0, "bmo")),
    opt("todayafter", "Today After Market Close", day(0, "amc")),
    opt("tomorrow", "Tomorrow", day(1)),
    opt("tomorrowbefore", "Tomorrow Before Market Open", day(1, "bmo")),
    opt("tomorrowafter", "Tomorrow After Market Close", day(1, "amc")),
    opt("yesterday", "Yesterday", day(-1)),
    opt("yesterdaybefore", "Yesterday Before Market Open", day(-1, "bmo")),
    opt("yesterdayafter", "Yesterday After Market Close", day(-1, "amc")),
    opt("nextdays5", "Next 5 Days", between((t) => addDays(t, 1), (t) => addDays(t, 5))),
    opt("prevdays5", "Previous 5 Days", between((t) => addDays(t, -5), (t) => addDays(t, -1))),
    opt("thisweek", "This Week", between(weekStart, (t) => addDays(weekStart(t), 6))),
    opt("nextweek", "Next Week", between((t) => addDays(weekStart(t), 7), (t) => addDays(weekStart(t), 13))),
    opt("prevweek", "Previous Week", between((t) => addDays(weekStart(t), -7), (t) => addDays(weekStart(t), -1))),
    opt("thismonth", "This Month", between(monthStart, monthEnd)),
  ];
}

function ipoOptions(): OptionSpec[] {
  const since = (from: (t: string) => string): Build => (c) => ({
    sql: `${c.col("ipo_date")} >= ? AND ${c.col("ipo_date")} <= ?`, params: [from(c.today), c.today],
  });
  const before = (to: (t: string) => string): Build => (c) => ({ sql: `${c.col("ipo_date")} < ?`, params: [to(c.today)] });
  return [
    opt("today", "Today", (c) => ({ sql: `${c.col("ipo_date")} = ?`, params: [c.today] })),
    opt("yesterday", "Yesterday", (c) => ({ sql: `${c.col("ipo_date")} = ?`, params: [addDays(c.today, -1)] })),
    opt("prevweek", "In the last week", since((t) => addDays(t, -7))),
    opt("prevmonth", "In the last month", since((t) => addMonths(t, -1))),
    opt("prevquarter", "In the last quarter", since((t) => addMonths(t, -3))),
    opt("prevyear", "In the last year", since((t) => addYears(t, -1))),
    opt("prev2yrs", "In the last 2 years", since((t) => addYears(t, -2))),
    opt("prev3yrs", "In the last 3 years", since((t) => addYears(t, -3))),
    opt("prev5yrs", "In the last 5 years", since((t) => addYears(t, -5))),
    opt("more1", "More than a year ago", before((t) => addYears(t, -1))),
    opt("more5", "More than 5 years ago", before((t) => addYears(t, -5))),
    opt("more10", "More than 10 years ago", before((t) => addYears(t, -10))),
    opt("more15", "More than 15 years ago", before((t) => addYears(t, -15))),
    opt("more20", "More than 20 years ago", before((t) => addYears(t, -20))),
    opt("more25", "More than 25 years ago", before((t) => addYears(t, -25))),
  ];
}

// ---------------------------------------------------------------- fundamental

const growth = (id: string, label: string, col: string) => numFilter(id, label, "fundamental", growthOptions(col), col, "pct");

const fundamental: FilterSpec[] = [
  numFilter("fa_pe", "P/E", "fundamental", ratioOptions("pe", { low: 15, profitable: true, high: 50, u: steps(5, 50, 5), o: steps(5, 50, 5) }), "pe", "number"),
  numFilter("fa_fpe", "Forward P/E", "fundamental", ratioOptions("forward_pe", { low: 15, profitable: true, high: 50, u: steps(5, 50, 5), o: steps(5, 50, 5) }), "forward_pe", "number"),
  numFilter("fa_peg", "PEG", "fundamental", ratioOptions("peg", { low: 1, high: 2, u: [1, 2, 3], o: [1, 2, 3] }), "peg", "number"),
  numFilter("fa_ps", "P/S", "fundamental", ratioOptions("ps", { low: 1, high: 10, u: steps(1, 10, 1), o: steps(1, 10, 1) }), "ps", "number"),
  numFilter("fa_pb", "P/B", "fundamental", ratioOptions("pb", { low: 1, high: 5, u: steps(1, 10, 1), o: steps(1, 10, 1) }), "pb", "number"),
  numFilter("fa_pc", "Price/Cash", "fundamental", ratioOptions("pcash", { low: 3, high: 50, u: steps(1, 10, 1), o: [...steps(1, 10, 1), 20, 30, 40, 50] }), "pcash", "number"),
  numFilter("fa_pfcf", "Price/Free Cash Flow", "fundamental", ratioOptions("pfcf", { low: 15, high: 50, u: [...steps(5, 50, 5), 60, 70, 80, 90, 100], o: [...steps(5, 50, 5), 60, 70, 80, 90, 100] }), "pfcf", "number"),
  numFilter("fa_evebitda", "EV/EBITDA", "fundamental", ratioOptions("ev_ebitda", { negative: true, low: 15, profitable: true, high: 50, u: steps(5, 50, 5), o: steps(5, 50, 5) }), "ev_ebitda", "number"),
  numFilter("fa_evsales", "EV/Sales", "fundamental", [
    opt("neg", "Negative (<0)", cmp("ev_sales", "<", 0)),
    opt("low", "Low (<1)", within("ev_sales", 0, 1)),
    opt("pos", "Positive (>0)", cmp("ev_sales", ">", 0)),
    opt("high", "High (>10)", cmp("ev_sales", ">", 10)),
    ...steps(1, 10, 1).map((v) => opt(`u${v}`, `Under ${v}`, within("ev_sales", 0, v))),
    ...overs("ev_sales", steps(1, 10, 1)),
  ], "ev_sales", "number"),
  numFilter("fa_divgrowth", "Dividend Growth", "fundamental", [
    opt("3ypos", "3 Years positive", cmp("dividend_growth_3y", ">", 0)),
    ...[5, 10, 15, 20, 25, 30].map((v) => opt(`3yo${v}`, `3 Years over ${v}%`, cmp("dividend_growth_3y", ">", v))),
    opt("3yneg", "3 Years negative", cmp("dividend_growth_3y", "<", 0)),
  ], "dividend_growth_3y", "pct"),
  growth("fa_epsyoy", "EPS Growth This Year", "eps_growth_this_y"),
  growth("fa_epsyoy1", "EPS Growth Next Year", "eps_growth_next_y"),
  growth("fa_epsqoq", "EPS Growth Qtr Over Qtr", "eps_growth_qoq"),
  growth("fa_epsyoyttm", "EPS Growth TTM", "eps_growth_ttm"),
  growth("fa_eps3years", "EPS Growth Past 3 Years", "eps_growth_past_3y"),
  growth("fa_eps5years", "EPS Growth Past 5 Years", "eps_growth_past_5y"),
  growth("fa_estltgrowth", "EPS Growth Next 5 Years", "eps_growth_next_5y"),
  growth("fa_salesqoq", "Sales Growth Qtr Over Qtr", "sales_growth_qoq"),
  growth("fa_salesyoyttm", "Sales Growth TTM", "sales_growth_ttm"),
  growth("fa_sales3years", "Sales Growth Past 3 Years", "sales_growth_past_3y"),
  growth("fa_sales5years", "Sales Growth Past 5 Years", "sales_growth_past_5y"),
  numFilter("fa_epsrev", "Earnings & Revenue Surprise", "fundamental", [
    // EPS part only: revenue surprise is not collected.
    opt("ep", "EPS Surprise Positive (>0%)", cmp("eps_surprise_pct", ">", 0)),
    opt("em", "EPS Surprise Met", within("eps_surprise_pct", -0.5, 0.5, true)),
    opt("en", "EPS Surprise Negative (<0%)", cmp("eps_surprise_pct", "<", 0)),
    ...[5, 10, 15, 20, 25, 30, 50, 100].map((v) => opt(`eo${v}`, `EPS Surprise Over ${v}%`, cmp("eps_surprise_pct", ">", v))),
    ...[5, 10, 15, 20, 25, 30, 50].map((v) => opt(`eu${v}`, `EPS Surprise Under -${v}%`, cmp("eps_surprise_pct", "<", -v))),
  ], "eps_surprise_pct", "pct"),
  numFilter("fa_roa", "Return on Assets", "fundamental", returnOptions("roa", 15, -15), "roa", "pct"),
  numFilter("fa_roe", "Return on Equity", "fundamental", returnOptions("roe", 30, -15), "roe", "pct"),
  numFilter("fa_roi", "Return on Invested Capital", "fundamental", returnOptions("roic", 25, -10), "roic", "pct"),
  numFilter("fa_curratio", "Current Ratio", "fundamental", [
    opt("high", "High (>3)", cmp("current_ratio", ">", 3)),
    opt("low", "Low (<1)", cmp("current_ratio", "<", 1)),
    ...unders("current_ratio", [1, 0.5]),
    ...overs("current_ratio", [0.5, 1, 1.5, 2, 3, 4, 5, 10]),
  ], "current_ratio", "number"),
  numFilter("fa_quickratio", "Quick Ratio", "fundamental", [
    opt("high", "High (>3)", cmp("quick_ratio", ">", 3)),
    opt("low", "Low (<0.5)", cmp("quick_ratio", "<", 0.5)),
    ...unders("quick_ratio", [1, 0.5]),
    ...overs("quick_ratio", [0.5, 1, 1.5, 2, 3, 4, 5, 10]),
  ], "quick_ratio", "number"),
  numFilter("fa_ltdebteq", "LT Debt/Equity", "fundamental", [
    opt("high", "High (>0.5)", cmp("lt_debt_eq", ">", 0.5)),
    opt("low", "Low (<0.1)", cmp("lt_debt_eq", "<", 0.1)),
    ...unders("lt_debt_eq", steps(0.1, 1, 0.1).reverse()),
    ...overs("lt_debt_eq", steps(0.1, 1, 0.1)),
  ], "lt_debt_eq", "number"),
  numFilter("fa_debteq", "Debt/Equity", "fundamental", [
    opt("high", "High (>0.5)", cmp("debt_eq", ">", 0.5)),
    opt("low", "Low (<0.1)", cmp("debt_eq", "<", 0.1)),
    ...unders("debt_eq", steps(0.1, 1, 0.1).reverse()),
    ...overs("debt_eq", steps(0.1, 1, 0.1)),
  ], "debt_eq", "number"),
  numFilter("fa_grossmargin", "Gross Margin", "fundamental", marginOptions("gross_margin", 50), "gross_margin", "pct"),
  numFilter("fa_opermargin", "Operating Margin", "fundamental", marginOptions("oper_margin", 25), "oper_margin", "pct"),
  numFilter("fa_netmargin", "Net Profit Margin", "fundamental", marginOptions("net_margin", 20), "net_margin", "pct"),
  numFilter("fa_payoutratio", "Payout Ratio", "fundamental", [
    opt("none", "None (0%)", (c) => ({ sql: `${c.col("payout_ratio")} IS NULL OR ${c.col("payout_ratio")} = 0`, params: [] })),
    opt("pos", "Positive (>0%)", cmp("payout_ratio", ">", 0)),
    opt("low", "Low (<20%)", cmp("payout_ratio", "<", 20)),
    opt("high", "High (>50%)", cmp("payout_ratio", ">", 50)),
    ...overs("payout_ratio", [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], pct),
    ...unders("payout_ratio", [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], pct),
  ], "payout_ratio", "pct"),
  numFilter("sh_insiderown", "Insider Ownership", "fundamental", [
    opt("low", "Low (<5%)", cmp("insider_own", "<", 5)),
    opt("high", "High (>30%)", cmp("insider_own", ">", 30)),
    opt("veryhigh", "Very High (>50%)", cmp("insider_own", ">", 50)),
    ...overs("insider_own", steps(10, 90, 10), pct),
  ], "insider_own", "pct"),
  { usOnly: true, ...numFilter("sh_insidertrans", "Insider Transactions", "fundamental", [
    opt("veryneg", "Very Negative (<20%)", cmp("insider_trans", "<", -20)),
    opt("neg", "Negative (<0%)", cmp("insider_trans", "<", 0)),
    opt("pos", "Positive (>0%)", cmp("insider_trans", ">", 0)),
    opt("verypos", "Very Positive (>20%)", cmp("insider_trans", ">", 20)),
    ...[-90, -80, -70, -60, -50, -45, -40, -35, -30, -25, -20, -15, -10, -5].map((v) => opt(`u${v}`, `Under ${v}%`, cmp("insider_trans", "<", v))),
    ...[5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90].map((v) => opt(`o${v}`, `Over +${v}%`, cmp("insider_trans", ">", v))),
  ], "insider_trans", "pct") },
  numFilter("sh_instown", "Institutional Ownership", "fundamental", [
    opt("low", "Low (<5%)", cmp("inst_own", "<", 5)),
    opt("high", "High (>90%)", cmp("inst_own", ">", 90)),
    ...unders("inst_own", steps(10, 90, 10).reverse(), pct),
    ...overs("inst_own", steps(10, 90, 10), pct),
  ], "inst_own", "pct"),
  { usOnly: true, ...numFilter("sh_insttrans", "Institutional Transactions", "fundamental", [
    opt("veryneg", "Very Negative (<20%)", cmp("inst_trans", "<", -20)),
    opt("neg", "Negative (<0%)", cmp("inst_trans", "<", 0)),
    opt("pos", "Positive (>0%)", cmp("inst_trans", ">", 0)),
    opt("verypos", "Very Positive (>20%)", cmp("inst_trans", ">", 20)),
    ...[-50, -45, -40, -35, -30, -25, -20, -15, -10, -5].map((v) => opt(`u${v}`, `Under ${v}%`, cmp("inst_trans", "<", v))),
    ...[5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((v) => opt(`o${v}`, `Over +${v}%`, cmp("inst_trans", ">", v))),
  ], "inst_trans", "pct") },
];

// ---------------------------------------------------------------- technical

function perfOptions(): OptionSpec[] {
  const p = (value: string, label: string, col: string, op: Op, v: number) => opt(value, label, cmp(col, op, v));
  const win = (code: string, name: string, col: string, downs: number[], ups: number[]): OptionSpec[] => [
    ...downs.map((v) => p(`${code}${v}`, `${name} ${v}%`, col, "<=", v)),
    p(`${code}down`, `${name} Down`, col, "<", 0),
    p(`${code}up`, `${name} Up`, col, ">", 0),
    ...ups.map((v) => p(`${code}${v}`, `${name} +${v}%`, col, ">=", v)),
  ];
  return [
    p("dup", "Today Up", "change_pct", ">", 0),
    p("ddown", "Today Down", "change_pct", "<", 0),
    ...[-15, -10, -5].map((v) => p(`d${v}`, `Today ${v}%`, "change_pct", "<=", v)),
    ...[5, 10, 15].map((v) => p(`d${v}`, `Today +${v}%`, "change_pct", ">=", v)),
    ...win("1w", "Week", "perf_1w", [-30, -20, -10], [10, 20, 30]),
    ...win("4w", "Month", "perf_1m", [-50, -30, -20, -10], [10, 20, 30, 50]),
    ...win("13w", "Quarter", "perf_3m", [-50, -30, -20, -10], [10, 20, 30, 50]),
    ...win("26w", "Half", "perf_6m", [-75, -50, -30, -20, -10], [10, 20, 30, 50, 100]),
    ...win("52w", "Year", "perf_1y", [-75, -50, -30, -20, -10], [10, 20, 30, 50, 100, 200, 300, 500]),
    ...win("ytd", "YTD", "perf_ytd", [-75, -50, -30, -20, -10, -5], [5, 10, 20, 30, 50, 100]),
    ...win("3y", "3 Years", "perf_3y", [-90, -75, -50, -25], [25, 50, 100, 200, 300, 500, 1000]),
    ...win("5y", "5 Years", "perf_5y", [-90, -75, -50, -25], [25, 50, 100, 200, 300, 500, 1000]),
  ];
}

/** Finviz writes signed performance steps as `<window><abs>o` (+) / `<window><abs>u` (−): "13w20o", "d15u", "52w500o". */
function perfAliases(options: OptionSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { value } of options) {
    const m = /^(d|1w|4w|13w|26w|52w|ytd|3y|5y)(-?)(\d+)$/.exec(value);
    if (m) out[`${m[1]}${m[3]}${m[2] ? "u" : "o"}`] = value;
  }
  return out;
}

function allTimeOptions(): OptionSpec[] {
  return [
    opt("nh", "New High", (c) => ({ sql: `${c.col("ath_date")} = ${c.col("price_date")} OR ${c.col("ath_pct")} >= ?`, params: [0] })),
    opt("nl", "New Low", cmp("atl_pct", "<=", 0)),
    ...[3, 5, 10].map((v) => opt(`b0to${v}h`, `0-${v}% below High`, within("ath_pct", -v, 0, true))),
    ...[5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90].map((v) => opt(`b${v}h`, `${v}% or more below High`, cmp("ath_pct", "<=", -v))),
    ...[3, 5, 10].map((v) => opt(`a0to${v}l`, `0-${v}% above Low`, within("atl_pct", 0, v, true))),
    ...[5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 300, 500].map((v) => opt(`a${v}l`, `${v}% or more above Low`, cmp("atl_pct", ">=", v))),
  ];
}

function smaOptions(n: 20 | 50 | 200): OptionSpec[] {
  const pctCol = `sma${n}_pct`;
  const crossCol = `sma${n}_cross`;
  const out: OptionSpec[] = [
    opt("pb", `Price below SMA${n}`, cmp(pctCol, "<", 0)),
    ...[10, 20, 30, 40, 50].map((v) => opt(`pb${v}`, `Price ${v}% below SMA${n}`, cmp(pctCol, "<=", -v))),
    opt("pa", `Price above SMA${n}`, cmp(pctCol, ">", 0)),
    ...[10, 20, 30, 40, 50].map((v) => opt(`pa${v}`, `Price ${v}% above SMA${n}`, cmp(pctCol, ">=", v))),
    opt("pc", `Price crossed SMA${n}`, isIn(crossCol, ["cross_above", "cross_below"])),
    opt("pca", `Price crossed SMA${n} above`, cmp(crossCol, "=", "cross_above")),
    opt("pcb", `Price crossed SMA${n} below`, cmp(crossCol, "=", "cross_below")),
  ];
  const gt = (a: string, b: string): Build => raw((c) => `${c.col(a)} > ${c.col(b)}`);
  if (n === 20) {
    out.push(
      opt("sa50", "SMA20 above SMA50", cmp("sma20_vs_sma50_pct", ">", 0)),
      opt("sb50", "SMA20 below SMA50", cmp("sma20_vs_sma50_pct", "<", 0)),
      opt("sa200", "SMA20 above SMA200", gt("sma20", "sma200")),
      opt("sb200", "SMA20 below SMA200", gt("sma200", "sma20")),
    );
  } else if (n === 50) {
    out.push(
      opt("cross200", "SMA50 crossed SMA200", isIn("sma50_200_cross", ["cross_above", "cross_below"])),
      opt("cross200a", "SMA50 crossed SMA200 above", cmp("sma50_200_cross", "=", "cross_above")),
      opt("cross200b", "SMA50 crossed SMA200 below", cmp("sma50_200_cross", "=", "cross_below")),
      opt("sa20", "SMA50 above SMA20", cmp("sma20_vs_sma50_pct", "<", 0)),
      opt("sb20", "SMA50 below SMA20", cmp("sma20_vs_sma50_pct", ">", 0)),
      opt("sa200", "SMA50 above SMA200", cmp("sma50_vs_sma200_pct", ">", 0)),
      opt("sb200", "SMA50 below SMA200", cmp("sma50_vs_sma200_pct", "<", 0)),
    );
  } else {
    out.push(
      opt("cross50", "SMA200 crossed SMA50", isIn("sma50_200_cross", ["cross_above", "cross_below"])),
      opt("cross50a", "SMA200 crossed SMA50 above", cmp("sma50_200_cross", "=", "cross_below")),
      opt("cross50b", "SMA200 crossed SMA50 below", cmp("sma50_200_cross", "=", "cross_above")),
      opt("sa20", "SMA200 above SMA20", gt("sma200", "sma20")),
      opt("sb20", "SMA200 below SMA20", gt("sma20", "sma200")),
      opt("sa50", "SMA200 above SMA50", cmp("sma50_vs_sma200_pct", "<", 0)),
      opt("sb50", "SMA200 below SMA50", cmp("sma50_vs_sma200_pct", ">", 0)),
    );
  }
  return out;
}

function highLowOptions(window: "20d" | "50d" | "52w", belowHigh: number[], aboveLow: number[]): OptionSpec[] {
  const hi = `high_${window}_pct`, lo = `low_${window}_pct`;
  const windows = window === "20d" ? ["20d", "50d", "52w"] : window === "50d" ? ["50d", "52w"] : ["52w"];
  return [
    opt("nh", "New High", isIn("new_high", windows)),
    opt("nl", "New Low", isIn("new_low", windows)),
    ...[3, 5, 10].map((v) => opt(`b0to${v}h`, `0-${v}% below High`, within(hi, -v, 0, true))),
    ...belowHigh.map((v) => opt(`b${v}h`, `${v}% or more below High`, cmp(hi, "<=", -v))),
    ...[3, 5, 10].map((v) => opt(`a0to${v}l`, `0-${v}% above Low`, within(lo, 0, v, true))),
    ...aboveLow.map((v) => opt(`a${v}l`, `${v}% or more above Low`, cmp(lo, ">=", v))),
  ];
}

function signedSteps(col: string, name: [string, string], vals: number[]): OptionSpec[] {
  return [
    opt("u", name[0], cmp(col, ">", 0)),
    ...vals.map((v) => opt(`u${v}`, `${name[0]} ${v}%`, cmp(col, ">", v))),
    opt("d", name[1], cmp(col, "<", 0)),
    ...vals.map((v) => opt(`d${v}`, `${name[1]} ${v}%`, cmp(col, "<", -v))),
  ];
}

const technical: FilterSpec[] = [
  { id: "ta_perf", label: "Performance", group: "technical", appliesTo: "all", available: true, options: perfOptions(), aliases: perfAliases(perfOptions()), coverageCols: ["change_pct", "perf_1w", "perf_1m", "perf_3m"] },
  { id: "ta_perf2", label: "Performance 2", group: "technical", appliesTo: "all", available: true, options: perfOptions(), aliases: perfAliases(perfOptions()), coverageCols: ["change_pct", "perf_1w", "perf_1m", "perf_3m"] },
  optFilter("ta_volatility", "Volatility", "technical", [
    ...[3, 4, 5, 6, 7, 8, 9, 10, 12, 15].map((v) => opt(`wo${v}`, `Week - Over ${v}%`, cmp("volatility_1w", ">", v))),
    ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15].map((v) => opt(`mo${v}`, `Month - Over ${v}%`, cmp("volatility_1m", ">", v))),
  ]),
  numFilter("ta_rsi", "RSI (14)", "technical", [
    ...[90, 80, 70, 60].map((v) => opt(`ob${v}`, `Overbought (${v})`, cmp("rsi14", ">", v))),
    ...[40, 30, 20, 10].map((v) => opt(`os${v}`, `Oversold (${v})`, cmp("rsi14", "<", v))),
    ...[60, 50].map((v) => opt(`nob${v}`, `Not Overbought (<${v})`, cmp("rsi14", "<", v))),
    ...[50, 40].map((v) => opt(`nos${v}`, `Not Oversold (>${v})`, cmp("rsi14", ">", v))),
  ], "rsi14", "number", "all"),
  numFilter("ta_gap", "Gap", "technical", signedSteps("gap_pct", ["Up", "Down"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20]), "gap_pct", "pct", "all"),
  numFilter("ta_sma20", "20-Day Simple Moving Average", "technical", smaOptions(20), "sma20_pct", "pct", "all"),
  numFilter("ta_sma50", "50-Day Simple Moving Average", "technical", smaOptions(50), "sma50_pct", "pct", "all"),
  numFilter("ta_sma200", "200-Day Simple Moving Average", "technical", smaOptions(200), "sma200_pct", "pct", "all"),
  numFilter("ta_change", "Change", "technical", signedSteps("change_pct", ["Up", "Down"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20]), "change_pct", "pct", "all"),
  numFilter("ta_changeopen", "Change from Open", "technical", signedSteps("change_from_open_pct", ["Up", "Down"], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20]), "change_from_open_pct", "pct", "all"),
  numFilter("ta_highlow20d", "20-Day High/Low", "technical", highLowOptions("20d", [5, 10, 15, 20, 30, 40, 50], [5, 10, 15, 20, 30, 40, 50]), "high_20d_pct", "pct", "all"),
  numFilter("ta_highlow50d", "50-Day High/Low", "technical", highLowOptions("50d", [5, 10, 15, 20, 30, 40, 50], [5, 10, 15, 20, 30, 40, 50]), "high_50d_pct", "pct", "all"),
  numFilter("ta_highlow52w", "52-Week High/Low", "technical", highLowOptions("52w",
    [5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90],
    [5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 300, 500]), "high_52w_pct", "pct", "all"),
  { ...numFilter("ta_alltime", "All-Time High/Low", "technical", allTimeOptions(), "ath_pct", "pct", "all"), coverageCols: ["ath_pct", "atl_pct"] },
  unavailable("ta_pattern", "Pattern", "technical", "Chart pattern recognition (channels, wedges, triangles) is not implemented", "all"),
  {
    id: "ta_candlestick", label: "Candlestick", group: "technical", appliesTo: "all", available: true,
    options: ([
      ["doji", "Doji"], ["hammer", "Hammer"], ["inverted_hammer", "Inverted Hammer"], ["shooting_star", "Shooting Star"],
      ["hanging_man", "Hanging Man"], ["bullish_engulfing", "Bullish Engulfing"], ["bearish_engulfing", "Bearish Engulfing"],
      ["marubozu_white", "Marubozu White"], ["marubozu_black", "Marubozu Black"], ["spinning_top", "Spinning Top"],
    ] as const).map(([v, l]) => opt(v.replace(/_/g, ""), l, cmp("candlestick", "=", v))),
    // Finviz's short codes; the pattern is sparse by nature, so availability follows price coverage.
    aliases: { d: "doji", h: "hammer", ih: "invertedhammer", mw: "marubozuwhite", mb: "marubozublack" },
    coverageCols: ["price"],
  },
  numFilter("ta_beta", "Beta", "technical", [
    ...unders("beta", [0, 0.5, 1, 1.5, 2]),
    ...overs("beta", [0, 0.5, 1, 1.5, 2, 2.5, 3, 4]),
    ...([[0, 0.5], [0, 1], [0.5, 1], [0.5, 1.5], [1, 1.5], [1, 2]] as const)
      .map(([lo, hi]) => opt(`${lo}to${hi}`, `${lo} to ${hi}`, within("beta", lo, hi, true))),
  ], "beta", "number"),
  numFilter("ta_averagetruerange", "Average True Range", "technical", [
    ...overs("atr14", [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]),
    ...unders("atr14", [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]),
  ], "atr14", "money", "all"),
];

// ---------------------------------------------------------------- news

function newsOptions(): OptionSpec[] {
  const since = (from: (c: CompileCtx) => number): Build => (c) => ({ sql: `${c.col("latest_news_at")} >= ?`, params: [from(c)] });
  const range = (from: (c: CompileCtx) => number, to: (c: CompileCtx) => number): Build => (c) => ({
    sql: `${c.col("latest_news_at")} >= ? AND ${c.col("latest_news_at")} < ?`, params: [from(c), to(c)],
  });
  // Day boundaries in the market's zone (ctx.tz); "after market close" = that market's close (ctx.close).
  const midnight = (c: CompileCtx, date: string) => wallToUnix(date, 0, 0, c.tz ?? MARKET_TZ);
  const at = (off: number) => (c: CompileCtx) => midnight(c, addDays(c.today, off));
  const afterClose = (off: number) => (c: CompileCtx) => {
    const cl = c.close ?? { hour: 16, minute: 0, tz: MARKET_TZ };
    return wallToUnix(addDays(c.today, off), cl.hour, cl.minute, cl.tz);
  };
  return [
    opt("today", "Today", since(at(0))),
    opt("todayafter", "Today After Market Close", since(afterClose(0))),
    opt("sinceyesterday", "Since Yesterday", since(at(-1))),
    opt("sinceyesterdayafter", "Since Yesterday After Market Close", since(afterClose(-1))),
    opt("yesterday", "Yesterday", range(at(-1), at(0))),
    opt("yesterdayafter", "Yesterday After Market Close", range(afterClose(-1), at(0))),
    opt("prevdays5", "In the last 5 days", since(at(-5))),
    opt("thisweek", "This Week", since((c) => midnight(c, weekStart(c.today)))),
    opt("thismonth", "This Month", since((c) => midnight(c, monthStart(c.today)))),
  ];
}

const news: FilterSpec[] = [
  { id: "news_date", label: "Latest News", group: "news", appliesTo: "all", available: true, options: newsOptions() },
];

// ---------------------------------------------------------------- ETF

const ASSET_TYPES: Array<[string, string, string[]]> = [
  ["fixedincome", "Bonds", ["%bond%", "%treasur%", "%muni%", "%fixed income%", "%government%", "%ultrashort%", "%bank loan%", "%high yield%", "%inflation-protected%", "%securitized%", "%corporate%", "%preferred%"]],
  ["commodity", "Commodities", ["%commodit%"]],
  ["currency", "Currency", ["%currency%"]],
  ["realestate", "Real Estate", ["%real estate%"]],
  ["multiasset", "Multi-Asset", ["%allocation%", "%multi%"]],
  ["alternative", "Alternatives", ["trading--%", "%long-short%", "%market neutral%", "%derivative income%", "%volatility%", "%macro%", "%event driven%"]],
];
const likeAny = (col: string, pats: string[]): Build => (c) => ({
  sql: pats.map(() => `LOWER(${c.col(col)}) LIKE ?`).join(" OR "), params: [...pats],
});

const etf: FilterSpec[] = [
  {
    id: "etf_assettype", label: "Asset Type", group: "etf", appliesTo: "etf", available: true,
    options: [
      opt("equities", "Equities (Stocks)", (c) => {
        const all = ASSET_TYPES.flatMap(([, , p]) => p);
        const neg = likeAny("etf_category", all)(c);
        return { sql: `${c.col("etf_category")} IS NOT NULL AND NOT (${neg.sql})`, params: neg.params };
      }),
      ...ASSET_TYPES.map(([v, l, pats]) => opt(v, l, likeAny("etf_category", pats))),
    ],
  },
  {
    id: "etf_category", label: "Single Category", group: "etf", appliesTo: "etf", options: [], available: true,
    dynamic: { col: "etf_category", kind: "etf" },
  },
  {
    id: "etf_leverage", label: "Leveraged/Inverse", group: "etf", appliesTo: "etf", available: true,
    options: [
      opt("leveraged", "Leveraged", likeAny("etf_category", ["trading--leveraged%"])),
      opt("inverse", "Inverse", likeAny("etf_category", ["trading--inverse%"])),
      opt("notleveraged", "Not Leveraged or Inverse", (c) => ({
        sql: `${c.col("etf_category")} IS NULL OR LOWER(${c.col("etf_category")}) NOT LIKE ?`, params: ["trading--%"],
      })),
    ],
  },
  {
    id: "etf_sponsor", label: "Sponsor", group: "etf", appliesTo: "etf", options: [], available: true,
    dynamic: { col: "etf_sponsor", kind: "etf" },
  },
  numFilter("etf_netexpense", "Net Expense Ratio", "etf", [
    ...unders("etf_expense_ratio", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], pct),
    ...overs("etf_expense_ratio", [0.1, 0.25, 0.5, 0.75, 1, 2], pct),
  ], "etf_expense_ratio", "pct", "etf"),
  numFilter("etf_aum", "Assets Under Management", "etf", [
    ...unders("etf_aum", [50, 100, 250, 500, 1000, 10000], mMoney, 1e6),
    ...overs("etf_aum", [50, 100, 250, 500, 1000, 10000, 50000, 100000], mMoney, 1e6),
  ], "etf_aum", "money", "etf"),
  numFilter("etf_holdings", "Holdings", "etf", [
    ...unders("etf_holdings_count", [10, 25, 50, 100]),
    ...overs("etf_holdings_count", [10, 25, 50, 100, 250, 500, 1000]),
  ], "etf_holdings_count", "number", "etf"),
  unavailable("etf_tags", "Tags", "etf", "Finviz ETF tags are proprietary; use Single Category / Asset Type", "etf"),
  unavailable("etf_fundflows", "Net Flows", "etf", "Fund flow data is not provided by EODHD", "etf"),
  unavailable("etf_return", "Annualized Return", "etf", "Use the Performance filters (price return) instead", "etf"),
  unavailable("etf_activepassive", "Active/Passive", "etf", "Not provided in EODHD ETF data", "etf"),
];

export const FILTERS: FilterSpec[] = [...descriptive, ...fundamental, ...technical, ...news, ...etf];
const BY_ID = new Map<string, FilterSpec>(FILTERS.map((f) => [f.id, f]));
// Finviz URL codes resolve too ("fa_div" → "div"); ids win on a clash.
for (const f of FILTERS) if (f.code && !BY_ID.has(f.code)) BY_ID.set(f.code, f);

/** By id or Finviz URL code. */
export function getFilter(id: string): FilterSpec | undefined {
  return BY_ID.get(id);
}

export function filterCode(f: FilterSpec): string {
  return f.code ?? f.id;
}

/** Our option value for a Finviz alias (identity otherwise). */
export function canonicalOption(f: FilterSpec, value: string): string {
  return f.aliases && Object.hasOwn(f.aliases, value) ? f.aliases[value]! : value;
}

/** Every metric column the registry reads (for tests / diagnostics). */
export function customColumns(): string[] {
  return FILTERS.flatMap((f) => (f.custom ? [f.custom.col] : []));
}
