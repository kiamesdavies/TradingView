// Screener query validation + SQL building + execution over `universe_metrics`.
// Only registry-defined column names ever reach SQL text; all user values are bound parameters.
import type { Database } from "bun:sqlite";
import type {
  ScreenerFilterDef, ScreenerFilterValue, ScreenerMeta, ScreenerOption, ScreenerQuery, ScreenerResponse, UniverseStatus,
} from "@eodview/shared";
import { HttpError } from "../http";
import { METRICS_TABLE } from "../universe/metricsSchema";
import { columnDefs, getColumn, getView, VIEWS, type ColumnSpec } from "./columns";
import { isIsoDate, nyToday } from "./dates";
import { FILTERS, getFilter, type FilterSpec, type OptionSpec } from "./filters";
import { and, makeColResolver, or, quoteIdent, type CompileCtx, type Pred, type SqlParam } from "./sql";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 50;
const MAX_FILTERS = 100;
const MAX_MULTI = 50;
const MAX_TICKERS = 500;
const DYNAMIC_TTL_MS = 10 * 60_000;
const DYNAMIC_MISS_REFRESH_MS = 5_000;

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
      const parts = value.split("|");
      if (parts.length > MAX_MULTI) bad(`filter ${id}: at most ${MAX_MULTI} values`);
      for (const p of parts) {
        if (f.options.some((o) => o.value === p)) continue;
        if (f.dynamic && DYN_SLUG_RE.test(p) && checkDynamic(f, p)) continue;
        bad(`filter "${f.label}": unknown option ${show(p)}`);
      }
      out.push({ id, value: parts.join("|") });
      return;
    }
    if (!f.custom) bad(`filter "${f.label}" does not support a custom range`);
    const min = parseBound(raw.min, f, "min");
    const max = parseBound(raw.max, f, "max");
    if (min === undefined && max === undefined) return; // "Any"
    out.push({ id, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
  });
  return out;
}

export interface NormalizeOpts {
  /** Validate dynamic option slugs (sector/industry/…) against the current universe. Presets only check the shape. */
  checkDynamic?: (f: FilterSpec, slug: string) => boolean;
}

export function normalizePresetQuery(body: unknown, opts: NormalizeOpts = {}): PresetQuery {
  if (!isObj(body)) bad("query must be a JSON object");
  const filters = normalizeFilters(body.filters, opts.checkDynamic ?? (() => true));
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
  return { filters, universe, ...(tickers ? { tickers } : {}), view, sort: { column, dir } };
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

export function compileFilter(v: ScreenerFilterValue, ctx: CompileCtx, resolve: DynamicResolver): Pred {
  const f = getFilter(v.id);
  if (!f) bad(`unknown filter "${v.id}"`);
  if ("value" in v) {
    const preds = v.value.split("|").map((part): Pred => {
      const o = f.options.find((x) => x.value === part);
      if (o) return o.build(ctx);
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

export function buildQuery(q: ScreenerQuery, ctx: CompileCtx, resolve: DynamicResolver): BuiltQuery {
  const view = getView(q.view);
  if (!view) bad(`unknown view ${show(q.view)}`);
  const preds: Pred[] = [];
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
  const sortCol = q.sort.column === "symbol" ? null : getColumn(q.sort.column);
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

// ---------------------------------------------------------------- engine bound to a database

interface DynEntry { at: number; bySlug: Map<string, { label: string; raws: string[] }> }

export interface ScreenerEngineOpts {
  now?: () => Date;
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

export function createScreenerEngine(db: Database, opts: ScreenerEngineOpts = {}) {
  const now = opts.now ?? (() => new Date());
  const dynCache = new Map<string, DynEntry>();
  let coverage: { at: number; rows: number; nonNull: Map<string, number> } | null = null;

  function presentColumns(): Set<string> {
    const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(METRICS_TABLE)})`).all();
    return new Set(rows.map((r) => r.name));
  }

  function ctxFor(present: Set<string>): CompileCtx {
    const d = now();
    return { col: makeColResolver(present), today: nyToday(d), now: d };
  }

  function loadDynamic(f: FilterSpec, force = false): DynEntry {
    const src = f.dynamic!;
    const hit = dynCache.get(f.id);
    const t = Date.now();
    if (hit && !force && t - hit.at < DYNAMIC_TTL_MS) return hit;
    if (hit && force && t - hit.at < DYNAMIC_MISS_REFRESH_MS) return hit;
    const present = presentColumns();
    const bySlug = new Map<string, { label: string; raws: string[] }>();
    if (present.has(src.col)) {
      const col = quoteIdent(src.col);
      const kindSql = src.kind && present.has("kind") ? ` AND "kind" = ?` : "";
      const rows = db.query<{ v: string }, SqlParam[]>(
        `SELECT DISTINCT ${col} AS v FROM ${quoteIdent(METRICS_TABLE)} WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''${kindSql}`,
      ).all(...(kindSql ? [src.kind!] : []));
      const staticValues = new Set(f.options.map((o) => o.value));
      for (const { v } of rows) {
        const slug = slugify(String(v));
        if (!slug || staticValues.has(slug)) continue;
        const e = bySlug.get(slug);
        if (e) e.raws.push(String(v));
        else bySlug.set(slug, { label: src.label ? src.label(String(v)) : String(v), raws: [String(v)] });
      }
    }
    const entry = { at: t, bySlug };
    dynCache.set(f.id, entry);
    return entry;
  }

  const resolveDynamic: DynamicResolver = (f, slug) => {
    let e = loadDynamic(f);
    if (!e.bySlug.has(slug)) e = loadDynamic(f, true);
    return e.bySlug.get(slug)?.raws ?? null;
  };

  function dataCoverage() {
    const t = Date.now();
    if (coverage && t - coverage.at < DYNAMIC_TTL_MS) return coverage;
    const present = presentColumns();
    const nonNull = new Map<string, number>();
    let rows = 0;
    if (present.size) {
      const cols = [...new Set([...FILTER_COLS.values()].flat())].filter((c) => present.has(c));
      const r = db.query<Record<string, number>, []>(
        `SELECT COUNT(*) AS __n${cols.map((c, i) => `, COUNT(${quoteIdent(c)}) AS c${i}`).join("")} FROM ${quoteIdent(METRICS_TABLE)}`,
      ).get();
      rows = r?.__n ?? 0;
      cols.forEach((c, i) => nonNull.set(c, r?.[`c${i}`] ?? 0));
    }
    coverage = { at: t, rows, nonNull };
    return coverage;
  }

  function filterDefs(): ScreenerFilterDef[] {
    const cov = dataCoverage();
    return FILTERS.map((f): ScreenerFilterDef => {
      let options: ScreenerOption[] = f.options.map(({ value, label }: OptionSpec) => ({ value, label }));
      if (f.dynamic) {
        const dyn = [...loadDynamic(f).bySlug.entries()]
          .map(([value, e]) => ({ value, label: e.label }))
          .sort((a, b) => a.label.localeCompare(b.label));
        options = [...options, ...dyn];
      }
      let available = f.available;
      let unavailableReason = f.unavailableReason;
      if (available && cov.rows > 0) {
        const cols = (FILTER_COLS.get(f.id) ?? []).filter((c) => c !== "kind");
        if (cols.length && cols.every((c) => (cov.nonNull.get(c) ?? 0) === 0)) {
          available = false;
          unavailableReason = "No data collected yet (the universe pipeline has not filled these fields)";
        }
      }
      if (available && f.dynamic && options.length === 0) {
        available = false;
        unavailableReason = "No values in the universe yet";
      }
      return {
        id: f.id, label: f.label, group: f.group, options, appliesTo: f.appliesTo, available,
        ...(f.custom ? { custom: { unit: f.custom.unit } } : {}),
        ...(unavailableReason && !available ? { unavailableReason } : {}),
      };
    });
  }

  return {
    meta(universe: UniverseStatus): ScreenerMeta {
      return { filters: filterDefs(), columns: columnDefs(), views: VIEWS, universe };
    },

    normalize(body: unknown): ScreenerQuery {
      return normalizeQuery(body, { checkDynamic: (f, slug) => resolveDynamic(f, slug) !== null });
    },

    run(q: ScreenerQuery): ScreenerResponse {
      const present = presentColumns();
      if (!present.size) return { total: 0, rows: [], asOf: null };
      const built = buildQuery(q, ctxFor(present), resolveDynamic);
      const total = db.query<{ n: number }, SqlParam[]>(built.count.sql).get(...built.count.params)?.n ?? 0;
      const rows = db.query<Record<string, number | string | null>, SqlParam[]>(built.select.sql).all(...built.select.params);
      const asOf = present.has("price_date")
        ? db.query<{ d: string | null }, []>(`SELECT MAX("price_date") AS d FROM ${quoteIdent(METRICS_TABLE)}`).get()?.d ?? null
        : null;
      return { total, rows, asOf };
    },

    query(body: unknown): ScreenerResponse {
      return this.run(this.normalize(body));
    },

    /** Drop cached DISTINCT options / coverage (tests, after a pipeline run). */
    invalidate(): void {
      dynCache.clear();
      coverage = null;
    },
  };
}
export type ScreenerEngine = ReturnType<typeof createScreenerEngine>;
