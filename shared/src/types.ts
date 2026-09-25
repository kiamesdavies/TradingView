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
}

export type ServerMsg =
  | { type: "tick"; tick: Tick }
  | { type: "quote"; quote: Quote }                     // periodic snapshot (polling fallback / non-streamable symbols)
  | { type: "alert"; event: AlertEvent }
  | { type: "status"; upstream: "connected" | "disconnected" | "no_key"; detail?: string }
  | { type: "pong" };
