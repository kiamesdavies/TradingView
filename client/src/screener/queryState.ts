// Pure screener query state: reducers, (de)serialisation, query building, paging. Covered by queryState.test.ts.
import type {
  ScreenerFilterDef, ScreenerFilterValue, ScreenerGroup, ScreenerPreset, ScreenerQuery,
} from "@eodview/shared";

export type ScreenerUniverse = ScreenerQuery["universe"];
export type FilterTab = ScreenerGroup | "all";
export type SortDir = "asc" | "desc";
export type PageSize = 20 | 50 | 100;

export const FILTER_TABS: { id: FilterTab; label: string }[] = [
  { id: "descriptive", label: "Descriptive" },
  { id: "fundamental", label: "Fundamental" },
  { id: "technical", label: "Technical" },
  { id: "news", label: "News" },
  { id: "etf", label: "ETF" },
  { id: "all", label: "All" },
];
export const PAGE_SIZES: PageSize[] = [20, 50, 100];
/** Client-only view: a mini-chart grid. Queried with the overview columns. */
export const CHARTS_VIEW = "charts";
export const CHARTS_QUERY_VIEW = "overview";
export const DEFAULT_SORT = { column: "ticker", dir: "asc" as SortDir };

export interface ScreenerState {
  filters: ScreenerFilterValue[];
  universe: ScreenerUniverse;
  tickers: string;
  view: string;
  sort: { column: string; dir: SortDir };
  /** 1-based */
  page: number;
  pageSize: PageSize;
  tab: FilterTab;
  filtersOpen: boolean;
  presetId: string | null;
}

export const DEFAULT_STATE: ScreenerState = {
  filters: [],
  universe: "stocks",
  tickers: "",
  view: "overview",
  sort: { ...DEFAULT_SORT },
  page: 1,
  pageSize: 20,
  tab: "descriptive",
  filtersOpen: true,
  presetId: null,
};

export function isCustom(v: ScreenerFilterValue): v is { id: string; min?: number | string; max?: number | string } {
  return !("value" in v);
}

function blank(x: unknown): boolean {
  return x === undefined || x === null || (typeof x === "string" && x.trim() === "") || (typeof x === "number" && !Number.isFinite(x));
}

/** A custom range with neither bound set is "Any". */
export function isEmptyFilter(v: ScreenerFilterValue): boolean {
  if (isCustom(v)) return blank(v.min) && blank(v.max);
  return v.value === "";
}

/** Set (or with `value === null`, clear) one filter. Keeps insertion order; resets to page 1. */
export function setFilter(s: ScreenerState, id: string, value: ScreenerFilterValue | null): ScreenerState {
  const rest = s.filters.filter((f) => f.id !== id);
  let filters = rest;
  if (value && !isEmptyFilter(value)) {
    const clean: ScreenerFilterValue = isCustom(value)
      ? { id, ...(blank(value.min) ? {} : { min: value.min }), ...(blank(value.max) ? {} : { max: value.max }) }
      : { id, value: value.value };
    const idx = s.filters.findIndex((f) => f.id === id);
    filters = idx >= 0 ? [...s.filters.slice(0, idx), clean, ...s.filters.slice(idx + 1)] : [...rest, clean];
  }
  return { ...s, filters, page: 1 };
}

export function removeFilter(s: ScreenerState, id: string): ScreenerState {
  return setFilter(s, id, null);
}

/** Reset: clears filters, tickers and preset; keeps view/sort/page size/universe tab choices of the user. */
export function resetFilters(s: ScreenerState): ScreenerState {
  return { ...s, filters: [], tickers: "", page: 1, presetId: null };
}

export function setUniverse(s: ScreenerState, universe: ScreenerUniverse): ScreenerState {
  return universe === s.universe ? s : { ...s, universe, page: 1 };
}

export function setTickers(s: ScreenerState, tickers: string): ScreenerState {
  return tickers === s.tickers ? s : { ...s, tickers, page: 1 };
}

export function setView(s: ScreenerState, view: string): ScreenerState {
  return { ...s, view };
}

/** Clicking a header: same column toggles, a new column starts at `firstDir`. Resets to page 1. */
export function toggleSort(s: ScreenerState, column: string, firstDir: SortDir = "asc"): ScreenerState {
  const dir: SortDir = s.sort.column === column ? (s.sort.dir === "asc" ? "desc" : "asc") : firstDir;
  return { ...s, sort: { column, dir }, page: 1 };
}

export function setPage(s: ScreenerState, page: number, total?: number): ScreenerState {
  let p = Math.max(1, Math.floor(page) || 1);
  if (total !== undefined) p = Math.min(p, totalPages(total, s.pageSize));
  return { ...s, page: p };
}

/** Changing the page size keeps the first visible row on screen. */
export function setPageSize(s: ScreenerState, pageSize: PageSize): ScreenerState {
  const firstRow = (s.page - 1) * s.pageSize;
  return { ...s, pageSize, page: Math.floor(firstRow / pageSize) + 1 };
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/**
 * Finviz-like page list: always first and last, a window around the current page, gaps as "gap".
 * e.g. (7, 20) -> [1, "gap", 5, 6, 7, 8, 9, "gap", 20]
 */
export function pageItems(current: number, pages: number, radius = 2): (number | "gap")[] {
  if (pages <= 1) return [1];
  const cur = Math.min(Math.max(1, current), pages);
  let lo = Math.max(2, cur - radius);
  let hi = Math.min(pages - 1, cur + radius);
  // keep the window a constant width near the edges
  const width = radius * 2;
  if (cur - radius < 2) hi = Math.min(pages - 1, lo + width);
  if (cur + radius > pages - 1) lo = Math.max(2, hi - width);
  const out: (number | "gap")[] = [1];
  if (lo > 2) out.push(lo === 3 ? 2 : "gap");
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < pages - 1) out.push(hi === pages - 2 ? pages - 1 : "gap");
  out.push(pages);
  return out;
}

/** Normalise the tickers input: "aapl  msft,,nvda" -> "AAPL, MSFT, NVDA" (empty -> undefined). */
export function normalizeTickers(text: string): string | undefined {
  const list = text.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  return list.length ? [...new Set(list)].join(", ") : undefined;
}

export function toQuery(s: ScreenerState, overrides: Partial<Pick<ScreenerQuery, "offset" | "limit">> = {}): ScreenerQuery {
  const tickers = normalizeTickers(s.tickers);
  return {
    filters: s.filters.filter((f) => !isEmptyFilter(f)),
    universe: s.universe,
    ...(tickers ? { tickers } : {}),
    view: s.view === CHARTS_VIEW ? CHARTS_QUERY_VIEW : s.view,
    sort: { ...s.sort },
    offset: overrides.offset ?? (s.page - 1) * s.pageSize,
    limit: Math.min(500, overrides.limit ?? s.pageSize),
  };
}

/** Key of everything that changes the result *set* (not paging/sort/view) — used to debounce filter edits. */
export function filterKey(s: ScreenerState): string {
  return JSON.stringify([s.filters, s.universe, normalizeTickers(s.tickers) ?? ""]);
}

export function presetQuery(s: ScreenerState): ScreenerPreset["query"] {
  const { offset: _o, limit: _l, ...q } = toQuery(s);
  // presets remember the Charts view by its client id
  return { ...q, view: s.view };
}

export function applyPreset(s: ScreenerState, p: ScreenerPreset): ScreenerState {
  const q = p.query;
  const next = sanitizeState({
    ...s,
    filters: q.filters ?? [],
    universe: q.universe ?? "stocks",
    tickers: q.tickers ?? "",
    view: q.view || s.view,
    sort: q.sort ?? s.sort,
  });
  return { ...next, page: 1, presetId: p.id };
}

/** Drop filters (and custom bounds) that the server no longer knows about. */
export function pruneUnknownFilters(s: ScreenerState, defs: ScreenerFilterDef[]): ScreenerState {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const filters = s.filters.filter((f) => {
    const d = byId.get(f.id);
    if (!d) return false;
    if (isCustom(f)) return !!d.custom;
    return d.options.some((o) => o.value === f.value);
  });
  return filters.length === s.filters.length ? s : { ...s, filters, page: 1 };
}

export function activeCounts(filters: ScreenerFilterValue[], defs: ScreenerFilterDef[]): Record<FilterTab, number> {
  const out: Record<FilterTab, number> = { descriptive: 0, fundamental: 0, technical: 0, news: 0, etf: 0, all: 0 };
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const f of filters) {
    if (isEmptyFilter(f)) continue;
    const d = byId.get(f.id);
    if (!d) continue;
    out[d.group]++;
    out.all++;
  }
  return out;
}

export function filtersForTab(defs: ScreenerFilterDef[], tab: FilterTab): ScreenerFilterDef[] {
  return tab === "all" ? defs : defs.filter((d) => d.group === tab);
}

// ---------------- persistence ----------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitizeFilter(v: unknown): ScreenerFilterValue | null {
  if (!isRecord(v) || typeof v.id !== "string" || !v.id) return null;
  if (typeof v.value === "string") return v.value ? { id: v.id, value: v.value } : null;
  const ok = (x: unknown) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x));
  const f: ScreenerFilterValue = {
    id: v.id,
    ...(ok(v.min) ? { min: v.min as number | string } : {}),
    ...(ok(v.max) ? { max: v.max as number | string } : {}),
  };
  return isEmptyFilter(f) ? null : f;
}

/** Merge a persisted / preset state (possibly stale or partial) over the defaults. */
export function sanitizeState(raw: unknown): ScreenerState {
  if (!isRecord(raw)) return { ...DEFAULT_STATE, sort: { ...DEFAULT_SORT } };
  const seen = new Set<string>();
  const filters = (Array.isArray(raw.filters) ? raw.filters : [])
    .map(sanitizeFilter)
    .filter((f): f is ScreenerFilterValue => !!f && !seen.has(f.id) && !!seen.add(f.id));
  const universe = raw.universe === "etfs" || raw.universe === "all" || raw.universe === "stocks" ? raw.universe : DEFAULT_STATE.universe;
  const sortRaw = isRecord(raw.sort) ? raw.sort : {};
  const sort = {
    column: typeof sortRaw.column === "string" && sortRaw.column ? sortRaw.column : DEFAULT_SORT.column,
    dir: sortRaw.dir === "desc" ? ("desc" as const) : ("asc" as const),
  };
  const pageSize = PAGE_SIZES.includes(raw.pageSize as PageSize) ? (raw.pageSize as PageSize) : DEFAULT_STATE.pageSize;
  const page = typeof raw.page === "number" && Number.isFinite(raw.page) && raw.page >= 1 ? Math.floor(raw.page) : 1;
  const tab = FILTER_TABS.some((t) => t.id === raw.tab) ? (raw.tab as FilterTab) : DEFAULT_STATE.tab;
  return {
    filters,
    universe,
    tickers: typeof raw.tickers === "string" ? raw.tickers.slice(0, 2000) : "",
    view: typeof raw.view === "string" && raw.view ? raw.view : DEFAULT_STATE.view,
    sort,
    page,
    pageSize,
    tab,
    filtersOpen: typeof raw.filtersOpen === "boolean" ? raw.filtersOpen : DEFAULT_STATE.filtersOpen,
    presetId: typeof raw.presetId === "string" && raw.presetId ? raw.presetId : null,
  };
}
