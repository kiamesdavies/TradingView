// OpenAPI 3.1 description of /api/v1 (hand-written).
const ERR = { $ref: "#/components/responses/Error" };
const SYMBOL_PARAM = {
  name: "symbol", in: "path", required: true, schema: { type: "string" },
  description: "TICKER.EXCHANGE, e.g. AAPL.US (a bare ticker means .US)", example: "AAPL.US",
};
const MARKET_PARAM = { name: "market", in: "query", schema: { type: "string", default: "US" }, description: 'Market code from /api/v1/markets or "ALL"' };
const errs = { "400": ERR, "401": ERR, "429": ERR, "502": ERR, "503": ERR };
const obj = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });

export function buildOpenApi(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "EODView Agent API",
      version: "1.0.0",
      description:
        "Read-only market data and a Finviz-style screener over a local end-of-day universe. Loopback callers need no token; " +
        "others send `Authorization: Bearer <token>`. MCP clients use POST /mcp instead. See docs/AGENT-API.md.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }, {}],
    paths: {
      "/api/v1/screen": {
        get: {
          operationId: "screen",
          summary: "Run the screener with Finviz URL-style parameters",
          parameters: [
            { name: "f", in: "query", schema: { type: "string" }, example: "cap_midover,sh_avgvol_o500,ta_sma50_pa,ta_sma200_pa", description: "Comma separated filter codes `<code>_<option>`; `<code>_<min>to<max>` for custom ranges; `a|b` for either option" },
            { name: "o", in: "query", schema: { type: "string" }, example: "-perf_3m", description: "Sort column, `-` prefix = descending" },
            { name: "v", in: "query", schema: { type: "string", default: "overview" }, description: "View id (overview, valuation, financial, ownership, performance, technical, etf) or Finviz number (111, 121, 161, 131, 141, 171)" },
            MARKET_PARAM,
            { name: "universe", in: "query", schema: { type: "string", enum: ["stocks", "etfs", "all"] } },
            { name: "tickers", in: "query", schema: { type: "string" }, description: "Restrict to these tickers (alias `t`)" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 50 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "fmt", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" } },
          ],
          responses: {
            "200": {
              description: "Screen result",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScreenResult" } }, "text/csv": { schema: { type: "string" } } },
            },
            ...errs,
          },
        },
        post: {
          operationId: "screenPost",
          summary: "Run the screener with a ScreenerQuery body",
          parameters: [{ name: "fmt", in: "query", schema: { type: "string", enum: ["json", "csv"] } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ScreenerQuery" } } } },
          responses: { "200": { description: "Screen result", content: { "application/json": { schema: { $ref: "#/components/schemas/ScreenResult" } } } }, ...errs },
        },
      },
      "/api/v1/filters": {
        get: {
          operationId: "filters", summary: "Filter registry (with Finviz codes and per-market availability), columns and views",
          parameters: [MARKET_PARAM], responses: { "200": obj("ScreenerMeta + asOf"), ...errs },
        },
      },
      "/api/v1/markets": { get: { operationId: "markets", summary: "Tracked markets", responses: { "200": obj("{asOf, markets: MarketInfo[]}"), ...errs } } },
      "/api/v1/universe/status": {
        get: { operationId: "universeStatus", summary: "Universe pipeline status", parameters: [MARKET_PARAM], responses: { "200": obj("UniverseStatus + market, asOf"), ...errs } },
      },
      "/api/v1/search": {
        get: {
          operationId: "search", summary: "Symbol search (local universe first, EODHD fallback)",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
            { name: "source", in: "query", schema: { type: "string", enum: ["auto", "local", "remote"], default: "auto" } },
          ],
          responses: { "200": obj("{q, source, asOf, count, results: SymbolInfo[]}"), ...errs },
        },
      },
      "/api/v1/symbols/{symbol}/overview": {
        get: { operationId: "overview", summary: "Profile, quote, key stats, earnings, analyst consensus", parameters: [SYMBOL_PARAM], responses: { "200": obj("SymbolOverview + symbol, market, asOf"), ...errs } },
      },
      "/api/v1/symbols/{symbol}/bars": {
        get: {
          operationId: "bars", summary: "OHLCV bars, ascending",
          parameters: [
            SYMBOL_PARAM,
            { name: "tf", in: "query", schema: { type: "string", enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"], default: "1D" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000, default: 500 } },
            { name: "to", in: "query", schema: { type: "string" }, description: "Bars strictly before this (unix seconds or YYYY-MM-DD)" },
            { name: "adj", in: "query", schema: { type: "string", enum: ["0", "1"], default: "1" } },
            { name: "compact", in: "query", schema: { type: "string", enum: ["0", "1"], default: "0" }, description: "1 → columns + rows [date, o, h, l, c, v]" },
          ],
          responses: { "200": obj("{symbol, market, tf, adjusted, asOf, count, hasMore, bars | columns+rows}"), ...errs },
        },
      },
      "/api/v1/symbols/{symbol}/news": {
        get: {
          operationId: "news", summary: "Recent news",
          parameters: [SYMBOL_PARAM, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
          responses: { "200": obj("{symbol, market, asOf, count, news: NewsItem[]}"), ...errs },
        },
      },
      "/api/v1/symbols/{symbol}/events": {
        get: {
          operationId: "events", summary: "Earnings, dividends and splits",
          parameters: [
            SYMBOL_PARAM,
            { name: "from", in: "query", schema: { type: "string" } },
            { name: "to", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": obj("{symbol, market, asOf, count, events: ChartEvent[]}"), ...errs },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      responses: {
        Error: {
          description: "Error",
          content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { type: "string" }, detail: { type: "string" } } } } },
        },
      },
      schemas: {
        ScreenerQuery: {
          type: "object",
          properties: {
            filters: {
              type: "array",
              items: {
                oneOf: [
                  { type: "string", description: "Finviz code, e.g. fa_pe_u20" },
                  { type: "object", required: ["id", "value"], properties: { id: { type: "string" }, value: { type: "string" } } },
                  { type: "object", required: ["id"], properties: { id: { type: "string" }, min: { type: ["number", "string"] }, max: { type: ["number", "string"] } } },
                ],
              },
            },
            f: { type: "string", description: "Finviz codes (alternative to filters)" },
            market: { type: "string", default: "US" },
            universe: { type: "string", enum: ["stocks", "etfs", "all"] },
            tickers: { type: "string" },
            view: { type: "string", default: "overview" },
            sort: {
              oneOf: [
                { type: "string", example: "-perf_3m" },
                { type: "object", properties: { column: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } } },
              ],
            },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
        },
        ScreenResult: {
          type: "object",
          properties: {
            market: { type: "string" }, universe: { type: "string" }, view: { type: "string" },
            f: { type: "string", description: "Applied filters as Finviz codes" }, sort: { type: "string" },
            total: { type: "integer" }, offset: { type: "integer" }, limit: { type: "integer" }, count: { type: "integer" },
            columns: { type: "array", items: { type: "string" } },
            rows: { type: "array", items: { type: "object", additionalProperties: { type: ["number", "string", "null"] } } },
            asOf: { type: ["string", "null"], description: "Last price date of the universe" },
          },
        },
      },
    },
  };
}
