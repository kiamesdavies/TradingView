// Shared contract between server and client. Changing anything here affects both sides.

/** Unix time in SECONDS (UTC). lightweight-charts uses seconds for intraday; daily+ bars use the session date at 00:00 UTC. */
export type UnixSeconds = number;

export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1D" | "1W" | "1M";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"];

export interface Bar {
  time: UnixSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** EODHD symbol, `TICKER.EXCHANGE`, e.g. AAPL.US, EURUSD.FOREX, BTC-USD.CC */
export type Symbol = string;

export type AssetClass = "us_stock" | "stock" | "forex" | "crypto" | "index" | "etf" | "other";

export interface SymbolInfo {
  symbol: Symbol;        // "AAPL.US"
  code: string;          // "AAPL"
  exchange: string;      // "US"
  name: string;
  type: string;          // EODHD "Type" e.g. "Common Stock", "ETF", "Currency"
  country?: string;
  currency?: string;
  assetClass: AssetClass;
  streamable: boolean;   // true when an EODHD websocket feed exists (US, FOREX, CC)
}

export interface Quote {
  symbol: Symbol;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  prevClose: number;
  time: UnixSeconds;
}

// ---------- REST API (all JSON, prefix /api) ----------
// GET  /api/health                                  -> { ok: true, hasKey: boolean }
// GET  /api/search?q=apple                          -> SymbolInfo[]
// GET  /api/bars?symbol=AAPL.US&tf=1D&to=<unix>&limit=500 -> BarsResponse   (bars strictly before `to` when given, ascending)
// GET  /api/quotes?symbols=AAPL.US,MSFT.US          -> Quote[]
// GET  /api/config                                  -> ConfigView
// PUT  /api/config      body ConfigUpdate           -> ConfigView | ApiError(400 when key invalid)
// GET  /api/layout                                  -> Layout | null
// PUT  /api/layout      body Layout                 -> Layout
// GET  /api/watchlists                              -> Watchlist[]
// POST /api/watchlists  body {name}                 -> Watchlist
// PUT  /api/watchlists/:id body Watchlist           -> Watchlist
// DELETE /api/watchlists/:id                        -> { ok: true }
// GET  /api/drawings?symbol=AAPL.US                 -> Drawing[]
// PUT  /api/drawings?symbol=AAPL.US body Drawing[]  -> Drawing[]  (replaces the whole set for that symbol)
// GET  /api/alerts                                  -> Alert[]
// POST /api/alerts      body AlertInput             -> Alert
// PUT  /api/alerts/:id  body Partial<AlertInput> & {active?: boolean} -> Alert
// DELETE /api/alerts/:id                            -> { ok: true }
// GET  /api/alerts/history?limit=100                -> AlertEvent[]

export interface ApiError { error: string; detail?: string }

export interface BarsResponse {
  symbol: Symbol;
  tf: Timeframe;
  bars: Bar[];
  /** false when EODHD has no older data */
  hasMore: boolean;
}

export interface ConfigView {
  hasKey: boolean;
  keyMasked: string | null;       // "abcd…wxyz"
  keySource: "file" | "env" | "none";
  plan?: { name?: string; apiRequests?: number; dailyRateLimit?: number; email?: string };
  port: number;
}
export interface ConfigUpdate { apiKey: string }

export type ChartType = "candles" | "bars" | "line" | "area" | "heikin";
export type Theme = "dark" | "light";

export type IndicatorType = "sma" | "ema" | "vwap" | "bb" | "rsi" | "macd" | "atr" | "volma";
export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  params: Record<string, number | string>; // e.g. {period: 20, source: "close"}, bb {period, stdDev}, macd {fast, slow, signal}
  color?: string;
  visible: boolean;
}

export interface Layout {
  symbol: Symbol;
  tf: Timeframe;
  chartType: ChartType;
  theme: Theme;
  logScale: boolean;
  indicators: IndicatorConfig[];
  activeWatchlistId?: string;
  recentSymbols: Symbol[];
  timezone?: string;
  adjusted?: boolean;
  priceScaleMode?: PriceScaleMode;
}

export interface Watchlist {
  id: string;
  name: string;
  symbols: Symbol[];
}

export type DrawingType = "trendline" | "hline" | "hray" | "rect" | "fib";
export interface DrawingPoint { time: UnixSeconds; price: number }
export interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawingPoint[]; // hline/hray: 1 point; trendline/rect/fib: 2 points
  color: string;
  lineWidth: number;
}

export type AlertCondition = "cross_up" | "cross_down" | "cross";
export interface AlertInput {
  symbol: Symbol;
  price: number;
  condition: AlertCondition;
  repeat: boolean;
  note?: string;
}
export interface Alert extends AlertInput {
  id: string;
  active: boolean;
  createdAt: UnixSeconds;
  lastTriggeredAt?: UnixSeconds;
}
export interface AlertEvent {
  id: string;
  alertId: string;
  symbol: Symbol;
  price: number;        // trigger price level
  tickPrice: number;    // price that crossed it
  condition: AlertCondition;
  at: UnixSeconds;
  note?: string;
}

// ---------- WebSocket /ws (JSON messages) ----------
export type ClientMsg =
  | { type: "subscribe"; symbols: Symbol[] }
  | { type: "unsubscribe"; symbols: Symbol[] }
  | { type: "ping" };

export interface Tick {
  symbol: Symbol;
  price: number;
  volume: number;       // trade size for this tick (0 for forex quotes)
  time: number;         // unix MILLISECONDS
  /**
   * Set only on a tick the server coalesced from several upstream trades (all within one UTC minute):
   * first/highest/lowest price of that window. `price`/`time` are the last trade's.
   */
  open?: number;
  high?: number;
  low?: number;
}

export type ServerMsg =
  | { type: "tick"; tick: Tick }
  | { type: "quote"; quote: Quote }                     // periodic snapshot (polling fallback / non-streamable symbols)
  | { type: "alert"; event: AlertEvent }
  | { type: "status"; upstream: "connected" | "disconnected" | "no_key"; detail?: string }
  | { type: "pong" };

// ======================= v2: range bar, symbol details, screener =======================

// Layout additions (all optional so v1 layouts stay valid):
//   timezone?: IANA zone for the time axis + clock ("UTC" default, "exchange" = symbol's exchange zone)
//   adjusted?: daily+ bars split/dividend adjusted (default true) — the ADJ toggle
//   priceScaleMode?: "normal" | "log" | "percent" (supersedes logScale when set)
export type PriceScaleMode = "normal" | "log" | "percent";
export type RangePreset = "1D" | "5D" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "All";

// GET /api/bars?...&adj=0|1   (adj defaults to 1; only affects 1D/1W/1M)

// ---------- Symbol details ----------
// GET /api/symbols/:symbol/overview        -> SymbolOverview   (fundamentals cached 24h; quote live)
// GET /api/symbols/:symbol/news?limit=20   -> NewsItem[]
// GET /api/symbols/:symbol/events?from=<unix>&to=<unix> -> ChartEvent[]   (earnings, dividends, splits for chart markers)

export type StatFormat = "number" | "money" | "pct" | "ratio" | "date" | "text" | "volume" | "days";

export interface KeyStat {
  key: string;
  label: string;
  value: number | string | null;
  format: StatFormat;
}

export interface SymbolProfile {
  symbol: Symbol;
  name: string;
  exchange: string;          // primary listing, e.g. "NYSE", "NASDAQ"
  type: string;              // "Common Stock", "ETF", "Currency", ...
  isEtf: boolean;
  sector?: string;
  industry?: string;
  country?: string;
  currency?: string;
  description?: string;
  website?: string;
  logoUrl?: string;          // proxied: /api/symbols/:symbol/logo
  ipoDate?: string;
  employees?: number;
}

export interface ExtendedQuote {
  session: "pre" | "post";
  price: number;
  change: number;            // vs regular-session last price
  changePct: number;
  time: UnixSeconds;
}

export interface EarningsPoint {
  period: string;            // fiscal quarter end "2026-06-30"
  reportDate?: string;       // "2026-08-05"
  timing?: "BeforeMarket" | "AfterMarket";
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  upcoming: boolean;
}

export interface RevenuePoint {
  period: string;
  revenue: number | null;
}

export interface SymbolOverview {
  profile: SymbolProfile;
  quote: Quote | null;
  extended: ExtendedQuote | null;
  /** Ordered: the first 4 are shown collapsed (next earnings, volume, avg volume 30D, market cap), the rest on expand. */
  stats: KeyStat[];
  nextEarnings: { date: string; timing?: "BeforeMarket" | "AfterMarket"; epsEstimate: number | null; daysUntil: number } | null;
  earnings: EarningsPoint[];          // ascending, last 8 reported + upcoming
  revenue: RevenuePoint[];            // ascending, last 8 quarters
  analyst: {
    rating: number | null;            // EODHD 1(sell)..5(strong buy)
    targetPrice: number | null;
    strongBuy: number; buy: number; hold: number; sell: number; strongSell: number;
  } | null;
  latestNews: NewsItem | null;
  fundamentalsAsOf: UnixSeconds | null;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source?: string;
  publishedAt: UnixSeconds;
  symbols: Symbol[];
  sentiment?: number;        // -1..1 polarity
  summary?: string;
}

export type ChartEventType = "earnings" | "dividend" | "split";
export interface ChartEvent {
  type: ChartEventType;
  time: UnixSeconds;         // session date at 00:00 UTC
  label: string;             // "E", "D", "S"
  detail: string;            // tooltip text e.g. "EPS 0.50 vs 0.31 est (+61%)"
  upcoming: boolean;
}

// ---------- Screener ----------
// GET  /api/screener/meta                   -> ScreenerMeta
// POST /api/screener/query  body ScreenerQuery -> ScreenerResponse
// GET  /api/screener/presets                -> ScreenerPreset[]
// POST /api/screener/presets body {name, query} -> ScreenerPreset
// PUT  /api/screener/presets/:id body ScreenerPreset -> ScreenerPreset
// DELETE /api/screener/presets/:id          -> { ok: true }
// GET  /api/universe/status                 -> UniverseStatus
// POST /api/universe/jobs/:name/run         -> { ok: true }     (localhost / admin-token guarded like /api/config)

export type ScreenerGroup = "descriptive" | "fundamental" | "technical" | "news" | "etf";

export interface ScreenerOption {
  value: string;             // opaque id, e.g. "o10", "u5", "pos", "sp500", "nyse"
  label: string;             // "Over 10", "Under 5", "Positive (>0%)"
}

export interface ScreenerFilterDef {
  id: string;                // "pe", "sma50", "sector", ...
  /** v3: Finviz URL prefix for this filter (e.g. "fa_pe", "cap", "ta_sma50"); option code = `${code}_${option.value}`. */
  code?: string;
  label: string;             // "P/E", "50-Day Simple Moving Average"
  group: ScreenerGroup;
  options: ScreenerOption[]; // "Any" is implicit (no filter), not listed
  /** When set, the UI offers "Custom…" with min/max inputs in this unit. */
  custom?: { unit: "number" | "pct" | "money" | "date" | "volume" };
  appliesTo: "stock" | "etf" | "all";
  /** Filters whose data is not available on the user's EODHD plan / not yet collected are shown disabled. */
  available: boolean;
  unavailableReason?: string;
}

export type ScreenerFilterValue =
  | { id: string; value: string }
  | { id: string; min?: number | string; max?: number | string };

export interface ScreenerQuery {
  filters: ScreenerFilterValue[];
  /** v3: market code from ScreenerMeta.markets ("US", "ST", "LSE", "TO", ...) or "ALL". Defaults to "US". */
  market?: string;
  universe: "stocks" | "etfs" | "all";
  tickers?: string;          // optional "AAPL, MSFT" restriction
  view: string;              // ScreenerView id
  sort: { column: string; dir: "asc" | "desc" };
  offset: number;
  limit: number;             // max 500
}

export interface ScreenerColumnDef {
  id: string;                // "ticker", "company", "sector", "market_cap", "pe", "price", "change_pct", "volume", ...
  label: string;
  format: StatFormat;
  align: "left" | "right";
}

export interface ScreenerView {
  id: string;                // "overview" | "valuation" | "financial" | "ownership" | "performance" | "technical" | "etf"
  label: string;
  columns: string[];         // ScreenerColumnDef ids
}

export interface ScreenerMeta {
  /** v3: markets the pipeline tracks. GET /api/screener/meta?market=ST marks each filter's `available` from that market's actual data coverage. */
  markets: MarketInfo[];
  market: string;
  filters: ScreenerFilterDef[];
  columns: ScreenerColumnDef[];
  views: ScreenerView[];
  universe: UniverseStatus;
}

export interface ScreenerResponse {
  total: number;
  /** Each row has "symbol" plus one key per column of the requested view. */
  rows: Array<Record<string, number | string | null>>;
  asOf: string | null;       // last price date in the universe
}

export interface ScreenerPreset {
  id: string;
  name: string;
  query: Omit<ScreenerQuery, "offset" | "limit">;
}

export interface UniverseJobStatus {
  name: string;              // "symbols" | "prices" | "backfill" | "fundamentals" | "indices" | "earnings" | "news" | "metrics"
  state: "idle" | "running" | "error" | "disabled";
  lastRunAt: UnixSeconds | null;
  lastError: string | null;
  progress: string | null;   // "1520/6031"
  nextRunAt: UnixSeconds | null;
}

export interface UniverseStatus {
  symbols: number;           // stocks + ETFs tracked
  withPrices: number;
  withFundamentals: number;
  lastPriceDate: string | null;
  historyDays: number;       // distinct dates of price history stored
  creditsUsedToday: number;
  dailyCreditBudget: number;
  jobs: UniverseJobStatus[];
}

// ======================= v3: multi-market universe + agent API =======================

export interface MarketInfo {
  code: string;              // EODHD exchange code: "US", "ST", "LSE", "TO", "XETRA", "AU", ...
  name: string;              // "Nasdaq Stockholm"
  country: string;
  currency: string;          // listing currency, e.g. "SEK"
  timezone: string;          // IANA, e.g. "Europe/Stockholm"
  enabled: boolean;
  symbols: number;
  withPrices: number;
  withFundamentals: number;
  lastPriceDate: string | null;
}

// Agent-facing API (see docs/AGENT-API.md):
// GET  /api/v1/screen?f=cap_midover,ta_sma50_pa&market=US&o=-perf_3m&v=overview&limit=50&offset=0
//        Finviz URL-style filter codes (f), order (o, "-" = desc), view (v) -> ScreenerResponse
// POST /api/v1/screen   body ScreenerQuery -> ScreenerResponse
// GET  /api/v1/filters?market=US            -> ScreenerMeta (filters include `code` = Finviz-style URL code)
// GET  /api/v1/symbols/:symbol/overview, /bars, /news, /events — thin aliases of the existing endpoints
// GET  /api/openapi.json                     -> OpenAPI 3.1 spec
// POST /mcp                                  -> MCP (streamable HTTP) with tools: screen, list_filters, list_markets,
//                                               symbol_overview, get_bars, search_symbols, universe_status
// Auth: loopback callers need no token; others need `Authorization: Bearer <token>` from EODVIEW_API_TOKENS
//       (comma-separated) or tokens created in Settings (stored hashed). Tokens are read-only.

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;            // first 6 chars, for identification
  createdAt: UnixSeconds;
  lastUsedAt: UnixSeconds | null;
}
// GET    /api/tokens        -> ApiTokenView[]                     (config-guarded)
// POST   /api/tokens {name} -> ApiTokenView & { token: string }   (token shown once)
// DELETE /api/tokens/:id    -> { ok: true }

// ======================= Deployment info (Settings → "Connect & access") =======================
// GET /api/deployment -> DeploymentInfo. Unguarded: only non-secret values, set by deploy/deploy.sh via env.
export interface DeploymentInfo {
  hosted: boolean;                 // true when running on the hosted VM (EODVIEW_PUBLIC_URL set)
  publicUrl: string | null;        // e.g. https://charts.example.com
  gcpProject: string | null;
  gcpAccount: string | null;
  adminTokenSecret: string | null; // Secret Manager secret holding EODVIEW_ADMIN_TOKEN
  cfAccessClientId: string | null; // Cloudflare Access service token client id (not secret)
  repoPath: string | null;         // local checkout used for deploys (for the tf.sh command)
}
