// The real AgentBackend: screener module (Q: runScreen/getMeta/Finviz parsers), universe pipeline (P: listMarkets),
// details service, bar cache, EODHD search.
import type { MarketInfo, SymbolInfo } from "@eodview/shared";
import { db } from "../db";
import { details } from "../details";
import { parseDetailsSymbol } from "../details/symbol";
import { getBars } from "../cache/bars";
import { eodhd } from "../eodhd/client";
import { getMeta, listScreenerMarkets, parseFinvizFilters, parseOrder, runScreen, safeUniverseStatus } from "../screener";
import * as universeMod from "../universe";
import { createLocalSearch } from "./search";
import type { AgentBackend } from "./service";

// The pipeline's listMarkets() is looked up at call time (it may land after this module).
const u3 = universeMod as unknown as { listMarkets?: () => MarketInfo[] };

function markets(): MarketInfo[] {
  if (typeof u3.listMarkets === "function") return u3.listMarkets();
  const list = listScreenerMarkets();
  if (list.length) return list;
  const st = safeUniverseStatus();
  return [{
    code: "US", name: "US exchanges (NYSE, NASDAQ, AMEX, NYSE ARCA, BATS)", country: "USA", currency: "USD",
    timezone: "America/New_York", enabled: true, symbols: st.symbols, withPrices: st.withPrices,
    withFundamentals: st.withFundamentals, lastPriceDate: st.lastPriceDate,
  }];
}

const localSearch = createLocalSearch(db);

export const agentBackend: AgentBackend = {
  meta: (market) => getMeta(market),
  runScreen: (q) => runScreen(q),
  markets,
  status: safeUniverseStatus,
  parseFilters: (f) => parseFinvizFilters(f),
  parseOrder: (o) => parseOrder(o),
  overview: (symbol) => details.overview(parseDetailsSymbol(symbol)),
  bars: (symbol, tf, limit, to, adjusted) => getBars(symbol, tf, to, limit, adjusted ?? true),
  news: (symbol, limit) => details.news(symbol, limit),
  events: (symbol, from, to) => details.events(parseDetailsSymbol(symbol), from, to),
  searchLocal: (q, limit) => localSearch(q, limit),
  searchRemote: (q): Promise<SymbolInfo[]> => eodhd.search(q),
};
