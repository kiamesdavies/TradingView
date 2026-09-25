// Agent API: REST /api/v1/*, MCP at /mcp, OpenAPI at /api/openapi.json. Read-only; see docs/AGENT-API.md.
import { json, readJson, type Handler, type Params, type Router } from "../http";
import { agentAuth, agentCredits, agentService as svc, mcpServer } from "../agentapi/runtime";
import { toCsv } from "../agentapi/csv";
import { AgentError, badRequest, errorResponse } from "../agentapi/errors";
import { buildOpenApi } from "../agentapi/openapi";
import { SCREEN_MAX_LIMIT } from "../agentapi/finviz";
import { JSONRPC, MCP_MAX_BATCH } from "../agentapi/mcp";
import type { Principal } from "../agentapi/auth";
import { isProxied } from "../config/guard";

const MAX_MCP_BODY = 1_000_000;

type AgentHandler = (req: Request, p: Params, url: URL, principal: Principal) => Promise<Response> | Response;

function authed(h: AgentHandler): Handler {
  return async (req, p, url, server) => {
    try {
      const principal = agentAuth.authenticate({
        ip: server.requestIP(req)?.address,
        host: req.headers.get("host"),
        authorization: req.headers.get("authorization"),
        proxied: isProxied(req.headers),
      });
      // Upstream EODHD calls made while serving the request are charged to the agent credit budget.
      const r = await agentCredits.run(() => h(req, p, url, principal));
      r.headers.set("cache-control", "no-store");
      return r;
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function int(raw: string | null, name: string, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) badRequest(`${name} must be an integer ${min}..${max}`);
  return n;
}

function bool(raw: string | null, def: boolean): boolean {
  if (raw === null || raw === "") return def;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  badRequest("boolean parameters take 1/0 or true/false");
}

function screenResponse(res: Awaited<ReturnType<typeof svc.screen>>, url: URL): Response {
  const fmt = (url.searchParams.get("fmt") ?? "json").toLowerCase();
  if (fmt === "csv") {
    return new Response(toCsv(res.columns, res.rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `inline; filename="screen-${res.market.toLowerCase()}-${res.asOf ?? "latest"}.csv"`,
        "x-total-count": String(res.total),
        ...(res.asOf ? { "x-as-of": res.asOf } : {}),
      },
    });
  }
  if (fmt !== "json") badRequest("fmt must be json or csv");
  return json(res);
}

export function register(router: Router): void {
  router.get("/api/openapi.json", (req, _p, url) => json(buildOpenApi(`${url.protocol}//${req.headers.get("host") ?? url.host}`)));

  router.get("/api/v1/screen", authed(async (_req, _p, url) => screenResponse(await svc.screenFromParams(url.searchParams, SCREEN_MAX_LIMIT), url)));

  router.post("/api/v1/screen", authed(async (req, _p, url) => {
    const body = await readJson<Record<string, unknown> | null>(req);
    if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest("body must be a ScreenerQuery object");
    return screenResponse(await svc.screenFromBody(body, SCREEN_MAX_LIMIT), url);
  }));

  router.get("/api/v1/filters", authed(async (_req, _p, url) => {
    const market = svc.checkMarket(url.searchParams.get("market"));
    const m = await svc.meta(market);
    return json({ ...m, asOf: m.universe?.lastPriceDate ?? null });
  }));

  router.get("/api/v1/markets", authed(() => json(svc.markets())));

  router.get("/api/v1/universe/status", authed((_req, _p, url) => json(svc.status(url.searchParams.get("market")))));

  router.get("/api/v1/search", authed(async (_req, _p, url) => {
    const source = (url.searchParams.get("source") ?? "auto").toLowerCase();
    if (source !== "auto" && source !== "local" && source !== "remote") badRequest("source must be auto, local or remote");
    return json(await svc.search(url.searchParams.get("q"), int(url.searchParams.get("limit"), "limit", 10, 1, 50), source));
  }));

  router.get("/api/v1/symbols/:symbol/overview", authed(async (_req, p) => json(await svc.overview(p.symbol))));

  router.get("/api/v1/symbols/:symbol/bars", authed(async (_req, p, url) => {
    const sp = url.searchParams;
    return json(await svc.bars(p.symbol, {
      tf: sp.get("tf") ?? undefined,
      limit: int(sp.get("limit"), "limit", 500, 1, 5000),
      to: sp.get("to") ?? undefined,
      adjusted: bool(sp.get("adj"), true),
      compact: bool(sp.get("compact"), false),
    }));
  }));

  router.get("/api/v1/symbols/:symbol/news", authed(async (_req, p, url) =>
    json(await svc.news(p.symbol, int(url.searchParams.get("limit"), "limit", 20, 1, 50)))));

  router.get("/api/v1/symbols/:symbol/events", authed(async (_req, p, url) =>
    json(await svc.events(p.symbol, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined))));

  // ---- MCP (streamable HTTP, stateless, JSON responses)
  router.post("/mcp", authed(async (req, _p, _u, principal) => {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new AgentError(415, "content-type must be application/json");
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > MAX_MCP_BODY) throw new AgentError(413, "request body too large");
    const text = await req.text();
    if (text.length > MAX_MCP_BODY) throw new AgentError(413, "request body too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: JSONRPC.PARSE, message: "Parse error" } }, 400);
    }
    // Every message of a batch counts against the rate limit (the request itself was counted by authed()).
    if (Array.isArray(body) && body.length > 1) agentAuth.charge(principal, Math.min(body.length, MCP_MAX_BATCH) - 1);
    const out = await mcpServer.handle(body, req.headers.get("mcp-protocol-version"));
    return out.body === undefined ? new Response(null, { status: out.status }) : json(out.body, out.status);
  }));

  const notAllowed = authed(() => {
    const r = json({ error: "method not allowed", detail: "this MCP server is stateless and answers POST only (no SSE stream)" }, 405);
    r.headers.set("allow", "POST");
    return r;
  });
  router.get("/mcp", notAllowed);
  router.delete("/mcp", notAllowed);
}
