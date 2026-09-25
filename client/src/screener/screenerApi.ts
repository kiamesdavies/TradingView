// Screener REST calls + a batched, cached sparkline loader.
import type {
  ScreenerMeta, ScreenerPreset, ScreenerQuery, ScreenerResponse, Symbol, UniverseStatus,
} from "@eodview/shared";
import { api, ApiRequestError } from "../api/http";

export const SPARK_DAYS = 60;

export const screenerApi = {
  meta: () => api.get<ScreenerMeta>("/screener/meta"),
  query: (q: ScreenerQuery) => api.post<ScreenerResponse>("/screener/query", q),
  presets: () => api.get<ScreenerPreset[]>("/screener/presets"),
  createPreset: (name: string, query: ScreenerPreset["query"]) => api.post<ScreenerPreset>("/screener/presets", { name, query }),
  updatePreset: (p: ScreenerPreset) => api.put<ScreenerPreset>(`/screener/presets/${encodeURIComponent(p.id)}`, p),
  deletePreset: (id: string) => api.del<{ ok: true }>(`/screener/presets/${encodeURIComponent(id)}`),
  universeStatus: () => api.get<UniverseStatus>("/universe/status"),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 404) return "Screener API not available on this server (404).";
    return e.detail ? `${e.message}: ${e.detail}` : e.message;
  }
  if (e instanceof SyntaxError) return "Server returned an invalid response.";
  return e instanceof Error ? e.message : String(e);
}

/** True when the error means no EODHD key is configured. */
export function isNoKeyError(e: unknown): boolean {
  return e instanceof ApiRequestError && (/no[ _-]?(api)?[ _-]?key/i.test(e.message) || /api key/i.test(e.detail ?? ""));
}

// ---------------- sparklines ----------------

const sparkCache = new Map<Symbol, number[]>();
const inflight = new Map<Symbol, Promise<number[] | null>>();
const MAX_CACHE = 2000;
const BATCH = 100;

export function cachedSparkline(symbol: Symbol): number[] | undefined {
  return sparkCache.get(symbol);
}

function remember(symbol: Symbol, closes: number[]) {
  if (sparkCache.size >= MAX_CACHE) {
    const first = sparkCache.keys().next().value;
    if (first !== undefined) sparkCache.delete(first);
  }
  sparkCache.set(symbol, closes);
}

/** Fetch sparklines for many symbols (batched, de-duplicated, cached). Missing symbols resolve to []. */
export async function loadSparklines(symbols: Symbol[]): Promise<Record<Symbol, number[]>> {
  const want = [...new Set(symbols.filter(Boolean))];
  const missing = want.filter((s) => !sparkCache.has(s) && !inflight.has(s));
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const p = api
      .get<Record<Symbol, number[]>>(`/screener/sparklines?symbols=${chunk.map(encodeURIComponent).join(",")}&days=${SPARK_DAYS}`)
      .then((res) => {
        for (const s of chunk) remember(s, Array.isArray(res?.[s]) ? res[s].filter((v) => typeof v === "number") : []);
        return null;
      })
      .catch(() => null)
      .finally(() => chunk.forEach((s) => inflight.delete(s)));
    for (const s of chunk) inflight.set(s, p);
  }
  await Promise.all(want.map((s) => inflight.get(s)).filter(Boolean));
  const out: Record<Symbol, number[]> = {};
  for (const s of want) out[s] = sparkCache.get(s) ?? [];
  return out;
}
