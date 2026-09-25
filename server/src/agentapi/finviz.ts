// Finviz URL-style query parsing for the agent API (pure; see finviz.test.ts).
//   f=cap_midover,ta_sma50_pa,fa_pe_u20     filter codes: `${filter.code}_${option.value}`, "a|b" = either
//   f=sh_price_10to50,fa_pe_to15             custom range `<min>to<max>` in the filter's raw column units
//   o=-perf_3m                                sort column ("-" = descending); Finviz names like perf13w also work
//   v=overview | 111                          view id or Finviz view number
import type { ScreenerColumnDef, ScreenerFilterDef, ScreenerFilterValue, ScreenerQuery, ScreenerView } from "@eodview/shared";
import { badRequest as bad } from "./errors";

export const SCREEN_MAX_LIMIT = 500;
export const SCREEN_DEFAULT_LIMIT = 50;
const MAX_CODES = 100;

/** URL prefix of a filter (Q sets `code`; ids are already Finviz prefixes otherwise). */
export const filterCode = (f: Pick<ScreenerFilterDef, "id" | "code">): string => (f.code ?? f.id).toLowerCase();

const NUM_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBound(raw: string, code: string): number | string | undefined {
  if (raw === "") return undefined;
  if (NUM_RE.test(raw)) return Number(raw);
  if (DATE_RE.test(raw)) return raw;
  bad(`filter code "${code}": range bound "${raw.slice(0, 20)}" must be a number or YYYY-MM-DD`);
}

/**
 * Parse a Finviz-style `f` string (comma separated) into structured filters.
 * Each code is matched against the longest filter code prefix; option values are validated later by the engine.
 */
export function parseFinvizFilters(f: string | null | undefined, defs: ScreenerFilterDef[]): ScreenerFilterValue[] {
  const tokens = (f ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length > MAX_CODES) bad(`at most ${MAX_CODES} filter codes`);
  const byCode = [...defs].sort((a, b) => filterCode(b).length - filterCode(a).length);
  const out: ScreenerFilterValue[] = [];
  for (const tok of tokens) {
    const def = byCode.find((d) => tok.startsWith(filterCode(d) + "_") && tok.length > filterCode(d).length + 1);
    if (!def) bad(`unknown filter code "${tok.slice(0, 40)}"`, "see GET /api/v1/filters for the codes (e.g. cap_midover, ta_sma50_pa, fa_pe_u20)");
    const value = tok.slice(filterCode(def).length + 1);
    const known = (v: string) => def.options.some((o) => o.value === v);
    if (value.split("|").every(known)) {
      out.push({ id: def.id, value });
      continue;
    }
    // Numeric ranges "10to20"; date ranges "2026-10-01x2026-10-31" (Finviz) or "2026-10-01to2026-10-31".
    const range = /^([^|]*?)to([^|]*)$/.exec(value) ?? /^(\d{4}-\d{2}-\d{2})?x(\d{4}-\d{2}-\d{2})?$/.exec(value);
    if (range && def.custom && !known(value)) {
      const min = parseBound(range[1] ?? "", tok);
      const max = parseBound(range[2] ?? "", tok);
      if (min === undefined && max === undefined) bad(`filter code "${tok}": empty range`);
      out.push({ id: def.id, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
      continue;
    }
    // Unknown (or dynamic, e.g. an industry slug): the engine validates and reports the allowed values.
    out.push({ id: def.id, value });
  }
  return out;
}

/** Finviz `o=` names that differ from our column ids. */
const ORDER_ALIASES: Record<string, string> = {
  marketcap: "market_cap", change: "change_pct", changeopen: "change_from_open_pct", gap: "gap_pct",
  perf1w: "perf_1w", perf4w: "perf_1m", perf13w: "perf_3m", perf26w: "perf_6m", perf52w: "perf_1y", perfytd: "perf_ytd",
  perfw: "perf_1w", perfm: "perf_1m", perfq: "perf_3m", perfh: "perf_6m", perfy: "perf_1y",
  relativevolume: "rel_volume", averagevolume: "avg_volume", rsi: "rsi14", atr: "atr14",
  high52w: "high_52w_pct", low52w: "low_52w_pct", sma20: "sma20_pct", sma50: "sma50_pct", sma200: "sma200_pct",
  forwardpe: "forward_pe", dividendyield: "dividend_yield", earningsdate: "earnings_date", targetprice: "target_price",
  floatshort: "short_float", shortinterestshare: "short_float", recom: "analyst_recom", company: "company", ticker: "ticker",
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `-perf_3m` → { column: "perf_3m", dir: "desc" }. */
export function parseOrder(o: string | null | undefined, columns: Pick<ScreenerColumnDef, "id">[]): ScreenerQuery["sort"] {
  const raw = (o ?? "").trim();
  if (!raw) return { column: "ticker", dir: "asc" };
  const desc = raw.startsWith("-");
  const name = raw.replace(/^[-+]/, "");
  const ids = new Set(columns.map((c) => c.id));
  let column: string | undefined = ids.has(name) || name === "symbol" ? name : undefined;
  if (!column) {
    const alias = ORDER_ALIASES[squash(name)];
    if (alias && ids.has(alias)) column = alias;
  }
  if (!column) column = columns.find((c) => squash(c.id) === squash(name))?.id;
  if (!column) bad(`unknown sort column "${name.slice(0, 40)}"`, `use one of: ${[...ids].join(", ")}`);
  return { column, dir: desc ? "desc" : "asc" };
}

/** Finviz view numbers (v=111 …) → our view ids. */
const VIEW_NUMBERS: Record<string, string> = {
  "111": "overview", "121": "valuation", "161": "financial", "131": "ownership", "141": "performance",
  "171": "technical", "211": "charts", "311": "overview",
};

export function parseView(v: string | null | undefined, views: Pick<ScreenerView, "id">[]): string {
  const raw = (v ?? "").trim().toLowerCase();
  if (!raw) return "overview";
  const id = VIEW_NUMBERS[raw] ?? raw;
  if (!views.some((x) => x.id === id)) bad(`unknown view "${raw.slice(0, 20)}"`, `use one of: ${views.map((x) => x.id).join(", ")}`);
  return id;
}

function intParam(raw: string | null, name: string, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be an integer ${min}..${max}`);
  return n;
}

export interface ScreenParseCtx {
  filters: ScreenerFilterDef[];
  columns: Pick<ScreenerColumnDef, "id">[];
  views: Pick<ScreenerView, "id">[];
  /** Optional replacement for parseFinvizFilters (the screener module's own parser). */
  parseFilters?: (f: string) => ScreenerFilterValue[];
  /** Optional replacement for parseOrder (the screener module's own parser). */
  parseOrder?: (o: string | null) => ScreenerQuery["sort"];
  maxLimit?: number;
}

export type Universe = ScreenerQuery["universe"];

export function parseUniverse(raw: string | null | undefined, filters: ScreenerFilterValue[]): Universe {
  const u = (raw ?? "").trim().toLowerCase();
  if (!u) return filters.some((f) => f.id.startsWith("etf_")) ? "etfs" : "stocks";
  if (u === "stocks" || u === "stock") return "stocks";
  if (u === "etfs" || u === "etf") return "etfs";
  if (u === "all") return "all";
  bad(`universe must be stocks, etfs or all`);
}

export function normalizeMarket(raw: string | null | undefined): string {
  const m = (raw ?? "").trim().toUpperCase();
  if (!m) return "US";
  if (!/^[A-Z0-9]{1,12}$/.test(m)) bad(`invalid market "${m.slice(0, 20)}"`);
  return m;
}

/** GET /api/v1/screen query string → ScreenerQuery. */
export function parseScreenParams(sp: URLSearchParams, ctx: ScreenParseCtx): ScreenerQuery {
  const f = sp.get("f") ?? "";
  const filters = ctx.parseFilters ? ctx.parseFilters(f) : parseFinvizFilters(f, ctx.filters);
  const tickers = (sp.get("tickers") ?? sp.get("t") ?? "").trim();
  const maxLimit = ctx.maxLimit ?? SCREEN_MAX_LIMIT;
  return {
    filters,
    market: normalizeMarket(sp.get("market")),
    universe: parseUniverse(sp.get("universe"), filters),
    ...(tickers ? { tickers } : {}),
    view: parseView(sp.get("v") ?? sp.get("view"), ctx.views),
    sort: ctx.parseOrder ? ctx.parseOrder(sp.get("o") ?? sp.get("sort")) : parseOrder(sp.get("o") ?? sp.get("sort"), ctx.columns),
    offset: intParam(sp.get("offset"), "offset", 0, 0, 10_000_000),
    limit: intParam(sp.get("limit"), "limit", SCREEN_DEFAULT_LIMIT, 1, maxLimit),
  };
}

/** Encode structured filters back to Finviz codes (for echoing a query to agents). */
export function toFinvizCodes(filters: ScreenerFilterValue[], defs: ScreenerFilterDef[]): string {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return filters.map((f) => {
    const code = byId.has(f.id) ? filterCode(byId.get(f.id)!) : f.id;
    if ("value" in f) return `${code}_${f.value}`;
    return `${code}_${f.min ?? ""}to${f.max ?? ""}`;
  }).join(",");
}
