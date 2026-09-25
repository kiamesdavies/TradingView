// Market registry for the multi-market universe (pure; see markets.test.ts).
//
// Every market is an EODHD exchange code. Symbols are "CODE.EX" (US uses ".US"). Each market has its own
// symbol-list filter, trading calendar (IANA zone, close time, weekend, holidays learned from EODHD's
// exchange-details endpoint), daily bulk job time (close + publishDelayMin) and index-membership codes.
//
// Verified 2026-09-25 against the live API: /exchange-symbol-list works for every code below; MI (Milan),
// TSE (Tokyo) and NSE (India) answer 404 "Exchange Not Found" on this plan and are therefore not listed.
// Index components verified with /fundamentals/<IDX>?filter=Components (counts in comments). Composite indices
// that contain the whole market (KS11 790, KQ11 1362, TWII 805) are left out because membership says nothing;
// SPTSXV.INDX (TSX Venture) has no components (404).

export interface IndexDef {
  /** EODHD index symbol, e.g. "FTSE.INDX". */
  code: string;
  /** Short id stored in universe_metrics.indices, e.g. "FTSE". */
  id: string;
  name: string;
  /** Fewer components than this = a broken payload; the previous membership is kept. */
  min: number;
  /** Legacy v2 flag column on universe_symbols / universe_metrics (US only). */
  col?: "in_sp500" | "in_ndx" | "in_dji";
}

export interface SymbolListFilter {
  /** EODHD "Type" values admitted as stocks. */
  stockTypes: string[];
  /** Admit Type "ETF" as kind 'etf'. */
  etfs: boolean;
  /** Allowed "Exchange" values for stocks (upper-case); undefined = any. */
  stockExchanges?: string[];
  /** Allowed "Exchange" values for ETFs (upper-case); undefined = any. */
  etfExchanges?: string[];
  /** Allowed listing currencies ("Currency" column); undefined = any. */
  currencies?: string[];
  /** Codes matching this are dropped (e.g. LSE international-order-book lines "0R2V"). */
  excludeCode?: RegExp;
  /** Exchange renames applied to the stored `exchange` column. */
  exchangeAlias?: Record<string, string>;
}

export interface MarketDef {
  code: string;
  name: string;
  /** Country name as EODHD writes it in General.CountryName. */
  country: string;
  /** Listing currency of most symbols (LSE: GBX = pence). Per-symbol currency comes from the symbol list. */
  currency: string;
  timezone: string;
  /** Regular session, local wall clock "HH:MM". */
  open: string;
  close: string;
  /** Minutes after the close when EODHD's end-of-day bulk for the session is fetched. */
  publishDelayMin: number;
  /** Weekend days (0 = Sunday). */
  weekend: number[];
  /** US: apply the rule-based NYSE holiday calendar in addition to learned holidays. */
  nyseHolidays?: boolean;
  filter: SymbolListFilter;
  indices: IndexDef[];
  /** A symbol list with fewer admitted rows than this is treated as broken (the universe is kept). */
  minSymbols: number;
}

const WEEKEND = [0, 6];
const stocksOnly = (cur: string): SymbolListFilter => ({ stockTypes: ["Common Stock"], etfs: false, currencies: [cur] });
const PUBLISH_DELAY = 150;

/** Registry order = scheduling priority and display order. */
export const MARKETS: MarketDef[] = [
  {
    code: "US", name: "US (NYSE, Nasdaq, NYSE American, Arca, Cboe BZX)", country: "USA", currency: "USD",
    timezone: "America/New_York", open: "09:30", close: "16:00", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, nyseHolidays: true,
    filter: {
      stockTypes: ["Common Stock"], etfs: true,
      stockExchanges: ["NYSE", "NASDAQ", "AMEX", "NYSE MKT"],
      etfExchanges: ["NYSE ARCA", "NASDAQ", "BATS", "NYSE", "AMEX"],
      exchangeAlias: { "NYSE MKT": "AMEX" },
    },
    indices: [
      { code: "GSPC.INDX", id: "SP500", name: "S&P 500", min: 400, col: "in_sp500" },
      { code: "NDX.INDX", id: "NDX", name: "Nasdaq-100", min: 80, col: "in_ndx" },
      { code: "DJI.INDX", id: "DJI", name: "Dow Jones Industrial Average", min: 25, col: "in_dji" },
    ],
    minSymbols: 2000,
  },
  {
    code: "TO", name: "Toronto Stock Exchange", country: "Canada", currency: "CAD", timezone: "America/Toronto",
    open: "09:30", close: "16:00", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("CAD"),
    indices: [{ code: "GSPTSE.INDX", id: "TSX", name: "S&P/TSX Composite", min: 150 }], // 225
    minSymbols: 300,
  },
  {
    code: "V", name: "TSX Venture Exchange", country: "Canada", currency: "CAD", timezone: "America/Toronto",
    open: "09:30", close: "16:00", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("CAD"),
    indices: [], minSymbols: 500,
  },
  {
    code: "LSE", name: "London Stock Exchange", country: "UK", currency: "GBX", timezone: "Europe/London",
    open: "08:00", close: "16:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND,
    // 3.8k "Common Stock" lines, of which ~2.4k are international-order-book copies of foreign shares quoted in
    // USD/EUR/GBP with 0XXX codes. UK primary listings quote in pence (GBX).
    filter: { stockTypes: ["Common Stock"], etfs: false, currencies: ["GBX"], excludeCode: /^0[A-Z0-9]{3,}$/ },
    indices: [
      { code: "FTSE.INDX", id: "FTSE", name: "FTSE 100", min: 90 }, // 100
      { code: "FTMC.INDX", id: "FTMC", name: "FTSE 250", min: 200 }, // 250
    ],
    minSymbols: 500,
  },
  {
    code: "XETRA", name: "Xetra (Deutsche Börse)", country: "Germany", currency: "EUR", timezone: "Europe/Berlin",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("EUR"),
    indices: [
      { code: "GDAXI.INDX", id: "DAX", name: "DAX 40", min: 30 }, // 39
      { code: "MDAXI.INDX", id: "MDAX", name: "MDAX", min: 35 }, // 49
      { code: "SDAXI.INDX", id: "SDAX", name: "SDAX", min: 45 }, // 62
      { code: "TECDAX.INDX", id: "TECDAX", name: "TecDAX", min: 20 }, // 29
    ],
    minSymbols: 250,
  },
  {
    code: "PA", name: "Euronext Paris", country: "France", currency: "EUR", timezone: "Europe/Paris",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("EUR"),
    indices: [{ code: "FCHI.INDX", id: "CAC40", name: "CAC 40", min: 30 }], // 40
    minSymbols: 250,
  },
  {
    code: "AS", name: "Euronext Amsterdam", country: "Netherlands", currency: "EUR", timezone: "Europe/Amsterdam",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("EUR"),
    indices: [{ code: "AEX.INDX", id: "AEX", name: "AEX", min: 20 }], // 28
    minSymbols: 40,
  },
  {
    code: "ST", name: "Nasdaq Stockholm", country: "Sweden", currency: "SEK", timezone: "Europe/Stockholm",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("SEK"),
    indices: [
      { code: "OMXS30.INDX", id: "OMXS30", name: "OMX Stockholm 30", min: 25 }, // 30
      { code: "OMXSPI.INDX", id: "OMXSPI", name: "OMX Stockholm All-Share", min: 250 }, // 399
    ],
    minSymbols: 350,
  },
  {
    code: "OL", name: "Oslo Børs", country: "Norway", currency: "NOK", timezone: "Europe/Oslo",
    open: "09:00", close: "16:20", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("NOK"),
    indices: [{ code: "OBX.INDX", id: "OBX", name: "OBX", min: 18 }], // 23
    minSymbols: 100,
  },
  {
    code: "CO", name: "Nasdaq Copenhagen", country: "Denmark", currency: "DKK", timezone: "Europe/Copenhagen",
    open: "09:00", close: "17:00", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("DKK"),
    indices: [{ code: "OMXC25.INDX", id: "OMXC25", name: "OMX Copenhagen 25", min: 20 }], // 25
    minSymbols: 70,
  },
  {
    code: "HE", name: "Nasdaq Helsinki", country: "Finland", currency: "EUR", timezone: "Europe/Helsinki",
    open: "10:00", close: "18:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("EUR"),
    indices: [{ code: "OMXH25.INDX", id: "OMXH25", name: "OMX Helsinki 25", min: 20 }], // 25
    minSymbols: 70,
  },
  {
    code: "SW", name: "SIX Swiss Exchange", country: "Switzerland", currency: "CHF", timezone: "Europe/Zurich",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("CHF"),
    indices: [{ code: "SSMI.INDX", id: "SMI", name: "Swiss Market Index", min: 15 }], // 20
    minSymbols: 90,
  },
  {
    code: "MC", name: "Bolsa de Madrid", country: "Spain", currency: "EUR", timezone: "Europe/Madrid",
    open: "09:00", close: "17:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("EUR"),
    indices: [{ code: "IBEX.INDX", id: "IBEX35", name: "IBEX 35", min: 30 }], // 35
    minSymbols: 90,
  },
  {
    code: "AU", name: "Australian Securities Exchange", country: "Australia", currency: "AUD", timezone: "Australia/Sydney",
    open: "10:00", close: "16:10", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("AUD"),
    indices: [{ code: "AXJO.INDX", id: "ASX200", name: "S&P/ASX 200", min: 150 }], // 199
    minSymbols: 700,
  },
  {
    code: "KO", name: "Korea Exchange (KOSPI)", country: "Korea", currency: "KRW", timezone: "Asia/Seoul",
    open: "09:00", close: "15:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("KRW"),
    indices: [], minSymbols: 350,
  },
  {
    code: "KQ", name: "KOSDAQ", country: "Korea", currency: "KRW", timezone: "Asia/Seoul",
    open: "09:00", close: "15:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("KRW"),
    indices: [], minSymbols: 700,
  },
  {
    code: "TW", name: "Taiwan Stock Exchange", country: "Taiwan", currency: "TWD", timezone: "Asia/Taipei",
    open: "09:00", close: "13:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("TWD"),
    indices: [], minSymbols: 400,
  },
  {
    code: "TWO", name: "Taipei Exchange (OTC)", country: "Taiwan", currency: "TWD", timezone: "Asia/Taipei",
    open: "09:00", close: "13:30", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("TWD"),
    indices: [], minSymbols: 400,
  },
  {
    code: "HK", name: "Hong Kong Stock Exchange", country: "Hong Kong", currency: "HKD", timezone: "Asia/Hong_Kong",
    open: "09:30", close: "16:10", publishDelayMin: PUBLISH_DELAY, weekend: WEEKEND, filter: stocksOnly("HKD"),
    indices: [{ code: "HSI.INDX", id: "HSI", name: "Hang Seng Index", min: 60 }], // 90
    minSymbols: 1400,
  },
];

const BY_CODE = new Map(MARKETS.map((m) => [m.code, m]));

export function getMarket(code: string): MarketDef | undefined {
  return BY_CODE.get(code.toUpperCase());
}

/** Tier-1 momentum markets + Stockholm, from docs/MARKET-STUDY.md (market-defaults block). */
export const DEFAULT_MARKETS = ["US", "AU", "TW", "OL", "XETRA", "ST"];

/**
 * Enabled market codes: the env list wins, then the stored setting, then DEFAULT_MARKETS. Unknown codes are
 * dropped (reported via `unknown`); registry order is kept. An empty result falls back to the default.
 */
export function resolveEnabledMarkets(env: string | undefined | null, stored: string | undefined | null): { codes: string[]; source: "env" | "config" | "default"; unknown: string[] } {
  const parse = (s: string) => s.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const [raw, source] of [[env, "env"], [stored, "config"]] as const) {
    if (!raw || !raw.trim()) continue;
    const want = parse(raw);
    const unknown = want.filter((c) => !BY_CODE.has(c));
    const codes = MARKETS.map((m) => m.code).filter((c) => want.includes(c));
    if (codes.length) return { codes, source, unknown };
    return { codes: [...DEFAULT_MARKETS], source: "default", unknown };
  }
  return { codes: [...DEFAULT_MARKETS], source: "default", unknown: [] };
}

/** "SIVE.ST" → "ST"; "AAPL.US" → "US"; no suffix → null. */
export function marketOfSymbol(symbol: string): string | null {
  const i = symbol.lastIndexOf(".");
  return i > 0 ? symbol.slice(i + 1).toUpperCase() : null;
}

export const symbolFor = (code: string, market: string): string => `${code}.${market}`;

/** Local "HH:MM" → minutes after midnight. */
export function hhmm(s: string): number {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + (m || 0);
}
