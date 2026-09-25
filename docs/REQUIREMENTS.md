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
