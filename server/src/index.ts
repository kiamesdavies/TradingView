import { join } from "node:path";
import { existsSync } from "node:fs";
import { Router, error } from "./http";
import { config } from "./config/config";
import * as marketRoutes from "./routes/market";
import * as configRoutes from "./routes/config";
import * as storeRoutes from "./routes/store";
import * as alertRoutes from "./routes/alerts";
import * as detailsRoutes from "./routes/details";
import * as screenerRoutes from "./routes/screener";
import * as universeRoutes from "./routes/universe";
import * as agentRoutes from "./routes/agent";
import * as tokenRoutes from "./routes/tokens";
import { startUniverseScheduler } from "./universe/scheduler";
import { hub } from "./realtime/hub";
import { startAlertEngine } from "./alerts/engine";
import { isAllowedOrigin, needsOriginCheck, originInputFrom, parseAllowedOrigins } from "./origin";

const router = new Router();
marketRoutes.register(router);
configRoutes.register(router);
storeRoutes.register(router);
alertRoutes.register(router);
detailsRoutes.register(router);
screenerRoutes.register(router);
universeRoutes.register(router);
agentRoutes.register(router);
tokenRoutes.register(router);
startAlertEngine();
if (process.env.EODVIEW_UNIVERSE !== "off") startUniverseScheduler();

/** Extra browser origins allowed to open /ws and send state-changing /api requests. */
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.EODVIEW_ALLOWED_ORIGINS);

const DIST = join(import.meta.dir, "..", "..", "client", "dist");
const serveStatic = existsSync(DIST);

const server = Bun.serve<{ id: string }>({
  port: config.port,
  idleTimeout: 60, // cold details/news fetches can exceed Bun's 10s default
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // Browsers don't apply CORS to websockets: without this any page could read the feed and alert events.
      if (!isAllowedOrigin(originInputFrom(req, ALLOWED_ORIGINS))) return error(403, "origin not allowed");
      if (server.upgrade(req, { data: { id: crypto.randomUUID() } })) return undefined;
      return error(400, "websocket upgrade failed");
    }
    if ((url.pathname.startsWith("/api/") || url.pathname === "/mcp")) {
      // Blocks cross-site "simple" POSTs (no preflight) that would otherwise create alerts/watchlists.
      if (needsOriginCheck(req.method) && !isAllowedOrigin(originInputFrom(req, ALLOWED_ORIGINS))) {
        return error(403, "origin not allowed");
      }
      return (await router.handle(req, server)) ?? error(404, "not found");
    }
    if (serveStatic) {
      const file = Bun.file(join(DIST, url.pathname === "/" ? "index.html" : url.pathname));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(DIST, "index.html")));
    }
    return error(404, "not found (run `bun run build` or use the Vite dev server on :5173)");
  },
  websocket: hub.websocket,
});

console.log(`[eodview] server on http://localhost:${server.port} (key: ${config.getKey() ? "set" : "missing"})`);
