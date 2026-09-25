// Model Context Protocol server over the streamable HTTP transport, stateless, JSON responses only (no SSE).
// JSON-RPC 2.0: initialize, ping, tools/list, tools/call; notifications are accepted (202, no body).
import type { ScreenerQuery } from "@eodview/shared";
import { HttpError } from "../http";
import { toCsv } from "./csv";
import { AgentError } from "./errors";
import { normalizeMarket, parseUniverse, parseView } from "./finviz";
import { validate, type JsonSchema } from "./schema";
import type { AgentService } from "./service";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_MAX_SCREEN_LIMIT = 200;
export const MCP_MAX_BARS = 1000;
/** Messages per JSON-RPC batch; larger batches are rejected (every message counts against the rate limit). */
export const MCP_MAX_BATCH = 50;

export const JSONRPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

type Id = string | number;
interface RpcError { code: number; message: string; data?: unknown }
export type RpcResponse = { jsonrpc: "2.0"; id: Id | null; result: unknown } | { jsonrpc: "2.0"; id: Id | null; error: RpcError };

class RpcFail extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: { readOnlyHint: true; openWorldHint: boolean; idempotentHint?: boolean };
  run(args: Record<string, unknown>): Promise<unknown>;
}

const MARKET: JsonSchema = {
  type: "string", maxLength: 12,
  description: 'Market (EODHD exchange code) from list_markets, e.g. "US", "LSE", "XETRA", or "ALL". Default "US".',
};
const SYMBOL: JsonSchema = {
  type: "string", minLength: 1, maxLength: 40,
  description: 'Symbol as TICKER.EXCHANGE, e.g. "AAPL.US", "VOD.LSE", "BTC-USD.CC". A bare ticker means .US.',
};
const GROUPS = ["descriptive", "fundamental", "technical", "news", "etf"] as const;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function createTools(svc: AgentService): ToolDef[] {
  return [
    {
      name: "screen",
      title: "Stock screener",
      description:
        "Run the Finviz-style stock/ETF screener over EODView's local end-of-day universe (no live data; asOf = last close). " +
        "Filters use Finviz URL codes, comma separated, e.g. momentum: \"cap_midover,sh_avgvol_o500,ta_sma50_pa,ta_sma200_pa,ta_perf_13wup\", " +
        "oversold large caps: \"cap_largeover,ta_rsi_os30\". Custom ranges: \"<code>_<min>to<max>\" in raw units (e.g. sh_price_10to50). " +
        "Multiple values of one filter are OR-ed with \"|\" (e.g. sec_technology|healthcare). Call list_filters to discover codes. " +
        "Returns total matches plus rows with the columns of the chosen view.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          filters: {
            description: "Finviz codes string (\"cap_midover,ta_sma50_pa\") or a list of codes / {id, value} / {id, min, max} objects.",
            oneOf: [
              { type: "string", maxLength: 4000 },
              {
                type: "array", maxItems: 100,
                items: {
                  oneOf: [
                    { type: "string", maxLength: 200 },
                    {
                      type: "object", additionalProperties: false,
                      properties: {
                        code: { type: "string", description: "Full Finviz code, e.g. fa_pe_u20" },
                        id: { type: "string", description: "Filter id/code prefix, e.g. fa_pe" },
                        value: { type: "string", description: "Option value, e.g. u20" },
                        min: { oneOf: [{ type: "number" }, { type: "string" }] },
                        max: { oneOf: [{ type: "number" }, { type: "string" }] },
                      },
                    },
                  ],
                },
              },
            ],
          },
          market: MARKET,
          universe: { type: "string", enum: ["stocks", "etfs", "all"], description: "Default stocks (etfs when an etf_* filter is used)." },
          tickers: { type: "string", maxLength: 10_000, description: "Optional restriction to these tickers, e.g. \"AAPL, MSFT\"." },
          sort: { type: "string", maxLength: 40, description: "Column id, \"-\" prefix = descending, e.g. \"-perf_3m\", \"-rel_volume\", \"market_cap\". Default ticker." },
          view: { type: "string", maxLength: 20, description: "overview (default), valuation, financial, ownership, performance, technical, etf." },
          limit: { type: "integer", minimum: 1, maximum: MCP_MAX_SCREEN_LIMIT, description: `Rows to return (default 25, max ${MCP_MAX_SCREEN_LIMIT}).` },
          offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
          format: { type: "string", enum: ["json", "csv"], description: "Row encoding in the text result; csv is more compact. Default json." },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
      async run(a) {
        const market = svc.checkMarket(str(a.market));
        const m = await svc.meta(market);
        const filters = await svc.resolveFilters(market, a.filters);
        const q: ScreenerQuery = {
          filters, market,
          universe: parseUniverse(str(a.universe), filters),
          ...(str(a.tickers)?.trim() ? { tickers: str(a.tickers)!.trim() } : {}),
          view: parseView(str(a.view), m.views),
          sort: svc.parseSort(str(a.sort), m.columns),
          offset: typeof a.offset === "number" ? a.offset : 0,
          limit: typeof a.limit === "number" ? a.limit : 25,
        };
        const res = await svc.screen(q);
        if (a.format === "csv") {
          const { rows, ...rest } = res;
          return { ...rest, csv: toCsv(res.columns, rows) };
        }
        return res;
      },
    },
    {
      name: "list_filters",
      title: "List screener filters",
      description:
        "List the screener's filters with their Finviz codes and option codes (use the option codes in screen.filters). " +
        "Filters with available=false cannot be used in that market (reason given). Narrow with group or query to keep the output small.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          market: MARKET,
          group: { type: "string", enum: GROUPS, description: "Only filters of this group." },
          query: { type: "string", maxLength: 60, description: "Substring of the label or code, e.g. \"sma\", \"volume\", \"earnings\"." },
          available_only: { type: "boolean", description: "Hide unavailable filters (default false)." },
          include_options: { type: "boolean", description: "Include option codes (default true)." },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
      run: async (a) => svc.compactFilters(svc.checkMarket(str(a.market)), {
        group: str(a.group), query: str(a.query), availableOnly: a.available_only === true, options: a.include_options !== false,
      }),
    },
    {
      name: "list_markets",
      title: "List markets",
      description: "Markets (exchanges) the local universe tracks, with symbol counts, currency, time zone and last price date.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
      run: async () => svc.markets(),
    },
    {
      name: "symbol_overview",
      title: "Symbol overview",
      description:
        "Company profile, latest quote with pre/post-market, key stats (market cap, P/E, float, short %, next earnings…), " +
        "EPS history vs estimates, analyst consensus and the latest news headline for one symbol.",
      inputSchema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: SYMBOL } },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => svc.overview(a.symbol),
    },
    {
      name: "get_bars",
      title: "Price bars",
      description:
        "OHLCV bars for a symbol, ascending, as compact rows [date, open, high, low, close, volume]. " +
        "Daily/weekly/monthly bars are split/dividend adjusted unless adjusted=false.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["symbol"],
        properties: {
          symbol: SYMBOL,
          tf: { type: "string", enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"], description: "Timeframe, default 1D." },
          limit: { type: "integer", minimum: 1, maximum: MCP_MAX_BARS, description: `Number of bars (default 200, max ${MCP_MAX_BARS}).` },
          to: { oneOf: [{ type: "string", maxLength: 30 }, { type: "integer" }], description: "Bars strictly before this date (YYYY-MM-DD or unix seconds); default latest." },
          adjusted: { type: "boolean", description: "Adjusted daily+ bars (default true)." },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => svc.bars(a.symbol, {
        tf: a.tf, limit: typeof a.limit === "number" ? a.limit : 200, to: a.to,
        adjusted: a.adjusted !== false, compact: true,
      }),
    },
    {
      name: "symbol_news",
      title: "Symbol news",
      description: "Recent news articles for a symbol (title, source, url, time, sentiment), newest first.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["symbol"],
        properties: { symbol: SYMBOL, limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." } },
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => svc.news(a.symbol, typeof a.limit === "number" ? a.limit : 10),
    },
    {
      name: "search_symbols",
      title: "Search symbols",
      description:
        "Find symbols by ticker or company name. Searches the local universe first (free); falls back to the EODHD search API " +
        "when nothing matches (source=auto) or always with source=remote (covers forex, crypto, indices, all exchanges).",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 64 },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10." },
          source: { type: "string", enum: ["auto", "local", "remote"] },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => svc.search(a.query, typeof a.limit === "number" ? a.limit : 10, (str(a.source) ?? "auto") as "auto" | "local" | "remote"),
    },
    {
      name: "universe_status",
      title: "Universe status",
      description:
        "State of the local data universe behind the screener: symbols tracked, with prices/fundamentals, last price date, " +
        "history depth, EODHD credits used today vs budget, and pipeline job states. Check asOf before trusting screen results.",
      inputSchema: { type: "object", additionalProperties: false, properties: { market: MARKET } },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
      run: async (a) => svc.status(str(a.market) ? normalizeMarket(str(a.market)) : null),
    },
  ];
}

export interface McpOpts { name?: string; version?: string }

const INSTRUCTIONS =
  "EODView exposes a Finviz-style screener over a local end-of-day universe plus per-symbol data. " +
  "Typical flow: list_markets → list_filters (find codes) → screen (codes like cap_midover,ta_sma50_pa, sort -perf_3m) → " +
  "symbol_overview / get_bars / symbol_news for candidates. Screen data is as of the last close (see asOf). All tools are read-only.";

export function createMcpServer(svc: AgentService, opts: McpOpts = {}) {
  const tools = createTools(svc);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const serverInfo = { name: opts.name ?? "eodview", title: "EODView market data", version: opts.version ?? "3.0.0" };

  async function callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    if (typeof name !== "string") throw new RpcFail(JSONRPC.INVALID_PARAMS, "params.name must be a string");
    const tool = byName.get(name);
    if (!tool) throw new RpcFail(JSONRPC.INVALID_PARAMS, `Unknown tool: ${name.slice(0, 60)}`);
    const args = params.arguments ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new RpcFail(JSONRPC.INVALID_PARAMS, "params.arguments must be an object");
    const err = validate(args, tool.inputSchema);
    if (err) throw new RpcFail(JSONRPC.INVALID_PARAMS, `Invalid arguments for ${name}: ${err}`);
    try {
      const out = await tool.run(args as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
        isError: false,
      };
    } catch (e) {
      // Tool execution errors go back to the model (so it can fix e.g. a filter code), not as JSON-RPC errors.
      const status = e instanceof HttpError ? e.status : (e as { status?: number })?.status;
      const detail = e instanceof AgentError ? e.detail : undefined;
      const message = (e as Error)?.message ?? String(e);
      if (!(e instanceof HttpError)) console.error(`[mcp] tool ${name} failed`, e);
      const payload = { error: message, ...(detail ? { detail } : {}), ...(typeof status === "number" ? { status } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested : LATEST_PROTOCOL_VERSION;
        return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions: INSTRUCTIONS };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        };
      case "tools/call":
        return callTool(params);
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw new RpcFail(JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 60)}`);
    }
  }

  /** One JSON-RPC message → a response, or null for notifications / client responses. */
  async function handleMessage(msg: unknown): Promise<RpcResponse | null> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      return { jsonrpc: "2.0", id: null, error: { code: JSONRPC.INVALID_REQUEST, message: "Invalid Request" } };
    }
    const m = msg as Record<string, unknown>;
    const hasId = "id" in m && m.id !== undefined;
    const idOk = typeof m.id === "string" || (typeof m.id === "number" && Number.isFinite(m.id));
    if (m.jsonrpc !== "2.0") return hasId ? { jsonrpc: "2.0", id: idOk ? (m.id as Id) : null, error: { code: JSONRPC.INVALID_REQUEST, message: 'jsonrpc must be "2.0"' } } : null;
    if (typeof m.method !== "string") {
      if ("result" in m || "error" in m) return null; // a response from the client (we never send requests)
      return { jsonrpc: "2.0", id: idOk ? (m.id as Id) : null, error: { code: JSONRPC.INVALID_REQUEST, message: "method must be a string" } };
    }
    if (!hasId) return null; // notification (notifications/initialized, notifications/cancelled, …)
    if (!idOk) return { jsonrpc: "2.0", id: null, error: { code: JSONRPC.INVALID_REQUEST, message: "id must be a string or number" } };
    const id = m.id as Id;
    const params = m.params ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return { jsonrpc: "2.0", id, error: { code: JSONRPC.INVALID_PARAMS, message: "params must be an object" } };
    }
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(m.method, params as Record<string, unknown>) };
    } catch (e) {
      if (e instanceof RpcFail) return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      console.error("[mcp]", e);
      return { jsonrpc: "2.0", id, error: { code: JSONRPC.INTERNAL, message: (e as Error)?.message ?? "Internal error" } };
    }
  }

  return {
    tools,

    /**
     * Handle a parsed POST body. Returns HTTP status + JSON body (undefined → 202 Accepted with no body).
     * `protocolVersion` is the MCP-Protocol-Version header (absent → assume 2025-03-26 per spec).
     */
    async handle(body: unknown, protocolVersion: string | null): Promise<{ status: number; body?: unknown }> {
      if (protocolVersion && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
        return {
          status: 400,
          body: { jsonrpc: "2.0", id: null, error: { code: JSONRPC.INVALID_REQUEST, message: `Unsupported MCP-Protocol-Version: ${protocolVersion.slice(0, 20)}` } },
        };
      }
      if (Array.isArray(body)) {
        if (!body.length) return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: JSONRPC.INVALID_REQUEST, message: "empty batch" } } };
        if (body.length > MCP_MAX_BATCH) {
          return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: JSONRPC.INVALID_REQUEST, message: `batch too large (at most ${MCP_MAX_BATCH} messages)` } } };
        }
        const out = (await Promise.all(body.map(handleMessage))).filter((r): r is RpcResponse => r !== null);
        return out.length ? { status: 200, body: out } : { status: 202 };
      }
      const r = await handleMessage(body);
      return r ? { status: 200, body: r } : { status: 202 };
    },
  };
}
export type McpServer = ReturnType<typeof createMcpServer>;
