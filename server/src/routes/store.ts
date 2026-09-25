// /api/layout, /api/watchlists, /api/drawings routes.
import { db } from "../db";
import { error, json, readJson, type Router } from "../http";
import { createLayoutStore } from "../store/layout";
import { createWatchlistStore } from "../store/watchlists";
import { createDrawingStore } from "../store/drawings";
import { requireSymbol } from "../store/validate";

export const layoutStore = createLayoutStore(db);
export const watchlistStore = createWatchlistStore(db);
export const drawingStore = createDrawingStore(db);

export function register(router: Router): void {
  router.get("/api/layout", () => json(layoutStore.get()));
  router.put("/api/layout", async (req) => json(layoutStore.put(await readJson<unknown>(req))));

  router.get("/api/watchlists", () => json(watchlistStore.list()));
  router.post("/api/watchlists", async (req) => json(watchlistStore.create(await readJson<unknown>(req)), 201));
  router.put("/api/watchlists/:id", async (req, params) => {
    const wl = watchlistStore.update(params.id, await readJson<unknown>(req));
    return wl ? json(wl) : error(404, "watchlist not found");
  });
  router.delete("/api/watchlists/:id", (_req, params) =>
    watchlistStore.remove(params.id) ? json({ ok: true }) : error(404, "watchlist not found"));

  router.get("/api/drawings", (_req, _p, url) => json(drawingStore.get(requireSymbol(url.searchParams.get("symbol") ?? undefined))));
  router.put("/api/drawings", async (req, _p, url) => {
    const symbol = requireSymbol(url.searchParams.get("symbol") ?? undefined);
    return json(drawingStore.put(symbol, await readJson<unknown>(req)));
  });
}
