// Finviz URL vocabulary for the agent API: `f=cap_midover,ta_sma50_pa,sec_technology|healthcare` and `o=-perf13w`.
// Filter codes are Finviz's URL prefixes (FilterSpec.code ?? id); option codes are ours or Finviz aliases.
import type { ScreenerFilterValue, ScreenerQuery } from "@eodview/shared";
import { HttpError } from "../http";
import { getColumn } from "./columns";
import { isIsoDate } from "./dates";
import { canonicalOption, filterCode, FILTERS, type FilterSpec } from "./filters";

const MAX_TOKENS = 100;
const MAX_LEN = 4000;

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

/** Longest prefix first so "ta_sma200" wins over "ta_sma20" and "fa_epsyoyttm" over "fa_epsyoy". */
const PREFIXES: Array<[string, FilterSpec]> = (() => {
  const seen = new Map<string, FilterSpec>();
  for (const f of FILTERS) {
    seen.set(filterCode(f), f);
    if (!seen.has(f.id)) seen.set(f.id, f);
  }
  return [...seen.entries()].sort((a, b) => b[0].length - a[0].length);
})();

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const RANGE_RE = new RegExp(`^(${NUM})?to(${NUM})?$`);
const UO_RE = new RegExp(`^([uo])(${NUM})$`);
const US_DATE_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

function toIsoDate(s: string): string | null {
  if (isIsoDate(s)) return s;
  const m = US_DATE_RE.exec(s); // Finviz custom dates are MM-DD-YYYY
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  return isIsoDate(iso) ? iso : null;
}

function optionHint(f: FilterSpec): string {
  const code = filterCode(f);
  const vals = f.options.map((o) => `${code}_${o.value}`);
  const more = vals.length > 12 ? `, … (${vals.length} total)` : "";
  return vals.length ? `; valid e.g. ${vals.slice(0, 12).join(", ")}${more}` : "";
}

/** A custom range written Finviz-style: `10to20`, `to5`, `o7.5`, `u0.5`, dates `2026-10-01x2026-10-31` / `10-01-2026x10-31-2026`. */
function parseCustom(f: FilterSpec, v: string): ScreenerFilterValue | null {
  if (!f.custom) return null;
  if (f.custom.unit === "date") {
    const [a, b, ...rest] = v.split("x");
    if (rest.length || b === undefined) return null;
    const min = a ? toIsoDate(a) : undefined;
    const max = b ? toIsoDate(b) : undefined;
    if (min === null || max === null || (min === undefined && max === undefined)) return null;
    return { id: f.id, ...(min ? { min } : {}), ...(max ? { max } : {}) };
  }
  const r = RANGE_RE.exec(v);
  if (r && (r[1] !== undefined || r[2] !== undefined)) {
    return { id: f.id, ...(r[1] !== undefined ? { min: Number(r[1]) } : {}), ...(r[2] !== undefined ? { max: Number(r[2]) } : {}) };
  }
  const uo = UO_RE.exec(v);
  if (uo) return uo[1] === "o" ? { id: f.id, min: Number(uo[2]) } : { id: f.id, max: Number(uo[2]) };
  return null;
}

/**
 * Parse a Finviz-style filter list. Static options are checked here (with aliases mapped to our values); dynamic
 * options (sector, industry, country, exchange, …) are checked against the universe when the query is normalized.
 */
export function parseFinvizFilters(f: string | null | undefined): ScreenerFilterValue[] {
  if (!f || !f.trim()) return [];
  if (f.length > MAX_LEN) bad(`f: at most ${MAX_LEN} characters`);
  const tokens = f.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length > MAX_TOKENS) bad(`f: at most ${MAX_TOKENS} filters`);
  const out: ScreenerFilterValue[] = [];
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    const hit = PREFIXES.find(([p]) => token.startsWith(`${p}_`));
    if (!hit) bad(`unknown filter code "${raw.slice(0, 60)}" (list codes with GET /api/v1/filters)`);
    const [prefix, spec] = hit;
    const value = token.slice(prefix.length + 1);
    if (!value) bad(`filter code "${raw.slice(0, 60)}" has no option`);
    if (!spec.available) bad(`filter ${prefix} (${spec.label}) is not available: ${spec.unavailableReason ?? "no data"}`);
    const parts = value.split("|").map((p) => canonicalOption(spec, p));
    const isOption = (p: string) => spec.options.some((o) => o.value === p) || !!spec.late?.(p);
    if (parts.every(isOption) || (spec.dynamic && parts.every((p) => isOption(p) || /^[a-z0-9]{1,100}$/.test(p)))) {
      out.push({ id: spec.id, value: parts.join("|") });
      continue;
    }
    if (parts.length === 1) {
      const custom = parseCustom(spec, value);
      if (custom) { out.push(custom); continue; }
    }
    const badPart = parts.find((p) => !isOption(p)) ?? value;
    bad(`unknown option "${badPart.slice(0, 40)}" for filter ${prefix} (${spec.label})${optionHint(spec)}`);
  }
  return out;
}

/** Finviz `o=` column names → our column ids. Our ids (e.g. "perf_3m") work too. */
export const FINVIZ_ORDER_ALIASES: Readonly<Record<string, string>> = {
  ticker: "ticker", company: "company", sector: "sector", industry: "industry", country: "country", exchange: "exchange",
  marketcap: "market_cap", pe: "pe", forwardpe: "forward_pe", peg: "peg", ps: "ps", pb: "pb", pc: "pcash", pfcf: "pfcf",
  evebitda: "ev_ebitda", evsales: "ev_sales", dividendyield: "dividend_yield", payoutratio: "payout_ratio", eps: "eps_ttm",
  epsyoy: "eps_growth_this_y", epsyoy1: "eps_growth_next_y", epsqoq: "eps_growth_qoq", epsyoyttm: "eps_growth_ttm",
  eps3years: "eps_growth_past_3y", eps5years: "eps_growth_past_5y", estltgrowth: "eps_growth_next_5y",
  salesqoq: "sales_growth_qoq", salesyoyttm: "sales_growth_ttm", sales3years: "sales_growth_past_3y", sales5years: "sales_growth_past_5y",
  sharesoutstanding2: "shares_outstanding", sharesfloat: "shares_float", insiderown: "insider_own", insidertrans: "insider_trans",
  instown: "inst_own", insttrans: "inst_trans", shortinterestshare: "short_float", shortinterestratio: "short_ratio",
  roa: "roa", roe: "roe", roi: "roic", curratio: "current_ratio", quickratio: "quick_ratio", ltdebteq: "lt_debt_eq",
  debteq: "debt_eq", grossmargin: "gross_margin", opermargin: "oper_margin", netmargin: "net_margin", recom: "analyst_recom",
  perf1w: "perf_1w", perf4w: "perf_1m", perf13w: "perf_3m", perf26w: "perf_6m", perf52w: "perf_1y", perfytd: "perf_ytd",
  perf3y: "perf_3y", perf5y: "perf_5y", beta: "beta", averagetruerange: "atr14", volatility1w: "volatility_1w",
  volatility4w: "volatility_1m", sma20: "sma20_pct", sma50: "sma50_pct", sma200: "sma200_pct", high52w: "high_52w_pct",
  low52w: "low_52w_pct", rsi: "rsi14", averagevolume: "avg_volume", relativevolume: "rel_volume", change: "change_pct",
  changeopen: "change_from_open_pct", gap: "gap_pct", volume: "volume", price: "price", targetprice: "target_price",
  ipodate: "ipo_date", earningsdate: "earnings_date", employees: "employees",
  // not Finviz, but natural
  dollarvolume: "dollar_volume_usd", marketcapusd: "market_cap_usd", alltimehigh: "ath_pct", ath: "ath_pct", atl: "atl_pct",
};

/** `-perf_3m` / `perf13w` / `-marketcap` → sort spec ("-" = descending). Empty → ticker ascending. */
export function parseOrder(o: string | null | undefined): ScreenerQuery["sort"] {
  const s = (o ?? "").trim();
  if (!s) return { column: "ticker", dir: "asc" };
  const desc = s.startsWith("-");
  const name = s.replace(/^[-+]/, "").toLowerCase();
  const column = name === "symbol" || getColumn(name) ? name : FINVIZ_ORDER_ALIASES[name];
  if (!column || (column !== "symbol" && !getColumn(column))) {
    bad(`unknown order column "${s.slice(0, 40)}" (use a column id such as perf_3m or a Finviz name such as perf13w; "-" = descending)`);
  }
  return { column, dir: desc ? "desc" : "asc" };
}
