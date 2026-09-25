// /api/tokens — agent API token management, guarded like /api/config (loopback or EODVIEW_ADMIN_TOKEN).
import { json, readJson, error, type Handler, type Router } from "../http";
import { assertConfigAccess, isProxied } from "../config/guard";
import { tokenStore } from "../agentapi/runtime";

function guard(req: Request, server: Parameters<Handler>[3]): void {
  assertConfigAccess({
    adminToken: process.env.EODVIEW_ADMIN_TOKEN || undefined,
    authorization: req.headers.get("authorization"),
    ip: server.requestIP(req)?.address,
    host: req.headers.get("host"),
    proxied: isProxied(req.headers),
  });
}

const noStore = (r: Response) => {
  r.headers.set("cache-control", "no-store");
  return r;
};

export function register(router: Router): void {
  router.get("/api/tokens", (req, _p, _u, server) => {
    guard(req, server);
    return noStore(json(tokenStore.list()));
  });

  router.post("/api/tokens", async (req, _p, _u, server) => {
    guard(req, server);
    const body = await readJson<{ name?: unknown } | null>(req);
    return noStore(json(tokenStore.create(body?.name), 201));
  });

  router.delete("/api/tokens/:id", (req, p, _u, server) => {
    guard(req, server);
    return tokenStore.remove(p.id) ? json({ ok: true }) : error(404, "token not found");
  });
}
