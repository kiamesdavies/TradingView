// Pure builders for the agent API: "Copy as API" URL / curl, "Copy MCP call" arguments, the MCP endpoint and the
// `claude mcp add` command. Covered by apiLinks.test.ts. Contract: shared/src/types.ts "v3" (GET/POST /api/v1/screen, /mcp).
import type { ScreenerFilterDef, ScreenerFilterValue, ScreenerQuery } from "@eodview/shared";
import { isCustom, isEmptyFilter } from "./queryState";

/** Vite dev server port: the API/MCP server then lives on the configured server port instead. */
export const VITE_DEV_PORT = "5173";
export const DEFAULT_SERVER_PORT = 3001;
export const TOKEN_ENV = "EODVIEW_API_TOKEN";

export interface LocationLike {
  protocol: string; // "http:"
  hostname: string;
  port: string; // "" for the default port
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Origin agents should call. In production the page is served by the Bun server itself, so it is the page origin.
 * Under the Vite dev server (5173) only /api and /ws are proxied, so /mcp must go to the server port directly
 * (ConfigView.port when known, else 3001).
 */
export function serverOrigin(loc: LocationLike, serverPort?: number | null): string {
  if (loc.port === VITE_DEV_PORT) return `${loc.protocol}//${hostWithBrackets(loc.hostname)}:${serverPort || DEFAULT_SERVER_PORT}`;
  return `${loc.protocol}//${hostWithBrackets(loc.hostname)}${loc.port ? `:${loc.port}` : ""}`;
}

function hostWithBrackets(h: string): string {
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

export function mcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

/** `claude mcp add` for the streamable-HTTP endpoint; remote callers need a bearer token. */
export function claudeMcpAddCommand(url: string, withToken: boolean, name = "eodview"): string {
  const auth = withToken ? ` --header "Authorization: Bearer <token>"` : "";
  return `claude mcp add --transport http ${name} ${url}${auth}`;
}

// ---------------- screen links ----------------

/** Finviz-style code of one filter value (`${def.code}_${value}`), or null when it can't be expressed in a URL. */
export function filterCode(def: ScreenerFilterDef | undefined, f: ScreenerFilterValue): string | null {
  if (!def?.code || isCustom(f)) return null;
  return f.value ? `${def.code}_${f.value}` : null;
}

export interface ScreenLink {
  /** "get" = a plain URL; "post" = a curl POST (custom ranges or filters without a code). */
  kind: "get" | "post";
  url: string;
  /** What to copy: the URL for GET, a curl command for POST. */
  text: string;
  /** Why POST was needed (for a toast). */
  reason?: string;
}

/** Filters that force a POST body: custom min/max ranges, or filter defs without a `code`. */
export function nonUrlFilters(query: Pick<ScreenerQuery, "filters">, defs: ScreenerFilterDef[]): string[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return query.filters.filter((f) => !isEmptyFilter(f) && filterCode(byId.get(f.id), f) === null).map((f) => byId.get(f.id)?.label ?? f.id);
}

const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ",");

/**
 * GET /api/v1/screen?f=cap_midover,ta_sma50_pa&market=US&o=-perf_3m&v=overview&limit=50
 * Extras beyond the documented params (only when non-default): universe=etfs|all, t=AAPL,MSFT (Finviz's ticker param).
 * Returns null when a filter can't be expressed as a code.
 */
export function buildScreenGetUrl(origin: string, query: ScreenerQuery, defs: ScreenerFilterDef[]): string | null {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const codes: string[] = [];
  for (const f of query.filters) {
    if (isEmptyFilter(f)) continue;
    const c = filterCode(byId.get(f.id), f);
    if (c === null) return null;
    codes.push(c);
  }
  const params: string[] = [];
  if (codes.length) params.push(`f=${codes.map(enc).join(",")}`);
  params.push(`market=${enc(query.market ?? "US")}`);
  if (query.universe && query.universe !== "stocks") params.push(`universe=${enc(query.universe)}`);
  if (query.tickers) params.push(`t=${query.tickers.split(/[\s,]+/).filter(Boolean).map(enc).join(",")}`);
  params.push(`o=${query.sort.dir === "desc" ? "-" : ""}${enc(query.sort.column)}`);
  params.push(`v=${enc(query.view)}`);
  params.push(`limit=${query.limit}`);
  if (query.offset > 0) params.push(`offset=${query.offset}`);
  return `${origin.replace(/\/+$/, "")}/api/v1/screen?${params.join("&")}`;
}

/** Single-quote a string for POSIX shells. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function authHeader(withToken: boolean): string {
  return withToken ? ` -H "Authorization: Bearer $${TOKEN_ENV}"` : "";
}

export function buildCurlGet(url: string, withToken: boolean): string {
  return `curl -s${authHeader(withToken)} ${shellQuote(url)}`;
}

/** The POST body: the query without paging noise at offset 0. */
export function screenBody(query: ScreenerQuery): ScreenerQuery {
  return {
    filters: query.filters.filter((f) => !isEmptyFilter(f)),
    market: query.market ?? "US",
    universe: query.universe,
    ...(query.tickers ? { tickers: query.tickers } : {}),
    view: query.view,
    sort: { ...query.sort },
    offset: query.offset,
    limit: query.limit,
  };
}

export function buildCurlPost(origin: string, query: ScreenerQuery, withToken: boolean): string {
  const url = `${origin.replace(/\/+$/, "")}/api/v1/screen`;
  return `curl -s -X POST${authHeader(withToken)} -H 'content-type: application/json' ${shellQuote(url)} -d ${shellQuote(JSON.stringify(screenBody(query)))}`;
}

/** URL when every filter has a code, otherwise a curl POST example. */
export function buildScreenLink(origin: string, query: ScreenerQuery, defs: ScreenerFilterDef[], withToken: boolean): ScreenLink {
  const url = buildScreenGetUrl(origin, query, defs);
  if (url) return { kind: "get", url, text: url };
  const blockers = nonUrlFilters(query, defs);
  return {
    kind: "post",
    url: `${origin.replace(/\/+$/, "")}/api/v1/screen`,
    text: buildCurlPost(origin, query, withToken),
    reason: `${blockers.join(", ")} ${blockers.length === 1 ? "has" : "have"} a custom range, so the screen is a POST body`,
  };
}

/** Arguments for the MCP `screen` tool: the structured ScreenerQuery (offset omitted when 0). */
export function buildMcpArgs(query: ScreenerQuery): Record<string, unknown> {
  const { offset, ...rest } = screenBody(query);
  return offset > 0 ? { ...rest, offset } : rest;
}

export function mcpArgsText(query: ScreenerQuery): string {
  return JSON.stringify(buildMcpArgs(query), null, 2);
}
