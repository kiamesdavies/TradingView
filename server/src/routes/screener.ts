// /api/screener/* — Finviz-style screener over the local universe DB.
import type { UniverseStatus } from "@eodview/shared";
import { db } from "../db";
import { error, json, readJson, type Router } from "../http";
import { getSparklines, universeStatus } from "../universe";
import { createPresetStore, createScreenerEngine, parseSparklineParams } from "../screener";

export const screenerEngine = createScreenerEngine(db);
export const presetStore = createPresetStore(db);

const EMPTY_STATUS: UniverseStatus = {
  symbols: 0, withPrices: 0, withFundamentals: 0, lastPriceDate: null, historyDays: 0,
  creditsUsedToday: 0, dailyCreditBudget: 0, jobs: [],
};

function safeStatus(): UniverseStatus {
  try {
    return universeStatus();
  } catch (e) {
    console.error("[screener] universeStatus failed", e);
    return EMPTY_STATUS;
  }
}

export function register(router: Router): void {
  router.get("/api/screener/meta", () => json(screenerEngine.meta(safeStatus())));

  router.post("/api/screener/query", async (req) => json(screenerEngine.query(await readJson<unknown>(req))));

  router.get("/api/screener/presets", () => json(presetStore.list()));
  router.post("/api/screener/presets", async (req) => json(presetStore.create(await readJson<unknown>(req)), 201));
  router.put("/api/screener/presets/:id", async (req, params) => {
    const p = presetStore.update(params.id, await readJson<unknown>(req));
    return p ? json(p) : error(404, "preset not found");
  });
  router.delete("/api/screener/presets/:id", (_req, params) =>
    presetStore.remove(params.id) ? json({ ok: true }) : error(404, "preset not found"));

  router.get("/api/screener/sparklines", async (_req, _p, url) => {
    const { symbols, days } = parseSparklineParams(url);
    if (!symbols.length) return json({});
    return json(await getSparklines(symbols, days));
  });
}
