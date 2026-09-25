import { describe, expect, test } from "bun:test";
import type { ScreenerFilterDef, ScreenerQuery } from "@eodview/shared";
import {
  buildCurlPost, buildMcpArgs, buildScreenGetUrl, buildScreenLink, claudeMcpAddCommand, filterCode, isLoopbackHost, mcpUrl,
  nonUrlFilters, serverOrigin, shellQuote,
} from "./apiLinks";

const defs: ScreenerFilterDef[] = [
  { id: "cap", code: "cap", label: "Market Cap.", group: "descriptive", options: [{ value: "midover", label: "+Mid (over $2bln)" }], custom: { unit: "money" }, appliesTo: "stock", available: true },
  { id: "sma50", code: "ta_sma50", label: "50-Day SMA", group: "technical", options: [{ value: "pa", label: "Price above SMA50" }], appliesTo: "all", available: true },
  { id: "nocode", label: "No Code", group: "technical", options: [{ value: "x", label: "X" }], appliesTo: "all", available: true },
];
const q = (patch: Partial<ScreenerQuery> = {}): ScreenerQuery => ({
  filters: [{ id: "cap", value: "midover" }, { id: "sma50", value: "pa" }],
  market: "US",
  universe: "stocks",
  view: "overview",
  sort: { column: "perf_3m", dir: "desc" },
  offset: 0,
  limit: 50,
  ...patch,
});
const O = "http://localhost:3001";

describe("filter codes + GET url", () => {
  test("option codes are `${code}_${value}`", () => {
    expect(filterCode(defs[0], { id: "cap", value: "midover" })).toBe("cap_midover");
    expect(filterCode(defs[0], { id: "cap", min: 1e9 })).toBeNull();
    expect(filterCode(defs[2], { id: "nocode", value: "x" })).toBeNull();
    expect(filterCode(undefined, { id: "zz", value: "x" })).toBeNull();
  });
  test("contract example URL", () => {
    expect(buildScreenGetUrl(O, q(), defs)).toBe(`${O}/api/v1/screen?f=cap_midover,ta_sma50_pa&market=US&o=-perf_3m&v=overview&limit=50`);
  });
  test("asc sort, no filters, market, universe, tickers, offset", () => {
    const url = buildScreenGetUrl(O + "/", q({ filters: [], market: "ST", universe: "etfs", tickers: "VOLV-B, ERIC-B", sort: { column: "ticker", dir: "asc" }, offset: 100, limit: 20 }), defs);
    expect(url).toBe(`${O}/api/v1/screen?market=ST&universe=etfs&t=VOLV-B,ERIC-B&o=ticker&v=overview&limit=20&offset=100`);
  });
  test("custom ranges / missing codes need a POST", () => {
    const custom = q({ filters: [{ id: "cap", min: 2e9 }, { id: "sma50", value: "pa" }] });
    expect(buildScreenGetUrl(O, custom, defs)).toBeNull();
    expect(nonUrlFilters(custom, defs)).toEqual(["Market Cap."]);
    expect(buildScreenGetUrl(O, q({ filters: [{ id: "nocode", value: "x" }] }), defs)).toBeNull();
  });
});

describe("screen link / curl / MCP", () => {
  test("GET link when every filter has a code", () => {
    const l = buildScreenLink(O, q(), defs, false);
    expect(l.kind).toBe("get");
    expect(l.text).toBe(l.url);
  });
  test("POST curl with JSON body and optional token", () => {
    const custom = q({ filters: [{ id: "cap", min: 2e9 }], tickers: "O'NEIL" });
    const l = buildScreenLink(O, custom, defs, true);
    expect(l.kind).toBe("post");
    expect(l.reason).toContain("Market Cap. has a custom range");
    expect(l.text).toContain(`-H "Authorization: Bearer $EODVIEW_API_TOKEN"`);
    expect(l.text).toContain(`'${O}/api/v1/screen'`);
    const noAuth = buildCurlPost(O, custom, false);
    expect(noAuth).not.toContain("Authorization");
    // body round-trips through the shell quoting
    const m = /-d '(.*)'$/s.exec(noAuth);
    expect(m).not.toBeNull();
    const body = JSON.parse(m![1].replace(/'\\''/g, "'"));
    expect(body).toEqual({ filters: [{ id: "cap", min: 2e9 }], market: "US", universe: "stocks", tickers: "O'NEIL", view: "overview", sort: { column: "perf_3m", dir: "desc" }, offset: 0, limit: 50 });
  });
  test("shellQuote", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
  test("MCP args are the structured query without a zero offset", () => {
    expect(buildMcpArgs(q())).toEqual({ filters: q().filters, market: "US", universe: "stocks", view: "overview", sort: { column: "perf_3m", dir: "desc" }, limit: 50 });
    expect(buildMcpArgs(q({ offset: 50 })).offset).toBe(50);
  });
});

describe("server origin / MCP", () => {
  test("vite dev port maps to the server port", () => {
    expect(serverOrigin({ protocol: "http:", hostname: "localhost", port: "5173" }, 3001)).toBe("http://localhost:3001");
    expect(serverOrigin({ protocol: "http:", hostname: "localhost", port: "5173" }, 4000)).toBe("http://localhost:4000");
    expect(serverOrigin({ protocol: "http:", hostname: "localhost", port: "5173" })).toBe("http://localhost:3001");
    expect(serverOrigin({ protocol: "https:", hostname: "eod.example.com", port: "" }, 3001)).toBe("https://eod.example.com");
    expect(serverOrigin({ protocol: "http:", hostname: "::1", port: "3001" })).toBe("http://[::1]:3001");
  });
  test("mcp url + claude command", () => {
    expect(mcpUrl("http://localhost:3001/")).toBe("http://localhost:3001/mcp");
    expect(claudeMcpAddCommand("http://localhost:3001/mcp", false)).toBe("claude mcp add --transport http eodview http://localhost:3001/mcp");
    expect(claudeMcpAddCommand("https://h/mcp", true)).toBe(`claude mcp add --transport http eodview https://h/mcp --header "Authorization: Bearer <token>"`);
  });
  test("loopback detection", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["192.168.1.2", "eod.example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});
