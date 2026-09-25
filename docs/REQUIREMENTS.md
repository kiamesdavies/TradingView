# EODView — Requirements

A self-hosted TradingView replacement for personal swing trading, backed by EODHD.

## Decisions (defaults — change here if needed)
| Area | Choice |
|---|---|
| Architecture | Client/server. Browser never sees the EODHD key. |
| Backend | Bun (`Bun.serve`, `bun:sqlite`, native WebSocket), TypeScript, no framework |
| Frontend | React 19 + Vite + TypeScript, Zustand state |
| Charts | `lightweight-charts` v5 (panes, series primitives for drawings) |
| Storage | SQLite file `server/data/eodview.db` (settings, watchlists, drawings, alerts, OHLCV cache) |
| Live data | Server holds EODHD WebSocket(s), fans out ticks to browsers over `/ws` |

## Functional requirements

### F1 Charting
- Candlestick, bar, line, area, Heikin-Ashi chart types; volume histogram overlay.
- Timeframes: 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
- Load more history when scrolled to the left edge (lazy backfill).
- Crosshair legend showing O/H/L/C/V and change for the hovered bar.
- Log/percent price scale toggle; dark and light theme.
- Current candle updates live from streamed ticks (US stocks, forex, crypto).

### F2 Symbols
- Symbol search box (EODHD search API) with exchange and type shown; keyboard navigation.
- Symbols use EODHD format `TICKER.EXCHANGE` (e.g. `AAPL.US`, `EURUSD.FOREX`, `BTC-USD.CC`).
- Recent symbols remembered.

### F3 Indicators
- Overlays: SMA, EMA, VWAP, Bollinger Bands.
- Separate panes: RSI, MACD, ATR, Volume MA.
- Add/remove/configure (period, source, color); several instances allowed.
- Computed client-side from loaded bars and recomputed on live updates.

### F4 Drawing tools
- Trendline, horizontal line, horizontal ray, rectangle, Fibonacci retracement.
- Select, drag handles, delete (Del key), change color.
- Persisted per symbol on the server; restored on load.

### F5 Watchlists
- Multiple named lists; add/remove/reorder symbols.
- Columns: symbol, last, change, change %, volume; live updates.
- Click a row to load that symbol on the chart.

### F6 Price alerts
- Create alerts at a price (crossing up / down / either), from the UI or by right-clicking the chart.
- Evaluated on the server against streamed ticks (and a polling fallback for symbols without streaming).
- On trigger: stored in history, pushed over `/ws`, shown as a browser notification plus toast.
- One-shot or repeating; drawn on the chart as a dashed line.

### F7 Configuration (backend)
- EODHD API key resolution order: `server/data/config.json` → `EODHD_API_KEY` env var → none.
- `GET /api/config` returns masked key, source, plan info. `PUT /api/config` sets a new key, validates it against EODHD `/api/user`, persists to `config.json`, and hot-reloads the REST client and WebSocket connections without a restart.
- CLI: `bun run server/src/cli.ts set-key <KEY>`.
- Settings dialog in the UI calls the same endpoint.
- Config endpoints accept only localhost callers unless `EODVIEW_ADMIN_TOKEN` is set, in which case they require `Authorization: Bearer <token>`.
- Other settings: port (`PORT`, default 3001), cache TTLs.

### F8 Layout persistence
- Last symbol, timeframe, chart type, indicators and theme persisted server-side and restored on reload.

## Non-functional
- EODHD call budget: cache daily bars in SQLite (refresh only the tail); intraday cached with a short TTL; de-duplicate in-flight requests.
- One upstream WebSocket subscription per symbol no matter how many browser tabs watch it; unsubscribe when nobody watches.
- Reconnect with backoff on both sides.
- `bun test` covers indicator math, aggregation, EODHD response mapping, alert evaluation.
- `bun run dev` starts server and Vite client together; `bun run build && bun run start` serves the built client from the Bun server.

## Out of scope for v1
Screener, fundamentals panel, news, multi-chart layouts, Pine-like scripting, paper trading, auth for multiple users.

---

# v2 additions (2026-09-25)

User feedback on v1: no way to pick a date range like TradingView's bottom bar; no fundamentals (earnings especially); wants a Finviz-style screener page.

### F9 Range bar (below the chart, TradingView style)
- Range presets 1D 5D 1M 3M 6M YTD 1Y 5Y All. Each switches to TradingView's matching interval (1D→1m, 5D→5m, 1M→30m, 3M→1h, 6M→4h, YTD/1Y→D, 5Y→W, All→M), loads enough history and fits the visible range.
- Go-to-date button (calendar icon): pick a date (or from–to range); history is loaded back to it and the chart scrolls there.
- Live clock in the selected time zone (click → choose UTC, exchange time, local, or a common IANA zone); the time axis uses the same zone.
- Toggles on the right: ADJ (split/dividend-adjusted daily data), % (percentage scale), log, auto (autoscale).
- Chart event markers: E (earnings, with EPS vs estimate tooltip), D (dividends), S (splits); upcoming earnings shown at the right edge.

### F10 Symbol details (right sidebar "Details" tab, like TradingView's symbol panel)
- Logo, ticker, full name, exchange, sector • industry.
- Regular-session price/change and a pre-market / post-market line from EODHD extended-hours quotes.
- Latest news card (click → article; "More news" list).
- Key stats: next earnings (in N days), volume, avg volume 30D, market cap; expand for P/E, fwd P/E, EPS TTM, dividend yield, beta, 52W range, shares float, short % float, employees, etc.
- Earnings chart: last quarters' EPS actual (filled; green beat / red miss) vs estimate (hollow), next quarter's estimate; EPS/Revenue toggle.
- Analyst consensus bar + price target; company profile.

### F11 Screener page (Finviz-style)
- Separate page (Chart | Screener nav, `#/screener`).
- Filter panel with Finviz's tabs (Descriptive, Fundamental, Technical, News, ETF, All) and grid of dropdowns using Finviz's option vocabulary ("Over 10", "Price above SMA50", "New High", "Today Before Market Open"…), plus "Custom…" min/max for numeric filters. Filters that can't be computed from EODHD data are shown disabled with a reason.
- Result views: Overview, Valuation, Financial, Ownership, Performance, Technical, ETF, Charts (mini-chart grid). Sortable columns, paging, CSV export, ticker click opens the chart.
- Saved presets (server side).
- Data: a local universe DB (US listed common stocks + ETFs, ~11k symbols) built by a background pipeline from EODHD bulk end-of-day (all symbols per call), per-ticker fundamentals (rolling refresh within a daily API-credit budget; bulk fundamentals is not on the user's plan), earnings calendar, index constituents, news. Technical metrics are computed locally from stored daily history.
- The pipeline respects `EODVIEW_DAILY_CREDIT_BUDGET` (default 40000 of the plan's 100000/day) and stops when the account's daily usage nears the limit; status and progress visible on the screener page.
