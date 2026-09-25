# EODView — Architecture & Module Contract

```
browser (React + lightweight-charts)            Bun server (:3001)                         EODHD
┌──────────────────────────────┐   REST /api   ┌───────────────────────────────┐  HTTPS  ┌──────────────┐
│ C4 shell: topbar, watchlist, │ ────────────▶ │ http.ts router                │ ──────▶ │ eod, intraday│
│   alerts, settings, store    │               │ S1 config · eodhd client ·    │         │ search, real-│
│ C1 chart core (datafeed,     │               │    bar cache/aggregation      │         │ time, user   │
│   live candle, legend)       │   WS /ws      │ S2 realtime hub · alerts ·    │   WSS   │ ws.eodhistor-│
│ C2 indicators  C3 drawings   │ ◀──────────▶  │    store (layout/wl/drawings) │ ◀─────▶ │ icaldata.com │
└──────────────────────────────┘               │ db.ts (bun:sqlite)            │         └──────────────┘
                                               └───────────────────────────────┘
```

All shared data shapes live in `shared/src/types.ts` (import as `@eodview/shared`). **Do not change it** without recording the change in your report.

## Pre-written glue (owned by the lead; do not rewrite, only extend where noted)
- `server/src/http.ts` — tiny router: `router.get/post/put/delete(path, handler)`, `:param` segments, `json()` / `error()` helpers.
- `server/src/db.ts` — shared `db` (bun:sqlite, WAL). Each module creates its own tables with `CREATE TABLE IF NOT EXISTS` in its own file.
- `server/src/index.ts` — wires modules: calls each module's `register(router)` and the hub's websocket handlers; serves `client/dist` in production.
- `client/src/api/http.ts` — `api.get/put/post/del<T>(path, body?)`.
- `client/src/state/store.ts` — Zustand store (layout, watchlists, alerts, quotes, ui flags).
- `client/src/chart/types.ts` — `ChartHandle`, the interface C2/C3 use to attach to the chart.

## Modules and file ownership

### S1 — Server core (config, EODHD client, bars)
Owns `server/src/config/**`, `server/src/eodhd/**`, `server/src/cache/**`, `server/src/routes/market.ts`, `server/src/routes/config.ts`, `server/src/cli.ts`, tests beside them.
Exports:
- `config/config.ts`: `export const config` with `getKey(): string | null`, `view(): Promise<ConfigView>`, `setKey(key: string): Promise<ConfigView>` (validates via EODHD `/api/user`, persists `server/data/config.json`, emits change), `onKeyChange(cb: (key: string|null) => void): () => void`, `port: number`.
- `eodhd/client.ts`: `export const eodhd` with `search(q)`, `eod(symbol, from?, to?, period)`, `intraday(symbol, interval, fromUnix?, toUnix?)`, `realtime(symbols[])`, `user()`; reads key from `config` on every call; throws `EodhdError {status, message}`. In-flight request de-duplication.
- `cache/bars.ts`: `getBars(symbol, tf, to?: UnixSeconds, limit = 500): Promise<BarsResponse>` — SQLite cache for 1D (tail refresh), short TTL cache for intraday, aggregation 5m→15m/30m, 1h→4h, daily via EODHD period=w/m for 1W/1M.
- `routes/market.ts`: `register(router)` for `/api/health`, `/api/search`, `/api/bars`, `/api/quotes`.
- `routes/config.ts`: `register(router)` for `GET/PUT /api/config` with the localhost / `EODVIEW_ADMIN_TOKEN` guard.
- `cli.ts`: `bun run server/src/cli.ts set-key <KEY> | show`.

### S2 — Server realtime, alerts, persistence
Owns `server/src/realtime/**`, `server/src/alerts/**`, `server/src/store/**`, `server/src/routes/store.ts`, `server/src/routes/alerts.ts`, tests beside them.
Exports:
- `realtime/hub.ts`: `export const hub` with `websocket: { open, message, close }` (Bun `WebSocketHandler<{id: string}>`), `broadcast(msg: ServerMsg)`, `onTick(cb: (t: Tick) => void): () => void`, `ensureSubscribed(symbols: Symbol[], ownerId: string)` (lets alerts keep upstream subscriptions alive), `status()`. Upstream: EODHD WS endpoints `wss://ws.eodhistoricaldata.com/ws/{us|us-quote|forex|crypto}?api_token=KEY`; symbol mapping `AAPL.US→AAPL (us)`, `EURUSD.FOREX→EURUSD (forex)`, `BTC-USD.CC→BTC-USD (crypto)`; ref-counted subscribe/unsubscribe; reconnect with backoff; reconnect on `config.onKeyChange`. Non-streamable symbols get a `quote` message every 60s via `eodhd.realtime`.
- `alerts/engine.ts` + `routes/alerts.ts`: CRUD + history + evaluation on ticks (and quotes for non-streamable); push `{type:"alert"}`.
- `store/*.ts` + `routes/store.ts`: layout, watchlists (seed a default "Watchlist" with AAPL.US, MSFT.US, NVDA.US, SPY.US, BTC-USD.CC, EURUSD.FOREX on first run), drawings per symbol.
- Each routes file exports `register(router)`.

### C1 — Chart core
Owns `client/src/chart/**` (except `types.ts`, which it may extend but not break).
- `ChartView.tsx`: `export function ChartView(props: { onReady?: (h: ChartHandle) => void })` — reads symbol/tf/chartType/theme/logScale from the store, loads bars from `/api/bars`, backfills on scroll to the left edge, builds live candles from ticks (via `wsClient`), volume histogram, Heikin-Ashi transform, crosshair OHLCV legend, resizes with the container. Renders alert price lines for the current symbol (from store `alerts`). Right-click context menu “Add alert at <price>” calling `store.createAlert`.
- `chart/candles.ts`: pure functions `bucketStart(timeSec, tf)`, `applyTick(bars, tick, tf)`, `toHeikinAshi(bars)` with `bun test` tests.

### C2 — Indicators
Owns `shared/src/indicators/**` (pure math + `bun test`), `client/src/indicators/**`.
- `shared/src/indicators/index.ts`: `sma, ema, rsi, macd, bollinger, atr, vwap, volumeMa` taking `Bar[]`, returning `{time, value}[]` (or multiple lines), NaN-free (skip warmup).
- `client/src/indicators/IndicatorLayer.tsx`: `export function IndicatorLayer(props: { handle: ChartHandle | null })` — renders store `layout.indicators` onto the chart (overlays on pane 0, oscillators on new panes via lightweight-charts v5 `addSeries(Type, opts, paneIndex)`), recomputes on `handle.onBarsChanged`.
- `client/src/indicators/IndicatorDialog.tsx`: `export function IndicatorDialog(props: { open: boolean; onClose: () => void })` — add/remove/edit indicators via store actions.
- `INDICATOR_DEFS` registry with defaults and display names.

### C3 — Drawings
Owns `client/src/drawings/**`.
- `DrawingLayer.tsx`: `export function DrawingLayer(props: { handle: ChartHandle | null })` — implements drawings as lightweight-charts v5 series primitives (`ISeriesPrimitive`) attached to `handle.mainSeries`; mouse creation, selection, handle dragging, Del to remove, loads/saves via `/api/drawings?symbol=` (debounced PUT).
- `DrawingToolbar.tsx`: `export function DrawingToolbar()` — vertical left toolbar: cursor, trendline, hline, hray, rect, fib, color picker, clear all. Active tool in store `ui.drawingTool`.

### C4 — App shell
Owns `client/src/main.tsx`, `client/src/App.tsx`, `client/src/components/**`, `client/src/api/ws.ts`, `client/src/styles.css`. May add actions to `client/src/state/store.ts`.
- `api/ws.ts`: `export const wsClient` — `connect()`, `subscribe(symbols)`, `unsubscribe(symbols)` (ref-counted by caller key), `on(type, cb): () => void`, auto-reconnect and resubscribe.
- Layout: top bar (SymbolSearch, timeframe buttons, chart type menu, Indicators button → `IndicatorDialog`, log scale toggle, theme toggle, settings gear, upstream status dot); left `DrawingToolbar`; center `ChartView` + `IndicatorLayer` + `DrawingLayer`; right sidebar tabs: Watchlist, Alerts.
- `SettingsDialog`: shows `ConfigView`, input for a new EODHD key → `PUT /api/config`, shows validation errors and plan info.
- Watchlist panel (multiple lists, add via search, remove, reorder by drag, live quotes from `quote`/`tick`), Alerts panel (list/create/toggle/delete, history), toasts + `Notification` API on `alert` messages.
- Loads layout on boot, debounced save on change.
- TradingView-like dark UI, keyboard: typing a letter on the chart opens symbol search, Esc closes dialogs.

## Rules for every module agent
- Touch only the files you own (plus new files inside your directories). Do not edit other modules' files; if you need something from another module, code against the contract above and note it in your report.
- TypeScript strict. Import shared types from `@eodview/shared`.
- Server code uses Bun APIs only (no express, no node-fetch). Client uses React 19 function components + Zustand.
- Pure logic gets `bun test` tests next to it (`*.test.ts`).
- Do not commit; the lead commits after integration.

---

# v2 modules (range bar, details, screener)

New contract types are in `shared/src/types.ts` under "v2". Lead-written glue for v2:
- `server/src/eodhd/factory.ts`: `eodhd.raw(path, params?, what?)` for any EODHD endpoint (key injected, errors mapped, in-flight dedupe).
- `server/src/fundamentals/store.ts`: `getFundamentals(symbol, maxAgeSec)`, `refreshFundamentals(symbol)`, `getCachedFundamentals(symbol)` — shared SQLite cache of raw fundamentals JSON. Use it; don't create another fundamentals cache.
- `server/src/universe/metricsSchema.ts`: the `universe_metrics` column contract between pipeline (writer) and screener (reader). Do not edit; if you need a column, report it.
- `server/src/index.ts` registers `routes/details.ts`, `routes/screener.ts`, `routes/universe.ts` (each `register(router)`) and calls `startUniverseScheduler()` from `universe/scheduler.ts` (skipped when `EODVIEW_UNIVERSE=off`).
- Client: `ui.page` ("chart" | "screener", synced to `#/chart` / `#/screener` by `components/usePageRoute.ts`), TopBar Chart/Screener nav, `ui.sidebarTab` gains "details". Slots with placeholder components: `client/src/chart/ChartBottomBar.tsx`, `client/src/details/DetailsPanel.tsx`, `client/src/screener/ScreenerPage.tsx` — replace them.

### S3 — Universe pipeline
Owns `server/src/universe/**` (not metricsSchema.ts), `server/src/routes/universe.ts`.
Tables: `universe_symbols`, `universe_bars(symbol, date, open, high, low, close, adj_close, volume)`, `universe_metrics` (from METRIC_COLUMNS), job state, credit ledger. Jobs: symbols, prices, backfill, fundamentals, indices, earnings, news, metrics. Export `startUniverseScheduler()`, `universeStatus(): UniverseStatus`, `runJob(name)`, and `getSparklines(symbols, days): Record<Symbol, number[]>` (closes from universe_bars) for the screener.

### S4 — Screener API
Owns `server/src/screener/**`, `server/src/routes/screener.ts`.
Finviz-vocabulary filter registry → SQL over `universe_metrics` (whitelisted columns only, parameters bound), views/columns, presets table, `GET /api/screener/sparklines?symbols=A,B&days=60 -> Record<Symbol, number[]>` (via universe `getSparklines`). `ScreenerMeta.universe` from `universeStatus()`.

### S5 — Symbol details API + adjusted toggle
Owns `server/src/details/**`, `server/src/routes/details.ts`; may edit `server/src/cache/**` and `server/src/eodhd/mappers.ts` for the `adj` flag.
Overview (fundamentals + real-time quote + `/us-quote-delayed` extended hours + news), news, chart events (earnings from Earnings.History, dividends `/div`, splits `/splits`), logo proxy `GET /api/symbols/:symbol/logo` (cached on disk, 404 → client falls back to a letter avatar). `/api/bars` gains `adj=0|1`.

### C5 — Chart range bar & chart enhancements
Owns `client/src/chart/**` (incl. ChartBottomBar.tsx, ChartView.tsx, datafeed.ts). May remove the log toggle from `components/TopBar.tsx` (it moves to the bottom bar) — no other TopBar edits.

### C6 — Details panel
Owns `client/src/details/**`.

### C7 — Screener page
Owns `client/src/screener/**`.

---

# v3 modules (multi-market, per-ticker history, agent API)

Contract additions: `shared/src/types.ts` "v3" section, `ScreenerQuery.market`, `ScreenerMeta.markets/market`, `ScreenerFilterDef.code`.

### P — Pipeline (multi-market + per-ticker history)
Owns `server/src/universe/**` **including metricsSchema.ts** (now the pipeline owner may add columns: `market`, `market_cap_usd`, `dollar_volume_usd`, `price_usd`, `perf_3y`, `perf_5y`, `ath`, `ath_date`, `ath_pct`, `atl_pct`, `fx_to_usd`, …), `server/src/routes/universe.ts`. Exports `listMarkets(): MarketInfo[]`, `marketCoverage(market): Record<column, fraction non-null>` for the screener.
Market config in `server/src/universe/markets.ts` (code, name, country, currency, timezone, session hours, symbol-list filter, index codes, enabled). Enabled set from `EODVIEW_MARKETS` env / config, default decided by docs/MARKET-STUDY.md.

### Q — Screener API v3
Owns `server/src/screener/**`, `server/src/routes/screener.ts`: market param, per-market availability from coverage, Finviz URL codes, new filters/columns for the new metrics (All-Time High/Low, 3Y/5Y performance, Market, Currency, USD market cap / dollar volume).

### A — Agent API
Owns `server/src/agentapi/**`, `server/src/routes/agent.ts`, `server/src/routes/tokens.ts`, `docs/AGENT-API.md`, and may add dependencies to `server/package.json`. `/api/v1/*`, `/api/openapi.json`, `/mcp`, tokens. Lead wires `register(router)` of routes/agent.ts and routes/tokens.ts in index.ts (the integrator does it if missing).

### U — Client
Owns `client/src/screener/**` and `client/src/components/SettingsDialog.tsx` (API token management section).
