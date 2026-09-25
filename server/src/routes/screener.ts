// /api/screener/* — Finviz-style screener over the local universe DB.
import { error, json, readJson, type Router } from "../http";
import { getSparklines } from "../universe";
import { getMeta, parseSparklineParams, presetStore, runScreen } from "../screener";

export function register(router: Router): void {
  // ?market=US|ST|…|ALL (default US): filter availability follows that market's data coverage.
  router.get("/api/screener/meta", (_req, _p, url) => json(getMeta(url.searchParams.get("market") ?? undefined)));

  router.post("/api/screener/query", async (req) => json(runScreen(await readJson<unknown>(req))));

  router.get("/api/screener/presets", () => json(presetStore().list()));
  router.post("/api/screener/presets", async (req) => json(presetStore().create(await readJson<unknown>(req)), 201));
  router.put("/api/screener/presets/:id", async (req, params) => {
    const p = presetStore().update(params.id, await readJson<unknown>(req));
    return p ? json(p) : error(404, "preset not found");
  });
  router.delete("/api/screener/presets/:id", (_req, params) =>
    presetStore().remove(params.id) ? json({ ok: true }) : error(404, "preset not found"));

  router.get("/api/screener/sparklines", async (_req, _p, url) => {
    const { symbols, days } = parseSparklineParams(url);
    if (!symbols.length) return json({});
    return json(await getSparklines(symbols, days));
  });
}
