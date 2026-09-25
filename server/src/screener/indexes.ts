// Market-specific index membership options for the Index filter (FTSE 100, DAX 40, OMXS30, …).
// Definitions come from the pipeline's market registry; membership is read from `universe_metrics.indices`
// (index ids such as "FTSE,FTMC"; a JSON array is matched too). US indexes keep their v2 in_* flag columns.
import * as marketsMod from "../universe/markets";
import type { Build } from "./filters";

export interface IndexOption { market: string; id: string; value: string; label: string }

interface IndexDefLike { id: string; name: string; col?: string }
interface MarketDefLike { code: string; indices?: IndexDefLike[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Every non-US index the pipeline tracks (read defensively: the registry is owned by the pipeline). */
export function indexOptions(): IndexOption[] {
  const list = (marketsMod as unknown as { MARKETS?: MarketDefLike[] }).MARKETS ?? [];
  const out: IndexOption[] = [];
  for (const m of list) {
    for (const i of m.indices ?? []) {
      if (i.col) continue; // US: in_sp500 / in_ndx / in_dji static options
      out.push({ market: m.code, id: i.id, value: slug(i.id), label: i.name });
    }
  }
  return out;
}

let cache: Map<string, IndexOption> | null = null;
export function indexBySlug(value: string): IndexOption | undefined {
  cache ??= new Map(indexOptions().map((o) => [o.value, o]));
  return cache.get(value);
}

/** Membership predicate for one index id. */
export function indexMember(id: string): Build {
  return (c) => {
    const col = c.col("indices");
    return {
      sql: `(',' || REPLACE(${col}, ' ', '') || ',') LIKE ? OR ${col} LIKE ?`,
      params: [`%,${id},%`, `%"${id}"%`],
    };
  };
}
