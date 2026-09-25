// Process-wide details service wired to the EODHD client, fundamentals store and bar cache.
import { join } from "node:path";
import { DATA_DIR } from "../db";
import { eodhd } from "../eodhd/client";
import { getCachedFundamentals, getFundamentals } from "../fundamentals/store";
import { getBars } from "../cache/bars";
import { createLogoStore } from "./logo";
import { createDetailsService } from "./service";

export const details = createDetailsService({
  raw: (path, params, what) => eodhd.raw(path, params, what),
  realtime: (symbols) => eodhd.realtime(symbols),
  search: (q) => eodhd.search(q),
  getFundamentals,
  getCachedFundamentals,
  dailyBars: async (symbol, limit) => (await getBars(symbol, "1D", undefined, limit)).bars,
  logos: createLogoStore({ dir: join(DATA_DIR, "logos") }),
});
