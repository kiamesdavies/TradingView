// Screener query validation + SQL building + execution over `universe_metrics`.
// Only registry-defined column names ever reach SQL text; all user values are bound parameters.
import type { Database } from "bun:sqlite";
import type {
  MarketInfo, ScreenerFilterDef, ScreenerFilterValue, ScreenerMeta, ScreenerOption, ScreenerQuery, ScreenerResponse,
  UniverseStatus,
} from "@eodview/shared";
import { HttpError } from "../http";
import { METRICS_TABLE } from "../universe/metricsSchema";
import { columnDefs, getColumn, getView, VIEWS, viewsFor, type ColumnSpec } from "./columns";
import { isIsoDate, MARKET_TZ, nyToday, todayIn } from "./dates";
import { getMarket } from "../universe/markets";
import { canonicalOption, filterCode, FILTERS, getFilter, type FilterSpec, type OptionSpec } from "./filters";
import { indexOptions } from "./indexes";
import {
  and, DEFAULT_MARKET, makeColResolver, or, quoteIdent, USD_REMAP, usdCtx, type CompileCtx, type Pred, type SqlParam,
} from "./sql";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 50;
const MAX_FILTERS = 100;
const MAX_MULTI = 50;
const MAX_TICKERS = 500;
const DYNAMIC_TTL_MS = 10 * 60_000;
const DYNAMIC_MISS_REFRESH_MS = 5_000;
/** A filter whose columns are filled for fewer than this fraction of a market's rows is shown unavailable there. */
export const MIN_COVERAGE = 0.15;
export const ALL_MARKETS = "ALL";
const MARKET_RE = /^[A-Z0-9]{1,12}$/;

export type PresetQuery = Omit<ScreenerQuery, "offset" | "limit">;

function bad(msg: string): never {
  throw new HttpError(400, msg);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown) => (JSON.stringify(v) ?? String(v)).slice(0, 60);

export function slugify(raw: string): string {
  return raw.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");
}

// ---------------------------------------------------------------- validation

const TICKER_RE = /^[A-Z0-9^][A-Z0-9.\-_^=&]{0,24}$/;
const DYN_SLUG_RE = /^[a-z0-9]{1,100}$/;

export function parseTickers(raw: string): string[] {
  const toks = raw.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (toks.length > MAX_TICKERS) bad(`tickers: at most ${MAX_TICKERS} tickers`);
  for (const t of toks) if (!TICKER_RE.test(t)) bad(`tickers: invalid ticker ${show(t)}`);
  return [...new Set(toks)];
}

function parseBound(v: unknown, f: FilterSpec, which: "min" | "max"): number | string | undefined {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return undefined;
  if (f.custom!.unit === "date") {
    if (typeof v !== "string" || !isIsoDate(v.trim())) bad(`filter ${f.id}: ${which} must be a date YYYY-MM-DD (got ${show(v)})`);
    return v.trim();
  }
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) bad(`filter ${f.id}: ${which} must be a number (got ${show(v)})`);
  return n;
}

/**
 * Validate and normalise filters. `checkOption(spec, part)` decides whether a non-static option value is valid
 * (dynamic options); returning false → 400.
 */
function normalizeFilters(v: unknown, checkDynamic: (f: FilterSpec, slug: string) => boolean): ScreenerFilterValue[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad("filters must be an array");
  if (v.length > MAX_FILTERS) bad(`at most ${MAX_FILTERS} filters`);
  const out: ScreenerFilterValue[] = [];
  v.forEach((raw, i) => {
    if (!isObj(raw)) bad(`filters[${i}] must be an object`);
    const id = raw.id;
    if (typeof id !== "string") bad(`filters[${i}].id must be a string`);
    const f = getFilter(id);
    if (!f) bad(`unknown filter "${id.slice(0, 40)}"`);
    if (!f.available) bad(`filter "${f.label}" is not available: ${f.unavailableReason ?? "no data"}`);
    if ("value" in raw && raw.value !== undefined) {
      if (typeof raw.value !== "string") bad(`filter ${id}: value must be a string`);
      const value = raw.value.trim();
      if (!value) return; // "Any"
      const parts = value.split("|").map((p) => canonicalOption(f, p.trim()));
      if (parts.length > MAX_MULTI) bad(`filter ${id}: at most ${MAX_MULTI} values`);
      for (const p of parts) {
        if (f.options.some((o) => o.value === p)) continue;
        if (f.late?.(p)) continue;
        if (f.dynamic && DYN_SLUG_RE.test(p) && checkDynamic(f, p)) continue;
        bad(`filter "${f.label}": unknown option ${show(p)}`);
      }
      out.push({ id: f.id, value: [...new Set(parts)].join("|") });
      return;
    }
    if (!f.custom) bad(`filter "${f.label}" does not support a custom range`);
    const min = parseBound(raw.min, f, "min");
    const max = parseBound(raw.max, f, "max");
    if (min === undefined && max === undefined) return; // "Any"
    out.push({ id: f.id, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
  });
  return out;
}

export interface NormalizeOpts {
  /** Validate dynamic option slugs (sector/industry/…) against the current universe. Presets only check the shape. */
  checkDynamic?: (f: FilterSpec, slug: string) => boolean;
  /** Validate a market code (already upper-cased, not "US"/"ALL"). Default: any well-formed code. */
  checkMarket?: (code: string) => boolean;
}

export function normalizeMarket(v: unknown, check?: (code: string) => boolean): string {
  if (v === undefined || v === null || v === "") return DEFAULT_MARKET;
  if (typeof v !== "string") bad("market must be a string");
  const m = v.trim().toUpperCase();
  if (m === DEFAULT_MARKET || m === ALL_MARKETS) return m;
  if (!MARKET_RE.test(m) || (check && !check(m))) bad(`unknown market ${show(v)}`);
  return m;
}

export function normalizePresetQuery(body: unknown, opts: NormalizeOpts = {}): PresetQuery {
  if (!isObj(body)) bad("query must be a JSON object");
  const filters = normalizeFilters(body.filters, opts.checkDynamic ?? (() => true));
  const market = normalizeMarket(body.market, opts.checkMarket);
  const universe = body.universe ?? "stocks";
  if (universe !== "stocks" && universe !== "etfs" && universe !== "all") bad(`universe must be stocks, etfs or all`);
  let tickers: string | undefined;
  if (body.tickers !== undefined && body.tickers !== null) {
    if (typeof body.tickers !== "string" || body.tickers.length > 10_000) bad("tickers must be a string");
    parseTickers(body.tickers);
    tickers = body.tickers.trim() || undefined;
  }
  const view = body.view ?? "overview";
  if (typeof view !== "string" || !getView(view)) bad(`unknown view ${show(view)} (use ${VIEWS.map((x) => x.id).join(", ")})`);
  const sortRaw = body.sort ?? { column: "ticker", dir: "asc" };
  if (!isObj(sortRaw)) bad("sort must be {column, dir}");
  const column = sortRaw.column ?? "ticker";
  if (typeof column !== "string" || (column !== "symbol" && !getColumn(column))) bad(`unknown sort column ${show(column)}`);
  const dir = sortRaw.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc") bad(`sort.dir must be asc or desc`);
  return { filters, market, universe, ...(tickers ? { tickers } : {}), view, sort: { column, dir } };
}

export function normalizeQuery(body: unknown, opts: NormalizeOpts = {}): ScreenerQuery {
  const base = normalizePresetQuery(body, opts);
  const o = body as Record<string, unknown>;
  const int = (v: unknown, name: string, def: number, min: number, max: number) => {
    if (v === undefined || v === null) return def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(`${name} must be an integer ${min}..${max}`);
    return v;
  };
  return { ...base, offset: int(o.offset, "offset", 0, 0, 10_000_000), limit: int(o.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT) };
}

// ---------------------------------------------------------------- compilation

export type DynamicResolver = (f: FilterSpec, slug: string) => string[] | null;

export function compileFilter(v: ScreenerFilterValue, ctx0: CompileCtx, resolve: DynamicResolver): Pred {
  const f = getFilter(v.id);
  if (!f) bad(`unknown filter "${v.id}"`);
  const ctx = usdCtx(ctx0);
  if ("value" in v) {
    const preds = v.value.split("|").map((raw): Pred => {
      const part = canonicalOption(f, raw);
      const o = f.options.find((x) => x.value === part);
      if (o) return o.build(ctx);
      const late = f.late?.(part);
      if (late) return late(ctx);
      const raws = f.dynamic ? resolve(f, part) : null;
      if (!raws || !raws.length) bad(`filter "${f.label}": unknown option ${show(part)}`);
      return { sql: `${ctx.col(f.dynamic!.col)} IN (${raws.map(() => "?").join(", ")})`, params: raws };
    });
    return preds.length === 1 ? preds[0]! : or(preds);
  }
  if (!f.custom) bad(`filter "${f.label}" does not support a custom range`);
  const col = ctx.col(f.custom.col);
  const parts: string[] = [];
  const params: SqlParam[] = [];
  if (v.min !== undefined) { parts.push(`${col} >= ?`); params.push(v.min); }
  if (v.max !== undefined) { parts.push(`${col} <= ?`); params.push(v.max); }
  return { sql: parts.join(" AND ") || "1", params };
}

function columnExpr(c: ColumnSpec, ctx: CompileCtx): string {
  const refs = c.cols.map((x) => ctx.col(x));
  return c.expr ? c.expr.replace(/\$(\d)/g, (_, i: string) => refs[Number(i)]!) : refs[0]!;
}

export interface BuiltQuery {
  select: { sql: string; params: SqlParam[] };
  count: { sql: string; params: SqlParam[] };
  columns: string[];
}

export interface BuildOpts {
  /** Market codes "ALL" expands to (enabled markets). Undefined/empty → no market restriction for ALL. */
  allMarkets?: string[];
}

export function buildQuery(q: ScreenerQuery, ctx0: CompileCtx, resolve: DynamicResolver, opts: BuildOpts = {}): BuiltQuery {
  const market = q.market ?? DEFAULT_MARKET;
  const ctx: CompileCtx = { ...ctx0, usd: market !== DEFAULT_MARKET };
  const view = getView(q.view, market);
  if (!view) bad(`unknown view ${show(q.view)}`);
  const preds: Pred[] = [];
  if (market !== ALL_MARKETS) preds.push({ sql: `${ctx.col("market")} = ?`, params: [market] });
  else if (opts.allMarkets?.length) {
    preds.push({ sql: `${ctx.col("market")} IN (${opts.allMarkets.map(() => "?").join(", ")})`, params: [...opts.allMarkets] });
  }
  if (q.universe === "stocks") preds.push({ sql: `${ctx.col("kind")} = ?`, params: ["stock"] });
  else if (q.universe === "etfs") preds.push({ sql: `${ctx.col("kind")} = ?`, params: ["etf"] });
  if (q.tickers) {
    const t = parseTickers(q.tickers);
    if (t.length) {
      const ph = t.map(() => "?").join(", ");
      preds.push({ sql: `${ctx.col("code")} IN (${ph}) OR ${ctx.col("symbol")} IN (${ph})`, params: [...t, ...t] });
    }
  }
  for (const f of q.filters) preds.push(compileFilter(f, ctx, resolve));
  const where = and(preds);

  const selects = [`${ctx.col("symbol")} AS "symbol"`];
  for (const id of view.columns) {
    const c = getColumn(id);
    if (!c) throw new Error(`view ${view.id} references unknown column ${id}`);
    selects.push(`${columnExpr(c, ctx)} AS ${quoteIdent(c.id)}`);
  }
  // Outside the US, sorting by market cap compares USD values (rows may be in different currencies).
  const sortId = ctx.usd && USD_REMAP[q.sort.column] === "market_cap_usd" ? "market_cap_usd" : q.sort.column;
  const sortCol = q.sort.column === "symbol" ? null : getColumn(sortId);
  if (q.sort.column !== "symbol" && !sortCol) bad(`unknown sort column ${show(q.sort.column)}`);
  const sortExpr = sortCol ? columnExpr(sortCol, ctx) : ctx.col("symbol");
  const dir = q.sort.dir === "desc" ? "DESC" : "ASC";
  const limit = Math.min(Math.max(1, Math.floor(q.limit)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(q.offset));
  const from = `FROM ${quoteIdent(METRICS_TABLE)} WHERE ${where.sql}`;
  return {
    select: {
      sql: `SELECT ${selects.join(", ")} ${from} ORDER BY (${sortExpr}) IS NULL, ${sortExpr} ${dir}, ${ctx.col("symbol")} ASC LIMIT ? OFFSET ?`,
      params: [...where.params, limit, offset],
    },
    count: { sql: `SELECT COUNT(*) AS n ${from}`, params: [...where.params] },
    columns: view.columns,
  };
}

/**
 * Calendar context of date-relative filters (earnings / IPO / news "today", "this week", "after market close"):
 * the selected market's zone and close from the market registry; "ALL" mixes zones, so it uses UTC days (with the
 * US close for "after market close"); unknown markets fall back to New York.
 */
export function dateCtx(market: string, now: Date): Pick<CompileCtx, "today" | "tz" | "close"> {
  const usClose = { hour: 16, minute: 0, tz: MARKET_TZ };
  if (market === ALL_MARKETS) return { today: todayIn(now, "UTC"), tz: "UTC", close: usClose };
  const m = market === DEFAULT_MARKET ? undefined : getMarket(market);
  if (!m) return { today: nyToday(now), tz: MARKET_TZ, close: usClose };
  const [h, mi] = m.close.split(":").map(Number) as [number, number];
  return { today: todayIn(now, m.timezone), tz: m.timezone, close: { hour: h, minute: mi || 0, tz: m.timezone } };
}

// ---------------------------------------------------------------- engine bound to a database

interface DynEntry { at: number; bySlug: Map<string, { label: string; raws: string[] }>; byLabel: Map<string, string> }

export interface ScreenerEngineOpts {
  now?: () => Date;
  /** Markets the pipeline tracks (universe `listMarkets`). Default / empty: derived from the table's `market` values. */
  markets?: () => MarketInfo[];
}

/** Columns each filter reads (discovered by compiling every option with a recording resolver). */
function filterColumns(f: FilterSpec): string[] {
  const seen = new Set<string>();
  const rec: CompileCtx = { col: (n) => { makeColResolver()(n); seen.add(n); return quoteIdent(n); }, today: "2026-01-15", now: new Date(0) };
  for (const o of f.options) o.build(rec);
  if (f.custom) seen.add(f.custom.col);
  if (f.dynamic) seen.add(f.dynamic.col);
  return [...seen];
}
const FILTER_COLS = new Map(FILTERS.map((f) => [f.id, filterColumns(f)]));

/** Sparse-by-nature columns (NULL = "no event") → a column that says whether the data exists at all. */
const SPARSE_PROXY: Record<string, string> = {
  new_high: "price", new_low: "price", candlestick: "price", ath_date: "ath_pct",
  earnings_timing: "earnings_date", last_earnings_date: "earnings_date",
};
const COVERAGE_SKIP = new Set(["kind", "market", "symbol", "code"]);
/**
 * Columns computed from daily bars (every priced row can have them). All other columns come from per-ticker
 * fundamentals / calendars that the pipeline fills gradually within its credit budget, so their coverage is measured
 * against the rows whose fundamentals were fetched — a US universe half-way through its backfill is not "no data".
 */
const BAR_COLS = new Set([
  "price", "prev_close", "open", "change_pct", "change_from_open_pct", "gap_pct", "volume", "avg_volume", "rel_volume",
  "dollar_volume", "dollar_volume_usd", "price_usd", "perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y",
  "perf_3y", "perf_5y", "sma20", "sma50", "sma200", "sma20_pct", "sma50_pct", "sma200_pct", "sma20_vs_sma50_pct",
  "sma50_vs_sma200_pct", "sma20_cross", "sma50_cross", "sma200_cross", "sma50_200_cross", "rsi14", "atr14", "atr_pct",
  "volatility_1w", "volatility_1m", "high_20d_pct", "low_20d_pct", "high_50d_pct", "low_50d_pct", "high_52w_pct",
  "low_52w_pct", "new_high", "new_low", "candlestick", "ath", "ath_date", "ath_pct", "atl_pct", "price_date",
  "in_sp500", "in_ndx", "in_dji",
]);
const FUND_MARKER = "fundamentals_at";

/** Columns whose non-null fraction decides whether `f` is usable in a market (empty → always usable). */
export function coverageColumns(f: FilterSpec, usd: boolean): string[] {
  const base = f.coverageCols ?? (f.custom ? [f.custom.col] : FILTER_COLS.get(f.id) ?? []);
  const cols = base.filter((c) => !COVERAGE_SKIP.has(c)).map((c) => SPARSE_PROXY[c] ?? c).map((c) => (usd ? USD_REMAP[c] ?? c : c));
  return [...new Set(cols)];
}

export interface MarketCoverage {
  /** Row counts per kind ("stock" | "etf") and overall ("all"). */
  rows: Record<string, number>;
  /** Non-null counts per kind then column. */
  nonNull: Record<string, Record<string, number>>;
}

/**
 * Availability of `f` given a market's coverage. Pure; exported for tests.
 * Returns null when available, else the reason.
 */
export function coverageReason(f: FilterSpec, market: string, cov: MarketCoverage): string | null {
  const kind = f.appliesTo === "all" ? "all" : f.appliesTo;
  const n = cov.rows[kind] ?? 0;
  if (!n) return (cov.rows.all ?? 0) > 0 && f.appliesTo === "etf" ? "No ETFs in this market" : null;
  const cols = coverageColumns(f, market !== DEFAULT_MARKET);
  if (!cols.length) return null;
  const fundRows = cov.nonNull[kind]?.[FUND_MARKER] ?? 0;
  const denom = (c: string) => (BAR_COLS.has(c) || c === FUND_MARKER || !fundRows ? n : fundRows);
  // Columns computed from the same source are alternatives: the best-filled one decides.
  const frac = Math.min(1, Math.max(...cols.map((c) => (cov.nonNull[kind]?.[c] ?? 0) / denom(c))));
  if (frac >= MIN_COVERAGE) return null;
  const pct = Math.round(frac * 100);
  return f.usOnly && market !== DEFAULT_MARKET && market !== ALL_MARKETS
    ? `US-only data (coverage ${pct}% in ${market})`
    : `No data for this market: coverage ${pct}%`;
}

export function createScreenerEngine(db: Database, opts: ScreenerEngineOpts = {}) {
  const now = opts.now ?? (() => new Date());
  const dynCache = new Map<string, DynEntry>();
  const covCache = new Map<string, { at: number; cov: MarketCoverage }>();
  let marketsCache: { at: number; list: MarketInfo[] } | null = null;

  function presentColumns(): Set<string> {
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(METRICS_TABLE)})`).all();
    return new Set(rows.map((r) => r.name));
  }

  function ctxFor(present: Set<string>, market: string = DEFAULT_MARKET): CompileCtx {
    const d = now();
    return { col: makeColResolver(present), now: d, ...dateCtx(market, d) };
  }

  // ---- markets

  function derivedMarkets(): MarketInfo[] {
    const present = presentColumns();
    if (!present.size) return [];
    const col = makeColResolver(present);
    const rows = db.query<{ m: string; n: number; p: number; f: number; d: string | null; cur: string | null }, []>(
      `SELECT ${col("market")} AS m, COUNT(*) AS n, COUNT(${col("price")}) AS p, COUNT(${col("fundamentals_at")}) AS f,
              MAX(${col("price_date")}) AS d, MAX(${col("currency")}) AS cur
       FROM ${quoteIdent(METRICS_TABLE)} GROUP BY 1 ORDER BY n DESC`,
    ).all();
    return rows.map((r) => ({
      code: String(r.m), name: String(r.m), country: "", currency: r.cur ?? "", timezone: "", enabled: true,
      symbols: r.n, withPrices: r.p, withFundamentals: r.f, lastPriceDate: r.d,
    }));
  }

  function markets(): MarketInfo[] {
    const t = Date.now();
    if (marketsCache && t - marketsCache.at < DYNAMIC_MISS_REFRESH_MS) return marketsCache.list;
    let list: MarketInfo[] = [];
    try {
      list = opts.markets?.() ?? [];
    } catch (e) {
      console.error("[screener] listMarkets failed", e);
    }
    if (!list.length) list = derivedMarkets();
    marketsCache = { at: t, list };
    return list;
  }

  const isKnownMarket = (code: string) => markets().some((m) => m.code === code);
  const enabledMarkets = () => markets().filter((m) => m.enabled).map((m) => m.code);

  /** WHERE fragment restricting to `market` (US/code/ALL). */
  function marketPred(market: string, col: (n: string) => string): Pred {
    if (market !== ALL_MARKETS) return { sql: `${col("market")} = ?`, params: [market] };
    const codes = enabledMarkets();
    return codes.length ? { sql: `${col("market")} IN (${codes.map(() => "?").join(", ")})`, params: codes } : { sql: "1", params: [] };
  }

  // ---- dynamic options ("*" = across all markets, used to validate/resolve query values)

  function loadDynamic(f: FilterSpec, market = "*", force = false): DynEntry {
    const src = f.dynamic!;
    const key = `${f.id}|${market}`;
    const hit = dynCache.get(key);
    const t = Date.now();
    if (hit && !force && t - hit.at < DYNAMIC_TTL_MS) return hit;
    if (hit && force && t - hit.at < DYNAMIC_MISS_REFRESH_MS) return hit;
    const present = presentColumns();
    const bySlug = new Map<string, { label: string; raws: string[] }>();
    const byLabel = new Map<string, string>();
    if (present.has(src.col)) {
      const colRef = makeColResolver(present);
      const col = quoteIdent(src.col);
      const where: Pred[] = [{ sql: `${col} IS NOT NULL AND TRIM(${col}) <> ''`, params: [] }];
      if (src.kind && present.has("kind")) where.push({ sql: `"kind" = ?`, params: [src.kind] });
      if (market !== "*") where.push(marketPred(market, colRef));
      const w = and(where);
      const rows = db.query<{ v: string }, SqlParam[]>(
        `SELECT DISTINCT ${col} AS v FROM ${quoteIdent(METRICS_TABLE)} WHERE ${w.sql}`,
      ).all(...w.params);
      const staticValues = new Set(f.options.map((o) => o.value));
      const names = f.id === "market" ? new Map(markets().map((m) => [m.code, m.name])) : null;
      for (const { v } of rows) {
        const rawV = String(v);
        const slug = slugify(rawV);
        if (!slug || staticValues.has(slug)) continue;
        const label = names ? (names.get(rawV) && names.get(rawV) !== rawV ? `${names.get(rawV)} (${rawV})` : rawV) : src.label ? src.label(rawV) : rawV;
        const e = bySlug.get(slug);
        if (e) e.raws.push(rawV);
        else bySlug.set(slug, { label, raws: [rawV] });
        const ls = slugify(label);
        if (ls && ls !== slug && !byLabel.has(ls)) byLabel.set(ls, slug);
      }
    }
    const entry = { at: t, bySlug, byLabel };
    dynCache.set(key, entry);
    return entry;
  }

  /** Raw DB values for a dynamic option slug (also accepts the slug of its display label, e.g. Finviz "financial"). */
  const resolveDynamic: DynamicResolver = (f, slug) => {
    const find = (e: DynEntry) => e.bySlug.get(slug) ?? e.bySlug.get(e.byLabel.get(slug) ?? "");
    let e = loadDynamic(f);
    let hit = find(e);
    if (!hit) { e = loadDynamic(f, "*", true); hit = find(e); }
    return hit?.raws ?? null;
  };

  // ---- coverage

  function marketCoverage(market: string): MarketCoverage {
    const t = Date.now();
    const hit = covCache.get(market);
    if (hit && t - hit.at < DYNAMIC_TTL_MS) return hit.cov;
    const present = presentColumns();
    const cov: MarketCoverage = { rows: {}, nonNull: {} };
    if (present.size) {
      const col = makeColResolver(present);
      const usd = market !== DEFAULT_MARKET;
      const cols = [...new Set([FUND_MARKER, "indices", ...FILTERS.flatMap((f) => coverageColumns(f, usd))])];
      const where = marketPred(market, col);
      const rows = db.query<Record<string, number | string | null>, SqlParam[]>(
        `SELECT ${col("kind")} AS __k, COUNT(*) AS __n${cols.map((c, i) => `, COUNT(${col(c)}) AS c${i}`).join("")}
         FROM ${quoteIdent(METRICS_TABLE)} WHERE ${where.sql} GROUP BY 1`,
      ).all(...where.params);
      const add = (kind: string, r: Record<string, number | string | null>) => {
        cov.rows[kind] = (cov.rows[kind] ?? 0) + Number(r.__n ?? 0);
        const nn = (cov.nonNull[kind] ??= {});
        cols.forEach((c, i) => { nn[c] = (nn[c] ?? 0) + Number(r[`c${i}`] ?? 0); });
      };
      for (const r of rows) {
        if (r.__k === "stock" || r.__k === "etf") add(r.__k, r);
        add("all", r);
      }
    }
    covCache.set(market, { at: t, cov });
    return cov;
  }

  function filterDefs(market: string): ScreenerFilterDef[] {
    const cov = marketCoverage(market);
    const intl = market !== DEFAULT_MARKET && market !== ALL_MARKETS;
    return FILTERS.map((f): ScreenerFilterDef => {
      let options: ScreenerOption[] = f.options.map(({ value, label }: OptionSpec) => ({ value, label }));
      let available = f.available;
      let unavailableReason = f.unavailableReason;
      if (f.id === "idx" && market !== DEFAULT_MARKET) {
        // S&P 500 / NASDAQ 100 / DJIA are US concepts; other markets list their own indexes (FTSE 100, DAX, OMXS30…).
        const enabled = new Set(enabledMarkets());
        const own = indexOptions()
          .filter((o) => (intl ? o.market === market : enabled.has(o.market)))
          .map(({ value, label }) => ({ value, label }));
        options = intl ? own : [...options, ...own];
        if (intl && !(own.length && (cov.nonNull.all?.indices ?? 0) > 0)) {
          available = false;
          unavailableReason = own.length
            ? "No index membership data for this market yet"
            : "No index membership data for this market (US indexes: S&P 500, NASDAQ 100, DJIA)";
        }
      }
      if (f.dynamic) {
        const dyn = [...loadDynamic(f, market).bySlug.entries()]
          .map(([value, e]) => ({ value, label: e.label }))
          .sort((a, b) => a.label.localeCompare(b.label));
        options = [...options, ...dyn];
      }
      if (available && f.id === "market" && market !== ALL_MARKETS) {
        available = false;
        unavailableReason = "Select market ALL to filter by market";
      }
      if (available && !(f.id === "idx" && intl)) {
        const reason = coverageReason(f, market, cov);
        if (reason) { available = false; unavailableReason = reason; }
      }
      if (available && f.dynamic && options.length === 0) {
        available = false;
        unavailableReason = "No values in this market yet";
      }
      return {
        id: f.id, code: filterCode(f), label: f.label, group: f.group, options, appliesTo: f.appliesTo, available,
        ...(f.custom ? { custom: { unit: f.custom.unit } } : {}),
        ...(unavailableReason && !available ? { unavailableReason } : {}),
      };
    });
  }

  const engine = {
    meta(universe: UniverseStatus, market?: string): ScreenerMeta {
      const m = normalizeMarket(market, isKnownMarket);
      return { markets: markets(), market: m, filters: filterDefs(m), columns: columnDefs(), views: viewsFor(m), universe };
    },

    markets,

    normalize(body: unknown): ScreenerQuery {
      return normalizeQuery(body, { checkDynamic: (f, slug) => resolveDynamic(f, slug) !== null, checkMarket: isKnownMarket });
    },

    run(q: ScreenerQuery): ScreenerResponse {
      const present = presentColumns();
      if (!present.size) return { total: 0, rows: [], asOf: null };
      const built = buildQuery(q, ctxFor(present, q.market ?? DEFAULT_MARKET), resolveDynamic, { allMarkets: enabledMarkets() });
      const total = db.query<{ n: number }, SqlParam[]>(built.count.sql).get(...built.count.params)?.n ?? 0;
      const rows = db.query<Record<string, number | string | null>, SqlParam[]>(built.select.sql).all(...built.select.params);
      let asOf: string | null = null;
      if (present.has("price_date")) {
        const mp = marketPred(q.market ?? DEFAULT_MARKET, makeColResolver(present));
        asOf = db.query<{ d: string | null }, SqlParam[]>(
          `SELECT MAX("price_date") AS d FROM ${quoteIdent(METRICS_TABLE)} WHERE ${mp.sql}`,
        ).get(...mp.params)?.d ?? null;
      }
      return { total, rows, asOf };
    },

    query(body: unknown): ScreenerResponse {
      return engine.run(engine.normalize(body));
    },

    /** Drop cached DISTINCT options / coverage / markets (tests, after a pipeline run). */
    invalidate(): void {
      dynCache.clear();
      covCache.clear();
      marketsCache = null;
    },
  };
  return engine;
}
export type ScreenerEngine = ReturnType<typeof createScreenerEngine>;
