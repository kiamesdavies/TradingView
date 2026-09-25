import { beforeEach, describe, expect, test } from "bun:test";
import { createMcpServer, JSONRPC, LATEST_PROTOCOL_VERSION, MCP_MAX_BATCH, type McpServer } from "./mcp";
import { createAgentService, type AgentService } from "./service";
import { createTestBackend } from "./testkit";

let mcp: McpServer;
let svc: AgentService;
let calls: string[];

beforeEach(() => {
  const t = createTestBackend();
  calls = t.calls;
  svc = createAgentService(t.backend);
  mcp = createMcpServer(svc);
});

const req = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

async function rpc(method: string, params?: unknown): Promise<any> {
  const out = await mcp.handle(req(method, params), null);
  expect(out.status).toBe(200);
  return out.body;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const body = await rpc("tools/call", { name, arguments: args });
  expect(body.error).toBeUndefined();
  return body.result;
}

describe("protocol", () => {
  test("initialize negotiates the version and advertises tools", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "eodview" } } });
    const r2 = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(r2.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
  test("notifications and client responses → 202 without body; ping", async () => {
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, null)).toEqual({ status: 202 });
    expect(await mcp.handle({ jsonrpc: "2.0", id: 5, result: {} }, null)).toEqual({ status: 202 });
    expect((await rpc("ping")).result).toEqual({});
  });
  test("errors: unknown method, invalid request, bad protocol header, batch", async () => {
    expect((await rpc("nope/nope")).error.code).toBe(JSONRPC.METHOD_NOT_FOUND);
    const bad = await mcp.handle({ jsonrpc: "1.0", id: 1, method: "ping" }, null);
    expect((bad.body as any).error.code).toBe(JSONRPC.INVALID_REQUEST);
    const badId = await mcp.handle({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }, null);
    expect((badId.body as any).error.code).toBe(JSONRPC.INVALID_REQUEST);
    expect((await mcp.handle(req("ping"), "2030-01-01")).status).toBe(400);
    expect((await mcp.handle(req("ping"), "2025-06-18")).status).toBe(200);
    const batch = await mcp.handle([req("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/x" }, req("ping", undefined, "b")], null);
    expect((batch.body as any[]).map((r) => r.id)).toEqual([1, "b"]);
    // oversized batches are rejected whole (not silently truncated)
    const big = await mcp.handle(Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => req("ping", undefined, i)), null);
    expect(big.status).toBe(400);
    expect((big.body as any).error.message).toContain("batch too large");
    const full = await mcp.handle(Array.from({ length: MCP_MAX_BATCH }, (_, i) => req("ping", undefined, i)), null);
    expect((full.body as any[]).length).toBe(MCP_MAX_BATCH);
  });
  test("tools/list has schemas and read-only annotations", async () => {
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: any) => t.name);
    for (const n of ["screen", "list_filters", "list_markets", "symbol_overview", "get_bars", "search_symbols", "universe_status"]) expect(names).toContain(n);
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
});

describe("tools/call", () => {
  test("screen with Finviz codes against the seeded DB", async () => {
    const r = await call("screen", { filters: "cap_midover,ta_sma50_pa", sort: "-perf_3m", view: "performance", limit: 10 });
    expect(r.isError).toBe(false);
    const s = r.structuredContent;
    expect(s).toMatchObject({ market: "US", universe: "stocks", view: "performance", sort: "-perf_3m", f: "cap_midover,ta_sma50_pa", asOf: "2026-09-24" });
    expect(s.rows.map((x: any) => x.ticker)).toEqual(["MID", "AAPL"]);
    expect(s.total).toBe(2);
    expect(s.columns[0]).toBe("symbol");
    expect(JSON.parse(r.content[0].text)).toEqual(s);
  });
  test("screen with structured filters, etfs, csv", async () => {
    const r = await call("screen", { filters: [{ id: "cap", value: "largeover" }, "ta_rsi_os30"] });
    expect(r.structuredContent.rows.map((x: any) => x.ticker)).toEqual(["MSFT"]);
    const all = await call("screen", { universe: "all", sort: "ticker", format: "csv" });
    expect(all.structuredContent.csv.split("\r\n")[0]).toStartWith("symbol,ticker");
    expect(all.structuredContent.csv).toContain("SPY.US");
    expect(all.structuredContent.csv).toContain("'=Tiny Corp");
  });
  test("invalid params → JSON-RPC error; bad filter code → tool error the model can fix", async () => {
    const tooMany = await rpc("tools/call", { name: "screen", arguments: { limit: 201 } });
    expect(tooMany.error.code).toBe(JSONRPC.INVALID_PARAMS);
    expect(tooMany.error.message).toMatch(/limit/);
    const unknownArg = await rpc("tools/call", { name: "screen", arguments: { bogus: 1 } });
    expect(unknownArg.error.code).toBe(JSONRPC.INVALID_PARAMS);
    const missing = await rpc("tools/call", { name: "get_bars", arguments: {} });
    expect(missing.error.message).toMatch(/symbol/);
    const unknownTool = await rpc("tools/call", { name: "trade", arguments: {} });
    expect(unknownTool.error.code).toBe(JSONRPC.INVALID_PARAMS);
    const badCode = await call("screen", { filters: "cap_giant" });
    expect(badCode.isError).toBe(true);
    expect(badCode.content[0].text).toMatch(/unknown option/);
    const badMarket = await call("screen", { market: "MARS" });
    expect(badMarket.isError).toBe(true);
    expect(JSON.parse(badMarket.content[0].text).detail).toContain("US");
  });
  test("list_filters / list_markets / universe_status", async () => {
    const f = (await call("list_filters", { group: "technical", query: "sma50" })).structuredContent;
    expect(f.filters.length).toBe(1);
    expect(f.filters[0]).toMatchObject({ id: "ta_sma50", code: "ta_sma50" });
    expect(f.filters[0].options.map((o: any) => o.code)).toContain("ta_sma50_pa");
    const noOpts = (await call("list_filters", { include_options: false, available_only: true })).structuredContent;
    expect(noOpts.filters.every((x: any) => x.available && !x.options)).toBe(true);
    expect((await call("list_markets")).structuredContent.markets[0].code).toBe("US");
    expect((await call("universe_status", { market: "us" })).structuredContent).toMatchObject({ market: "US", asOf: "2026-09-24", symbols: 5 });
  });
  test("symbol tools", async () => {
    const b = (await call("get_bars", { symbol: "aapl", limit: 2, to: "2026-09-30" })).structuredContent;
    expect(b).toMatchObject({ symbol: "AAPL.US", market: "US", tf: "1D", asOf: "2026-09-23", count: 2 });
    expect(b.columns).toEqual(["date", "open", "high", "low", "close", "volume"]);
    expect(b.rows[0]).toEqual(["2026-09-22", 11, 12, 10, 11.5, 2000]);
    expect(calls).toContain(`bars AAPL.US 1D 2 ${Date.UTC(2026, 8, 30) / 1000}`);
    const o = (await call("symbol_overview", { symbol: "AAPL.US" })).structuredContent;
    expect(o).toMatchObject({ symbol: "AAPL.US", market: "US", profile: { name: "Apple Inc" } });
    const s = (await call("search_symbols", { query: "micro" })).structuredContent;
    expect(s).toMatchObject({ source: "local", results: [{ symbol: "MSFT.US", assetClass: "us_stock" }] });
    const exact = (await call("search_symbols", { query: "aapl" })).structuredContent;
    expect(exact.results[0].symbol).toBe("AAPL.US");
    const remote = (await call("search_symbols", { query: "eurusd" })).structuredContent;
    expect(remote).toMatchObject({ source: "remote", results: [{ symbol: "EURUSD.FOREX" }] });
    const badSym = await call("symbol_overview", { symbol: "not a symbol" });
    expect(badSym.isError).toBe(true);
  });
});

describe("REST body / params via service", () => {
  test("POST body accepts ScreenerQuery plus Finviz shorthands", async () => {
    const r = await svc.screenFromBody({ filters: [{ id: "cap", value: "midover" }], f: "ta_sma50_pa", sort: { column: "perf_3m", dir: "desc" }, limit: 5 });
    expect(r.rows.map((x) => x.ticker)).toEqual(["MID", "AAPL"]);
    expect(r).toMatchObject({ limit: 5, sort: "-perf_3m", market: "US" });
    await expect(svc.screenFromBody({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(svc.screenFromBody({ sort: { column: 1 } })).rejects.toThrow(/sort/);
  });
  test("fallback parsers (no screener-module parsers) give the same screen", async () => {
    const fb = createAgentService(createTestBackend(undefined, false).backend);
    const a = await fb.screenFromParams(new URLSearchParams("f=cap_midover,ta_sma50_pa&o=-perf13w"));
    const b = await svc.screenFromParams(new URLSearchParams("f=cap_midover,ta_sma50_pa&o=-perf13w"));
    expect(a.rows).toEqual(b.rows);
    expect(a.sort).toBe("-perf_3m");
  });
  test("GET params", async () => {
    const r = await svc.screenFromParams(new URLSearchParams("f=sh_price_o10&o=-marketcap&universe=all&limit=2"));
    expect(r.rows.map((x) => x.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(r.total).toBe(4);
  });
});
