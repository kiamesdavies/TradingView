// Universe pipeline endpoints. Mutations are guarded like /api/config (localhost or EODVIEW_ADMIN_TOKEN).
//   GET  /api/universe/status                 -> UniverseStatus (+ markets: per-market detail)
//   POST /api/universe/jobs/:name/run         -> { ok: true }   name = "prices" (all enabled markets) or "prices:ST"
//   GET  /api/universe/markets                -> { markets: MarketInfo[], setting }
//   PUT  /api/universe/markets {markets: []}  -> { markets: MarketInfo[], setting }  (ignored while EODVIEW_MARKETS is set)
//   GET  /api/universe/coverage?market=ST     -> Record<column, fraction non-null>
import { error, json, readJson, type Handler, type Router } from "../http";
import { assertConfigAccess, isProxied } from "../config/guard";
import { config } from "../config/config";
import {
  isJobName,
  JOB_NAMES,
  listMarkets,
  marketCoverage,
  marketsSetting,
  runJob,
  setEnabledMarkets,
  universeStatus,
} from "../universe/scheduler";
import { getMarket } from "../universe/markets";

function guard(req: Request, server: Parameters<Handler>[3]): void {
  assertConfigAccess({
    adminToken: process.env.EODVIEW_ADMIN_TOKEN || undefined,
    authorization: req.headers.get("authorization"),
    ip: server.requestIP(req)?.address,
    host: req.headers.get("host"),
    proxied: isProxied(req.headers),
  });
}

export function register(router: Router): void {
  router.get("/api/universe/status", () => json(universeStatus()));

  router.post("/api/universe/jobs/:name/run", async (req, params, _u, server) => {
    guard(req, server);
    if (!isJobName(params.name)) {
      return error(404, `unknown job "${params.name}"`, `expected one of ${JOB_NAMES.join(", ")}, optionally ":<enabled market>" (e.g. prices:ST)`);
    }
    if (!config.getKey()) return error(503, "EODHD API key not configured");
    await runJob(params.name);
    return json({ ok: true });
  });

  router.get("/api/universe/markets", () => json({ markets: listMarkets(), setting: marketsSetting() }));

  router.put("/api/universe/markets", async (req, _p, _u, server) => {
    guard(req, server);
    const body = await readJson<{ markets?: unknown }>(req);
    if (!Array.isArray(body?.markets) || !body.markets.every((m) => typeof m === "string")) {
      return error(400, "body must be {\"markets\": [\"US\", \"ST\", ...]}");
    }
    const unknown = (body.markets as string[]).filter((m) => !getMarket(m));
    if (unknown.length) return error(400, `unknown market(s): ${unknown.join(", ")}`);
    const setting = setEnabledMarkets(body.markets as string[]);
    return json({ markets: listMarkets(), setting });
  });

  router.get("/api/universe/coverage", (_req, _p, url) => {
    const market = (url.searchParams.get("market") ?? "US").toUpperCase();
    if (market !== "ALL" && !getMarket(market)) return error(400, `unknown market "${market}"`);
    return json(marketCoverage(market));
  });
}
