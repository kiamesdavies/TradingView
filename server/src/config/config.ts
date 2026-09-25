// Process-wide configuration singleton.
// Key resolution: server/data/config.json → EODHD_API_KEY env → none.
import { join } from "node:path";
import { DATA_DIR } from "../db";
import { eodhdGet } from "../eodhd/request";
import { mapUser, type EodhdUser } from "../eodhd/mappers";
import { createConfigManager } from "./manager";

export { maskKey } from "./manager";

export const CONFIG_FILE = join(DATA_DIR, "config.json");

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Validates a key directly (not through the `eodhd` client, which always uses the current key). */
export async function fetchUserWithKey(key: string): Promise<EodhdUser> {
  return mapUser(await eodhdGet("/user", {}, key, "user info"));
}

export const config = createConfigManager({
  file: CONFIG_FILE,
  env: process.env,
  port: envInt("PORT", 3001),
  fetchUser: fetchUserWithKey,
});

/** Cache tuning (seconds), overridable via env. */
export const cacheSettings = {
  /** Daily/weekly/monthly tail refresh interval. */
  dailyTailTtlSec: envInt("EODVIEW_DAILY_TTL", 600),
  /** Intraday window that includes "now". */
  intradayLatestTtlSec: envInt("EODVIEW_INTRADAY_TTL", 60),
  /** Fully historical intraday windows. */
  intradayHistoryTtlSec: envInt("EODVIEW_INTRADAY_HISTORY_TTL", 6 * 3600),
  /** Quote snapshots for /api/quotes. */
  quoteTtlSec: envInt("EODVIEW_QUOTE_TTL", 10),
};
