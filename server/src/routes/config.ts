// GET/PUT /api/config — guarded: Bearer EODVIEW_ADMIN_TOKEN when set, otherwise loopback callers only.
import type { ConfigUpdate, DeploymentInfo } from "@eodview/shared";
import { json, readJson, type Handler, type Router } from "../http";
import { config } from "../config/config";
import { assertConfigAccess, isProxied } from "../config/guard";

function guard(req: Request, server: Parameters<Handler>[3]): void {
  assertConfigAccess({
    adminToken: process.env.EODVIEW_ADMIN_TOKEN || undefined,
    authorization: req.headers.get("authorization"),
    ip: server.requestIP(req)?.address,
    host: req.headers.get("host"),
    proxied: isProxied(req.headers),
  });
}

const env = (name: string): string | null => process.env[name]?.trim() || null;

/** Non-secret deployment details for the Settings "Connect & access" section (values come from deploy/deploy.sh). */
export function deploymentInfo(): DeploymentInfo {
  const publicUrl = env("EODVIEW_PUBLIC_URL");
  return {
    hosted: publicUrl !== null,
    publicUrl,
    gcpProject: env("EODVIEW_GCP_PROJECT"),
    gcpAccount: env("EODVIEW_GCP_ACCOUNT"),
    adminTokenSecret: env("EODVIEW_ADMIN_TOKEN_SECRET"),
    cfAccessClientId: env("EODVIEW_CF_ACCESS_CLIENT_ID"),
    repoPath: env("EODVIEW_REPO_PATH"),
  };
}

export function register(router: Router): void {
  router.get("/api/deployment", () => json(deploymentInfo()));

  router.get("/api/config", async (req, _p, _u, server) => {
    guard(req, server);
    return json(await config.view());
  });

  router.put("/api/config", async (req, _p, _u, server) => {
    guard(req, server);
    const body = await readJson<Partial<ConfigUpdate>>(req);
    return json(await config.setKey(body?.apiKey as string));
  });
}
