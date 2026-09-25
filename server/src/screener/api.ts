// Process-wide screener bound to the app database — shared by /api/screener/* and the agent API (/api/v1, MCP).
import type { MarketInfo, ScreenerMeta, ScreenerQuery, ScreenerResponse, UniverseStatus } from "@eodview/shared";
import { db } from "../db";
import * as universe from "../universe";
import { createPresetStore, type PresetStore } from "./presets";
import { createScreenerEngine, type ScreenerEngine } from "./query";

const EMPTY_STATUS: UniverseStatus = {
  symbols: 0, withPrices: 0, withFundamentals: 0, lastPriceDate: null, historyDays: 0,
  creditsUsedToday: 0, dailyCreditBudget: 0, jobs: [],
};

// The pipeline's v3 exports are looked up at call time so this module works before/without them.
const u = universe as unknown as { listMarkets?: () => MarketInfo[]; universeStatus?: () => UniverseStatus };

export function safeUniverseStatus(): UniverseStatus {
  try {
    return u.universeStatus?.() ?? EMPTY_STATUS;
  } catch (e) {
    console.error("[screener] universeStatus failed", e);
    return EMPTY_STATUS;
  }
}

let engine: ScreenerEngine | null = null;
let presets: PresetStore | null = null;

export function screenerEngine(): ScreenerEngine {
  return (engine ??= createScreenerEngine(db, { markets: () => u.listMarkets?.() ?? [] }));
}

export function presetStore(): PresetStore {
  return (presets ??= createPresetStore(db));
}

/** Validate (400 on bad input) and run a screen. `market` defaults to "US", "ALL" = every enabled market. */
export function runScreen(query: ScreenerQuery | unknown): ScreenerResponse {
  return screenerEngine().query(query);
}

/** Filters/columns/views for `market` (default "US"); filter `available` reflects that market's data coverage. */
export function getMeta(market?: string): ScreenerMeta {
  return screenerEngine().meta(safeUniverseStatus(), market);
}

export function listScreenerMarkets(): MarketInfo[] {
  return screenerEngine().markets();
}
