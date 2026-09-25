// Agent-facing operations shared by REST /api/v1 and the MCP tools. Everything data-related goes through an
// injected AgentBackend (the real one is backend.ts; tests pass one over a temp DB).
import type {
  BarsResponse, ChartEvent, MarketInfo, NewsItem, ScreenerFilterDef, ScreenerFilterValue, ScreenerMeta, ScreenerQuery,
  ScreenerResponse, SymbolInfo, SymbolOverview, Timeframe, UniverseStatus,
} from "@eodview/shared";
import { TIMEFRAMES } from "@eodview/shared";
import { parseDetailsSymbol } from "../details/symbol";
import { badRequest } from "./errors";
import {
  filterCode, normalizeMarket, parseFinvizFilters, parseOrder, parseScreenParams, parseUniverse, parseView, SCREEN_DEFAULT_LIMIT,
  SCREEN_MAX_LIMIT, toFinvizCodes,
} from "./finviz";

export interface AgentBackend {
  meta(market: string): ScreenerMeta | Promise<ScreenerMeta>;
  runScreen(q: ScreenerQuery): ScreenerResponse | Promise<ScreenerResponse>;
  markets(): MarketInfo[];
  status(): UniverseStatus;
  /** The screener module's own Finviz parser, when it has one. */
  parseFilters?: (f: string) => ScreenerFilterValue[];
  /** The screener module's own `o=` parser, when it has one. */
  parseOrder?: (o: string | null) => ScreenerQuery["sort"];
  overview(symbol: string): Promise<SymbolOverview>;
  bars(symbol: string, tf: Timeframe, limit: number, to?: number, adjusted?: boolean): Promise<BarsResponse>;
  news(symbol: string, limit: number): Promise<NewsItem[]>;
  events(symbol: string, from?: number, to?: number): Promise<ChartEvent[]>;
  /** Search the local universe DB (free). */
  searchLocal(q: string, limit: number): SymbolInfo[];
  /** EODHD search API (costs an API call). */
  searchRemote(q: string): Promise<SymbolInfo[]>;
}

export interface ScreenResult {
  market: string;
  universe: ScreenerQuery["universe"];
  view: string;
  /** Echo of the filters as Finviz codes. */
  f: string;
  sort: string;
  total: number;
  offset: number;
  limit: number;
  count: number;
  columns: string[];
  rows: ScreenerResponse["rows"];
  asOf: string | null;
}

export interface CompactFilter {
  id: string;
  code: string;
  label: string;
  group: string;
  appliesTo: string;
  available: boolean;
  reason?: string;
  custom?: string;
  options?: Array<{ code: string; label: string }>;
}

export const BAR_COLUMNS = ["date", "open", "high", "low", "close", "volume"] as const;

const isDaily = (tf: Timeframe) => tf === "1D" || tf === "1W" || tf === "1M";

export function formatBarTime(t: number, tf: Timeframe): string {
  const iso = new Date(t * 1000).toISOString();
  return isDaily(tf) ? iso.slice(0, 10) : iso.replace(/\.000Z$/, "Z");
}

/** "AAPL" → "AAPL.US"; validates TICKER.EXCHANGE. */
export function normalizeSymbol(raw: unknown): { symbol: string; market: string } {
  if (typeof raw !== "string") badRequest("symbol is required (TICKER.EXCHANGE, e.g. AAPL.US)");
  const s = raw.trim();
  const p = parseDetailsSymbol(s.includes(".") ? s : `${s}.US`);
  return { symbol: p.symbol, market: p.exchange };
}

export function parseTf(raw: unknown): Timeframe {
  if (raw === undefined || raw === null || raw === "") return "1D";
  if (typeof raw !== "string" || !TIMEFRAMES.includes(raw as Timeframe)) badRequest(`tf must be one of ${TIMEFRAMES.join(", ")}`);
  return raw as Timeframe;
}

/** Unix seconds or YYYY-MM-DD[THH:MM…] → unix seconds. */
export function parseTime(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw);
  if (typeof raw === "string") {
    if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? `${raw.trim()}T00:00:00Z` : raw.trim());
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  badRequest(`${name} must be unix seconds or an ISO date (YYYY-MM-DD)`);
}

/** How to write a custom range for a filter (Finviz style). */
export function customSyntax(code: string, unit: string): string {
  return unit === "date" ? `${code}_<YYYY-MM-DD>x<YYYY-MM-DD>` : `${code}_<min>to<max> (${unit})`;
}

export function createAgentService(backend: AgentBackend) {
  function checkMarket(raw: string | undefined | null): string {
    const m = normalizeMarket(raw);
    if (m === "ALL") return m;
    const markets = backend.markets();
    if (!markets.length && m === "US") return m;
    if (!markets.some((x) => x.code.toUpperCase() === m)) {
      badRequest(`unknown market "${m}"`, `tracked markets: ${[...markets.map((x) => x.code), "ALL"].join(", ")} (GET /api/v1/markets)`);
    }
    return m;
  }

  /** `o=` string → sort (the screener module's parser when available). */
  function parseSort(o: string | null | undefined, columns: ScreenerMeta["columns"]): ScreenerQuery["sort"] {
    return backend.parseOrder ? backend.parseOrder(o ?? null) : parseOrder(o, columns);
  }

  async function meta(market: string): Promise<ScreenerMeta> {
    const m = await backend.meta(market);
    return { ...m, market: m.market ?? market, markets: m.markets ?? backend.markets() };
  }

  async function screen(q: ScreenerQuery): Promise<ScreenResult> {
    const market = checkMarket(q.market);
    const query: ScreenerQuery = { ...q, market };
    const [res, m] = await Promise.all([backend.runScreen(query), meta(market)]);
    const view = m.views.find((v) => v.id === query.view);
    const columns = ["symbol", ...(view?.columns ?? Object.keys(res.rows[0] ?? {}).filter((k) => k !== "symbol"))];
    return {
      market,
      universe: query.universe,
      view: query.view,
      f: toFinvizCodes(query.filters, m.filters),
      sort: `${query.sort.dir === "desc" ? "-" : ""}${query.sort.column}`,
      total: res.total,
      offset: query.offset,
      limit: query.limit,
      count: res.rows.length,
      columns,
      rows: res.rows,
      asOf: res.asOf,
    };
  }

  const api = {
    checkMarket,
    parseSort,
    meta,
    screen,

    /** GET /api/v1/screen query string → result. */
    async screenFromParams(sp: URLSearchParams, maxLimit?: number): Promise<ScreenResult> {
      const market = checkMarket(sp.get("market"));
      const m = await meta(market);
      const q = parseScreenParams(sp, {
        filters: m.filters, columns: m.columns, views: m.views, maxLimit,
        ...(backend.parseFilters ? { parseFilters: backend.parseFilters } : {}),
        ...(backend.parseOrder ? { parseOrder: backend.parseOrder } : {}),
      });
      return screen({ ...q, market });
    },

    /**
     * POST /api/v1/screen body: a ScreenerQuery, where `filters` may also hold Finviz code strings, `sort` may be a
     * string ("-perf_3m"), and the Finviz shorthands `f`, `o`, `v` are accepted.
     */
    async screenFromBody(body: unknown, maxLimit = SCREEN_MAX_LIMIT): Promise<ScreenResult> {
      if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest("body must be a ScreenerQuery object");
      const b = body as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : null);
      const market = checkMarket(s(b.market));
      const m = await meta(market);
      if (b.filters !== undefined && b.filters !== null && !Array.isArray(b.filters)) badRequest("filters must be an array");
      const filters = [...await api.resolveFilters(market, b.filters), ...await api.resolveFilters(market, s(b.f))];
      let sortStr = s(b.o);
      if (typeof b.sort === "string") sortStr = b.sort;
      else if (b.sort !== undefined && b.sort !== null) {
        const so = b.sort as { column?: unknown; dir?: unknown };
        if (typeof so !== "object" || typeof so.column !== "string" || (so.dir !== undefined && so.dir !== "asc" && so.dir !== "desc")) {
          badRequest('sort must be {column, dir} or a string like "-perf_3m"');
        }
        sortStr = `${so.dir === "desc" ? "-" : ""}${so.column}`;
      }
      const int = (v: unknown, name: string, def: number, max: number) => {
        if (v === undefined || v === null) return def;
        if (typeof v !== "number" || !Number.isInteger(v) || v < (name === "limit" ? 1 : 0) || v > max) {
          badRequest(`${name} must be an integer ${name === "limit" ? 1 : 0}..${max}`);
        }
        return v;
      };
      const tickers = s(b.tickers)?.trim();
      return screen({
        filters, market,
        universe: parseUniverse(s(b.universe), filters),
        ...(tickers ? { tickers } : {}),
        view: parseView(s(b.view) ?? s(b.v), m.views),
        sort: parseSort(sortStr, m.columns),
        offset: int(b.offset, "offset", 0, 10_000_000),
        limit: int(b.limit, "limit", SCREEN_DEFAULT_LIMIT, maxLimit),
      });
    },

    /** Finviz codes string or structured filters → ScreenerFilterValue[] (MCP / POST body `f`). */
    async resolveFilters(market: string, input: unknown): Promise<ScreenerFilterValue[]> {
      if (input === undefined || input === null || input === "") return [];
      const m = await meta(market);
      const parse = (s: string) => (backend.parseFilters ? backend.parseFilters(s) : parseFinvizFilters(s, m.filters));
      if (typeof input === "string") return parse(input);
      if (!Array.isArray(input)) badRequest("filters must be a string of Finviz codes or an array");
      const out: ScreenerFilterValue[] = [];
      for (const [i, item] of input.entries()) {
        if (typeof item === "string") { out.push(...parse(item)); continue; }
        if (typeof item !== "object" || item === null) badRequest(`filters[${i}] must be an object or code string`);
        const it = item as Record<string, unknown>;
        if (typeof it.code === "string") { out.push(...parse(it.code)); continue; }
        if (typeof it.id !== "string") badRequest(`filters[${i}] needs "code" or "id"`);
        const def = m.filters.find((d) => d.id === it.id || filterCode(d) === String(it.id).toLowerCase());
        if (!def) badRequest(`unknown filter "${String(it.id).slice(0, 40)}"`, "see list_filters / GET /api/v1/filters");
        if (typeof it.value === "string") out.push({ id: def.id, value: it.value });
        else if (it.min !== undefined || it.max !== undefined) {
          out.push({ id: def.id, ...(it.min !== undefined ? { min: it.min as number | string } : {}), ...(it.max !== undefined ? { max: it.max as number | string } : {}) });
        } else badRequest(`filters[${i}] needs "value" or "min"/"max"`);
      }
      return out;
    },

    async compactFilters(market: string, opts: { group?: string; availableOnly?: boolean; query?: string; options?: boolean } = {}) {
      const m = await meta(market);
      const q = opts.query?.trim().toLowerCase();
      const filters: CompactFilter[] = m.filters
        .filter((f) => !opts.group || f.group === opts.group)
        .filter((f) => !opts.availableOnly || f.available)
        .filter((f) => !q || f.label.toLowerCase().includes(q) || filterCode(f).includes(q) || f.id.includes(q))
        .map((f: ScreenerFilterDef) => {
          const code = filterCode(f);
          return {
            id: f.id, code, label: f.label, group: f.group, appliesTo: f.appliesTo, available: f.available,
            ...(f.available ? {} : { reason: f.unavailableReason ?? "not available" }),
            ...(f.custom ? { custom: customSyntax(code, f.custom.unit) } : {}),
            ...(opts.options === false ? {} : { options: f.options.map((o) => ({ code: `${code}_${o.value}`, label: o.label })) }),
          };
        });
      return { market: m.market, asOf: m.universe?.lastPriceDate ?? null, count: filters.length, filters };
    },

    markets() {
      const markets = backend.markets();
      return { asOf: backend.status().lastPriceDate, markets };
    },

    status(market?: string | null) {
      const st = backend.status();
      if (market) {
        const m = checkMarket(market);
        const info = backend.markets().find((x) => x.code.toUpperCase() === m) ?? null;
        return { market: m, asOf: info?.lastPriceDate ?? st.lastPriceDate, marketInfo: info, ...st };
      }
      return { market: "ALL", asOf: st.lastPriceDate, ...st };
    },

    async overview(symbolRaw: unknown) {
      const { symbol, market } = normalizeSymbol(symbolRaw);
      const o = await backend.overview(symbol);
      return { symbol, market, asOf: o.quote ? new Date(o.quote.time * 1000).toISOString() : null, ...o };
    },

    async bars(symbolRaw: unknown, opts: { tf?: unknown; limit?: number; to?: unknown; adjusted?: boolean; compact?: boolean }) {
      const { symbol, market } = normalizeSymbol(symbolRaw);
      const tf = parseTf(opts.tf);
      const to = parseTime(opts.to, "to");
      const res = await backend.bars(symbol, tf, opts.limit ?? 200, to, opts.adjusted ?? true);
      const last = res.bars[res.bars.length - 1];
      const asOf = last ? formatBarTime(last.time, tf) : null;
      const head = { symbol, market, tf, adjusted: opts.adjusted ?? true, asOf, count: res.bars.length, hasMore: res.hasMore };
      if (!opts.compact) return { ...head, bars: res.bars };
      return {
        ...head,
        columns: [...BAR_COLUMNS],
        rows: res.bars.map((b) => [formatBarTime(b.time, tf), b.open, b.high, b.low, b.close, b.volume] as const),
      };
    },

    async news(symbolRaw: unknown, limit: number) {
      const { symbol, market } = normalizeSymbol(symbolRaw);
      const items = await backend.news(symbol, limit);
      return { symbol, market, asOf: new Date().toISOString(), count: items.length, news: items };
    },

    async events(symbolRaw: unknown, from?: unknown, to?: unknown) {
      const { symbol, market } = normalizeSymbol(symbolRaw);
      const items = await backend.events(symbol, parseTime(from, "from"), parseTime(to, "to"));
      return {
        symbol, market, asOf: new Date().toISOString(), count: items.length,
        events: items.map((e) => ({ ...e, date: formatBarTime(e.time, "1D") })),
      };
    },

    async search(qRaw: unknown, limit = 10, source: "auto" | "local" | "remote" = "auto") {
      const q = typeof qRaw === "string" ? qRaw.trim().slice(0, 64) : "";
      if (!q) badRequest("q (query) is required");
      let results: SymbolInfo[] = [];
      let used: "local" | "remote" = "local";
      if (source !== "remote") results = backend.searchLocal(q, limit);
      if (source === "remote" || (source === "auto" && results.length === 0)) {
        results = (await backend.searchRemote(q)).slice(0, limit);
        used = "remote";
      }
      return { q, source: used, asOf: new Date().toISOString(), count: results.length, results };
    },
  };
  return api;
}
export type AgentService = ReturnType<typeof createAgentService>;
