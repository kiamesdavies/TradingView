// Symbol details routes: overview, news, chart events, logo proxy.
import { HttpError, error, json, type Router } from "../http";
import { details } from "../details";
import { NEWS_MAX_LIMIT, NEWS_MIN_FETCH } from "../details/service";
import { parseDetailsSymbol } from "../details/symbol";

function intParam(raw: string | null, name: string): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return Math.floor(n);
}

export function register(router: Router): void {
  router.get("/api/symbols/:symbol/overview", async (_req, p) => json(await details.overview(parseDetailsSymbol(p.symbol))));

  router.get("/api/symbols/:symbol/news", async (_req, p, url) => {
    const sym = parseDetailsSymbol(p.symbol);
    const limit = intParam(url.searchParams.get("limit"), "limit") ?? NEWS_MIN_FETCH;
    return json(await details.news(sym.symbol, Math.max(1, Math.min(NEWS_MAX_LIMIT, limit))));
  });

  router.get("/api/symbols/:symbol/events", async (_req, p, url) => {
    const sym = parseDetailsSymbol(p.symbol);
    const from = intParam(url.searchParams.get("from"), "from");
    const to = intParam(url.searchParams.get("to"), "to");
    return json(await details.events(sym, from, to));
  });

  router.get("/api/symbols/:symbol/logo", async (_req, p) => {
    const sym = parseDetailsSymbol(p.symbol);
    const res = await details.logo(sym).catch((e) => {
      console.warn(`[logo] ${sym.symbol}: ${(e as Error).message}`);
      return null;
    });
    if (!res?.found) {
      const r = error(404, "no logo");
      r.headers.set("cache-control", "public, max-age=3600");
      return r;
    }
    return new Response(res.body as unknown as BodyInit, {
      headers: {
        "content-type": res.contentType,
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
