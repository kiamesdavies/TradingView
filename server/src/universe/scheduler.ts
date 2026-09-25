// Process-wide universe pipeline (see pipeline.ts) wired to the shared db, EODHD client, config and fundamentals cache.
// Exports used by index.ts (startUniverseScheduler), routes/universe.ts and the screener (universeStatus, getSparklines).
import type { Symbol, UniverseStatus } from "@eodview/shared";
import { config } from "../config/config";
import { db } from "../db";
import { eodhd } from "../eodhd/client";
import { refreshFundamentals } from "../fundamentals/store";
import { JOB_NAMES, type JobName } from "./jobs";
import { getSparklinesFrom } from "./metrics";
import { UniversePipeline } from "./pipeline";

export type { JobName } from "./jobs";
export { JOB_NAMES } from "./jobs";

function envInt(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

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
          return db
            .query<{ symbol: string; data: string; fetched_at: number }, [number]>(
              `SELECT f.symbol, f.data, f.fetched_at FROM fundamentals f
               JOIN universe_symbols s ON s.symbol = f.symbol AND s.active = 1
               LEFT JOIN universe_fund u ON u.symbol = f.symbol
               WHERE u.symbol IS NULL OR f.fetched_at > u.fundamentals_at LIMIT ?`,
            )
            .all(limit)
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
      historyDays: envInt("EODVIEW_HISTORY_DAYS", 300),
      dailyBudget: envInt("EODVIEW_DAILY_CREDIT_BUDGET", 40000),
      creditReserve: envInt("EODVIEW_CREDIT_RESERVE", 15000),
    });
  }
  return pipeline;
}

/** Start the background loop (idempotent). Does nothing but report 'disabled' while no API key is set. */
export function startUniverseScheduler(): void {
  get().start();
}

export function stopUniverseScheduler(): void {
  pipeline?.stop();
}

export function universeStatus(): UniverseStatus {
  return get().status();
}

export function isJobName(name: string): name is JobName {
  return (JOB_NAMES as string[]).includes(name);
}

/** Manual trigger; returns immediately and the job runs in the background. */
export async function runJob(name: string): Promise<void> {
  if (!isJobName(name)) throw new Error(`unknown job "${name}" (expected one of ${JOB_NAMES.join(", ")})`);
  // Works also when the automatic loop is off (EODVIEW_UNIVERSE=off): the job then runs once on its own.
  get().runJob(name);
}

/** Adjusted closes (latest-bar basis), ascending, last `days` sessions per symbol. Unknown symbols → []. */
export function getSparklines(symbols: Symbol[], days: number): Record<Symbol, number[]> {
  get();
  return getSparklinesFrom(db, symbols, days);
}
