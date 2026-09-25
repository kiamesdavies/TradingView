// /api/alerts routes: CRUD + trigger history.
import { error, json, readJson, type Router } from "../http";
import { alertEngine, alertRepo } from "../alerts/engine";
import { validateAlertInput, validateAlertPatch } from "../alerts/input";
import { intParam } from "../store/validate";

export function register(router: Router): void {
  router.get("/api/alerts", () => json(alertRepo.list()));

  router.get("/api/alerts/history", (_req, _p, url) => {
    const limit = intParam(url.searchParams.get("limit"), "limit", 100, 1, 1000);
    return json(alertRepo.history(limit));
  });

  router.post("/api/alerts", async (req) => {
    const input = validateAlertInput(await readJson<unknown>(req));
    const alert = alertRepo.create(input);
    alertEngine.refresh();
    return json(alert, 201);
  });

  router.put("/api/alerts/:id", async (req, params) => {
    const patch = validateAlertPatch(await readJson<unknown>(req));
    const alert = alertRepo.update(params.id, patch);
    if (!alert) return error(404, "alert not found");
    alertEngine.refresh();
    return json(alert);
  });

  router.delete("/api/alerts/:id", (_req, params) => {
    if (!alertRepo.remove(params.id)) return error(404, "alert not found");
    alertEngine.refresh();
    return json({ ok: true });
  });
}
