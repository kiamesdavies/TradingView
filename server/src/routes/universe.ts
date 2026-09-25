// GET /api/universe/status, POST /api/universe/jobs/:name/run (guarded like /api/config).
import { error, json, type Handler, type Router } from "../http";
import { assertConfigAccess } from "../config/guard";
import { config } from "../config/config";
import { isJobName, JOB_NAMES, runJob, universeStatus } from "../universe/scheduler";

function guard(req: Request, server: Parameters<Handler>[3]): void {
  assertConfigAccess({
    adminToken: process.env.EODVIEW_ADMIN_TOKEN || undefined,
    authorization: req.headers.get("authorization"),
    ip: server.requestIP(req)?.address,
    host: req.headers.get("host"),
  });
}

export function register(router: Router): void {
  router.get("/api/universe/status", () => json(universeStatus()));

  router.post("/api/universe/jobs/:name/run", async (req, params, _u, server) => {
    guard(req, server);
    if (!isJobName(params.name)) return error(404, `unknown job "${params.name}"`, `expected one of ${JOB_NAMES.join(", ")}`);
    if (!config.getKey()) return error(503, "EODHD API key not configured");
    await runJob(params.name);
    return json({ ok: true });
  });
}
