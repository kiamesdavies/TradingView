# EODView

A self-hosted, TradingView-style charting app for personal swing trading, backed by
[EODHD](https://eodhd.com) market data. A Bun server holds the EODHD API key, caches bars in
SQLite and fans out live ticks over a WebSocket. A React + lightweight-charts v5 client shows the
charts. The browser never sees the key.

Features: candles, bars, line, area and Heikin-Ashi charts; 1m to 1M timeframes with lazy
backfill; live candles from streamed ticks (US stocks, forex, crypto); SMA, EMA, VWAP, Bollinger
Bands, RSI, MACD, ATR and Volume MA; trendline, horizontal line and ray, rectangle and Fibonacci
drawings saved per symbol; multiple watchlists with live quotes; server-side price alerts with
toasts and browser notifications; layout saved on the server.

## Quick start

Requires [Bun](https://bun.sh) 1.1.36 or newer. Node is used only by Vite, which Bun runs for you.

```sh
bun install
bun run dev          # Bun server on :3001 and the Vite dev server on :5173
```

Open http://localhost:5173. If no API key is configured, the Settings dialog opens by itself.

Production (a single process that serves the built client, the API and the WebSocket):

```sh
bun run build        # builds client/dist
PORT=3001 bun run start
```

Then open http://localhost:3001.

## Setting the EODHD API key

The server looks for the key in this order:

1. `server/data/config.json` (written by the Settings dialog or the CLI)
2. the `EODHD_API_KEY` environment variable
3. none: the app runs, but data routes return 503 and the UI asks for a key

Ways to set it:

- **Settings UI**: click the gear, paste the key, then save. The server checks the key against
  EODHD `/api/user` before it saves it. An invalid key gets a 400 and nothing is written. REST
  calls and WebSocket feeds pick up the new key without a restart.
- **CLI**:
  ```sh
  bun run server/src/cli.ts set-key -      # reads the key from stdin, so it stays out of shell history
  bun run server/src/cli.ts set-key <KEY>
  bun run server/src/cli.ts show           # masked key, source and plan usage
  bun run server/src/cli.ts clear-key      # remove it from config.json; EODHD_API_KEY is used again if set
  ```
  A running server notices changes to `config.json` within about 2 seconds.
- **Environment**: `EODHD_API_KEY=... bun run start`.

`config.json` is written with mode 0600. `server/data/` is in `.gitignore`.

**Who can use the config endpoints.** `GET/PUT /api/config` only answer loopback callers whose
`Host` header is also a loopback name. If you set `EODVIEW_ADMIN_TOKEN`, they instead require
`Authorization: Bearer <token>`; the Settings dialog then shows a field for the token.

**Cross-site protection.** `/ws` upgrades and every POST/PUT/DELETE under `/api` are refused (403) when the
browser's `Origin` is not the server's own origin, a loopback origin (such as the Vite dev server on :5173) or listed
in `EODVIEW_ALLOWED_ORIGINS`. JSON request bodies must be sent as `Content-Type: application/json` (415 otherwise).
Clients that send no `Origin` (curl, scripts) are not affected.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server port |
| `EODHD_API_KEY` | none | API key, used when `config.json` has none |
| `EODVIEW_DATA_DIR` | `server/data` | Location of the SQLite database and `config.json` |
| `EODVIEW_ADMIN_TOKEN` | none | Require a Bearer token for `/api/config` instead of localhost-only access |
| `EODVIEW_ALLOWED_ORIGINS` | none | Comma-separated extra browser origins (e.g. `http://mybox.lan:3001`) allowed to open `/ws` and send POST/PUT/DELETE to `/api` |
| `EODVIEW_DAILY_TTL` | `600` | Seconds before the tail of cached daily, weekly and monthly bars is refreshed |
| `EODVIEW_INTRADAY_TTL` | `60` | Cache time in seconds for the intraday window that contains now |
| `EODVIEW_INTRADAY_HISTORY_TTL` | `21600` | Cache time in seconds for older intraday windows |
| `EODVIEW_QUOTE_TTL` | `10` | Cache time in seconds for `/api/quotes` |

## Scripts (repo root)

| Script | What it does |
|---|---|
| `bun run dev` | Starts the server with `bun --watch` on :3001 and Vite on :5173. Vite proxies `/api` and `/ws` to the server. |
| `bun run build` | Runs the Vite production build into `client/dist` |
| `bun run start` | Starts the production server, which also serves `client/dist` when it exists |
| `bun test` | Runs every unit test: indicator math, aggregation, EODHD mapping, the bar cache, config, alerts, realtime, stores, candles, drawings geometry and the WebSocket client |
| `bun run typecheck` | Runs `tsc` on the server and the client |

## Architecture

```
browser (React 19 + Zustand + lightweight-charts v5)  --REST /api, WS /ws-->  Bun server  --HTTPS/WSS-->  EODHD
```

- `shared/src/types.ts` holds the contract between client and server: the REST routes, the
  WebSocket messages and the data shapes. `shared/src/indicators/` holds the indicator math.
- `server/src`:
  - `config/`, `eodhd/`, `cache/`: key handling, the EODHD client and the bar cache. Daily and
    longer bars are kept in SQLite and only their tail is refreshed. Intraday bars are cached in
    memory in fixed windows; 15m and 30m are built from 5m, and 4h from 1h.
  - `realtime/`: the hub that shares one upstream EODHD WebSocket subscription per symbol across
    every browser tab.
  - `alerts/`: alert storage and evaluation against ticks.
  - `store/`: layout, watchlists and drawings.
- `client/src`:
  - `chart/`: chart core.
  - `indicators/`: indicator layer and dialog.
  - `drawings/`: drawing tools.
  - `components/`, `App.tsx`: app shell.
  - `api/`: HTTP and WebSocket clients.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full requirements and the module contract.

## Known limitations

- **Stale 1m data.** EODHD's 1m history for some crypto pairs ends weeks in the past; BTC-USD.CC
  1m ends in July 2026, while 5m and up are current. The chart shows that old history, then a
  large jump to the first live candle. Use 5m or a higher timeframe for those symbols.
- **Intraday and daily prices can differ.** Daily bars are adjusted for splits and dividends, but
  intraday bars come from EODHD unadjusted. Intraday bars from before the last split or dividend
  won't line up with daily bars.
- **Backfill stops at long gaps.** Intraday backfill stops after 14 days with no data, so a longer
  gap in the middle of the history ends the history there.
- **Polling fallback.** Only symbols without a stream (indices, non-US exchanges) are polled
  (every 60 s). A streamable symbol whose feed is down, or not in your plan, only gets the
  snapshot sent when it is subscribed.
- **Alerts.** An alert needs two price observations before it can fire. Symbols with a class
  suffix such as `BRK-B.US` are sent upstream as-is; whether EODHD streams them under that name
  has not been checked.
- **Chart details.**
  - Only log scale is offered, not percent scale.
  - Past the end of the data, 1D time steps are calendar days, so weekends are not skipped.
  - Price precision is guessed from recent prices.
  - Indicator colors do not follow the light/dark theme.
  - Oscillator panes have no legend.
- **Drawings.**
  - There is no control for line width or style, and no snapping to OHLC values.
  - A rectangle is selected by its edges, not by clicking inside it.
  - If loading a symbol's drawings fails, edits to that symbol are not saved until the page is
    reloaded.
- **Single user.** There is no auth apart from the config guard. Don't expose the server to the
  internet without a reverse proxy that adds authentication.
