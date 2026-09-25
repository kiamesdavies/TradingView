// Process-wide universe pipeline (see pipeline.ts) wired to the shared db, EODHD client, config and fundamentals cache.
// Exports used by index.ts (startUniverseScheduler), routes/universe.ts and the screener
// (universeStatus, getSparklines, listMarkets, marketCoverage).
import type { MarketInfo, Symbol, UniverseStatus } from "@eodview/shared";
import { config } from "../config/config";
import { db } from "../db";
import { eodhd } from "../eodhd/client";
import { refreshFundamentals } from "../fundamentals/store";
import { computeCoverage, VersionedCache } from "./coverage";
import { DEFAULT_LOW_PRIORITY_RESERVE, JOB_NAMES, type JobName } from "./jobs";
import { MARKETS, resolveEnabledMarkets } from "./markets";
import { getMetricsVersion, getSparklinesFrom } from "./metrics";
import { resolveJobName, UniversePipeline } from "./pipeline";
import { kvGet, kvSet } from "./schema";

export type { JobName } from "./jobs";
export { JOB_NAMES } from "./jobs";

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function envNonNeg(name: string, def: number): number {
  const raw = process.env[name];
  const n = Number(raw ?? "");
  return raw && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}
function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const MARKETS_KV = "enabled_markets";

let pipeline: UniversePipeline | null = null;

function get(): UniversePipeline {
  if (!pipeline) {
    pipeline = new UniversePipeline({
      db,
      api: eodhd,
      getUsage: () => eodhd.user(),
      refreshFundamentals,
      externallyRefreshed: (limit) => {
        try {
          const codes = enabledMarketCodes();
          return db
            .query<{ symbol: string; data: string; fetched_at: number }, (string | number)[]>(
              `SELECT f.symbol, f.data, f.fetched_at FROM fundamentals f
               JOIN universe_symbols s ON s.symbol = f.symbol AND s.active = 1 AND s.market IN (${codes.map(() => "?").join(",")})
               LEFT JOIN universe_fund u ON u.symbol = f.symbol
               WHERE u.symbol IS NULL OR f.fetched_at > u.fundamentals_at LIMIT ?`,
            )
            .all(...codes, limit)
            .flatMap((r) => {
              try {
                return [{ symbol: r.symbol, data: JSON.parse(r.data) as Record<string, any>, fetchedAt: r.fetched_at }];
              } catch {
                return [];
              }
            });
        } catch {
          return [];
        }
      },
      getKey: () => config.getKey(),
      onKeyChange: (cb) => config.onKeyChange(cb),
      markets: enabledMarketCodes,
      historyYears: envNum("EODVIEW_HISTORY_YEARS", 5),
      backfillMaxSymbols: process.env.EODVIEW_BACKFILL_MAX_SYMBOLS ? envInt("EODVIEW_BACKFILL_MAX_SYMBOLS", 0) || null : null,
      fundamentalsMaxPerRun: envInt("EODVIEW_FUNDAMENTALS_MAX_PER_RUN", 500),
      lowPriorityReserve: envNonNeg("EODVIEW_JOB_CREDIT_RESERVE", DEFAULT_LOW_PRIORITY_RESERVE),
      bulkActionMarkets: (process.env.EODVIEW_ACTIONS_BULK_MARKETS ?? "US").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
      ratePerMin: envInt("EODVIEW_RATE_PER_MIN", 800),
      concurrency: envInt("EODVIEW_CONCURRENCY", 8),
      dailyBudget: envInt("EODVIEW_DAILY_CREDIT_BUDGET", 40000),
      creditReserve: envInt("EODVIEW_CREDIT_RESERVE", 15000),
    });
  }
  return pipeline;
}

/** Enabled market codes: EODVIEW_MARKETS env, else the stored setting (PUT /api/universe/markets), else "US". */
export function enabledMarketCodes(): string[] {
  let stored: string | null = null;
  try {
    stored = kvGet(db, MARKETS_KV);
  } catch {
    stored = null; // table not created yet (first call during pipeline construction)
  }
  return resolveEnabledMarkets(process.env.EODVIEW_MARKETS, stored).codes;
}

/** Where the enabled set comes from, and codes that were ignored. */
export function marketsSetting(): { markets: string[]; source: "env" | "config" | "default"; unknown: string[]; available: string[] } {
  get();
  const r = resolveEnabledMarkets(process.env.EODVIEW_MARKETS, kvGet(db, MARKETS_KV));
  return { markets: r.codes, source: r.source, unknown: r.unknown, available: MARKETS.map((m) => m.code) };
}

/** Store the enabled set (ignored while EODVIEW_MARKETS is set). Returns the effective setting. */
export function setEnabledMarkets(codes: string[]): ReturnType<typeof marketsSetting> {
  get();
  const known = new Set(MARKETS.map((m) => m.code));
  const clean = [...new Set(codes.map((c) => c.trim().toUpperCase()))].filter((c) => known.has(c));
  kvSet(db, MARKETS_KV, clean.length ? clean.join(",") : null);
  return marketsSetting();
}

/** Start the background loop (idempotent). Does nothing but report 'disabled' while no API key is set. */
export function startUniverseScheduler(): void {
  get().start();
}

export function stopUniverseScheduler(): void {
  pipeline?.stop();
}

export function universeStatus(): ReturnType<UniversePipeline["status"]> & UniverseStatus {
  return get().status();
}

/** Every registry market with DB counts; `enabled` reflects the current setting. */
export function listMarkets(): MarketInfo[] {
  return get().listMarkets();
}

const coverageCache = new VersionedCache<Record<string, number>>(10 * 60_000, getMetricsVersion);

/**
 * Fraction (0..1) of non-null values per universe_metrics column among `market`'s symbols that have a price.
 * "ALL" = all enabled markets. Cached 10 minutes and recomputed after every metrics run.
 */
export function marketCoverage(market: string): Record<string, number> {
  const p = get();
  const code = market.trim().toUpperCase();
  const markets = code === "ALL" ? p.markets().map((m) => m.code) : [code];
  return coverageCache.get(markets.join(","), () => computeCoverage(db, markets));
}

export function isJobName(name: string): name is JobName {
  const [job] = name.split(":");
  return (JOB_NAMES as string[]).includes(job ?? "") && resolveJobName(name, get().markets()).length > 0;
}

/** Manual trigger ("prices" = every enabled market, "prices:ST" = one); returns immediately. */
export async function runJob(name: string): Promise<void> {
  if (!isJobName(name)) throw new Error(`unknown job "${name}" (expected one of ${JOB_NAMES.join(", ")}, optionally ":<market>")`);
  // Works also when the automatic loop is off (EODVIEW_UNIVERSE=off): the job then runs once on its own.
  get().runJob(name);
}

/** Adjusted closes (latest-bar basis), ascending, last `days` sessions per symbol. Unknown symbols → []. */
export function getSparklines(symbols: Symbol[], days: number): Record<Symbol, number[]> {
  get();
  return getSparklinesFrom(db, symbols, days);
}
