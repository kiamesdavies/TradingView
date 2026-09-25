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

New in v2:

- **Range bar under the chart**: 1D, 5D, 1M, 3M, 6M, YTD, 1Y, 5Y and All presets that pick the interval and the
  visible range, a go-to-date popover, a clock with a time zone menu (UTC, exchange, local or a named zone), and
  ADJ (split/dividend-adjusted daily bars on or off), % and log price scales and price autoscale. Earnings,
  dividend and split markers (E/D/S) on daily and longer charts, including the next earnings date.
- **Details tab** in the sidebar, like TradingView's symbol panel: logo, price with the pre/post-market line,
  latest news, key stats, an EPS/revenue chart with estimates, analyst ratings and the company profile.
- **Screener page** with Finviz-style filters (Descriptive, Fundamental, Technical, News, ETF), Finviz views
  (Overview, Valuation, Financial, Ownership, Performance, Technical, ETF, Charts), sorting, paging, saved presets
  and CSV export. It runs on a local copy of the whole US market that a background pipeline builds (see below).

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

## Screener data pipeline

The screener does not query EODHD per request. A background job loop in the server (`server/src/universe/`)
keeps a table with one row of metrics per US stock and ETF (about 11,000 symbols) in the SQLite database:

| Job | What it does | Cost (API credits) |
|---|---|---|
| `symbols` | US stock and ETF list (weekly) | ~1 |
| `prices` | Latest session for every symbol from the bulk EOD file, plus that day's splits and dividends; re-downloads the history of symbols that split or paid a dividend | ~300 per session + 1 per re-download |
| `backfill` | One bulk file per missing past session until `EODVIEW_HISTORY_DAYS` sessions are stored | 100 per session |
| `earnings` | Earnings calendar (daily) | ~1 |
| `indices` | S&P 500, Nasdaq-100 and Dow membership (weekly) | ~30 |
| `news` | Latest news across all tickers, for the News filter (every 2 hours) | 5 per 250 articles, up to 40 per run |
| `fundamentals` | Per-symbol fundamentals, most-traded symbols first, refreshed on a rolling basis | 10 per symbol |
| `metrics` | Recomputes the metrics table (technicals, performance, valuation…) | none |

**First run.** With the defaults (`EODVIEW_HISTORY_DAYS=300`) the first build takes roughly
300 × 100 = 30,000 credits for price history and 10 credits per symbol for fundamentals, so on a 100,000/day plan it
spreads over about two days: prices and technicals are ready within the first hour (the backfill fetches about one
session every 3 s), fundamentals fill in gradually (about 10 symbols per second while the daily budget lasts). The
screener works throughout; filters whose data has not been collected yet are shown as unavailable. After that the
daily upkeep is a few thousand credits.

**Credit budget.** Before every paid request the pipeline checks two limits and pauses until 00:00 UTC when either
is reached ("budget exhausted, resumes …" in the job status):

- its own usage today must stay under `EODVIEW_DAILY_CREDIT_BUDGET` (default 40,000), and
- the account's total usage (EODHD `/api/user`, checked at most every 5 minutes) must stay below the plan's daily
  limit minus `EODVIEW_CREDIT_RESERVE` (default 15,000), leaving room for charts and your other tools.

Set `EODVIEW_UNIVERSE=off` to disable the loop (the screener then shows whatever is already stored; jobs can still be
started by hand). Job status: `GET /api/universe/status`; run one job now: `POST /api/universe/jobs/<name>/run`
(localhost only, like `/api/config`).

## New API endpoints (v2)

| Endpoint | Purpose |
|---|---|
| `GET /api/bars?…&adj=0\|1` | `adj=0` returns unadjusted daily/weekly/monthly bars (default adjusted) |
| `GET /api/symbols/:symbol/overview` | Details panel data: profile, quote, extended-hours quote, key stats, earnings, revenue, analyst ratings, latest news |
| `GET /api/symbols/:symbol/news?limit=` | News for one symbol (1–50, default 20) |
| `GET /api/symbols/:symbol/events?from&to` | Earnings, dividend and split markers (unix seconds) |
| `GET /api/symbols/:symbol/logo` | Company logo (cached on disk) |
| `GET /api/screener/meta` | Filters with their options, columns, views and the pipeline status |
| `POST /api/screener/query` | Run a screen: filters, universe, view, sort, offset, limit |
| `GET/POST /api/screener/presets`, `PUT/DELETE /api/screener/presets/:id` | Saved screens |
| `GET /api/screener/sparklines?symbols=A,B&days=60` | Closing prices for the Charts view |
| `GET /api/universe/status`, `POST /api/universe/jobs/:name/run` | Pipeline status and manual runs |

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
| `EODVIEW_UNIVERSE` | on | `off` disables the screener's background pipeline |
| `EODVIEW_HISTORY_DAYS` | `300` | Sessions of daily history the pipeline keeps for every symbol (SMA200 and 52-week metrics need about 260) |
| `EODVIEW_DAILY_CREDIT_BUDGET` | `40000` | Maximum EODHD credits the pipeline spends per UTC day |
| `EODVIEW_CREDIT_RESERVE` | `15000` | Credits of the plan's daily limit the pipeline never touches |
| `EODVIEW_API_PORT` | `3001` | Dev only: the server port the Vite dev server proxies `/api` and `/ws` to |

## Scripts (repo root)

| Script | What it does |
|---|---|
| `bun run dev` | Starts the server with `bun --watch` on :3001 and Vite on :5173. Vite proxies `/api` and `/ws` to the server. |
| `bun run build` | Runs the Vite production build into `client/dist` |
| `bun run start` | Starts the production server, which also serves `client/dist` when it exists |
| `bun test` | Runs every unit test: indicator math, aggregation, EODHD mapping, the bar cache, config, alerts, realtime, stores, candles, drawings geometry, the WebSocket client, and (v2) the universe pipeline, screener filters/SQL, details API, range bar and screener UI helpers |
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
  - `universe/`: the screener's background pipeline and metrics table; `screener/`: filter registry, SQL
    builder, views and presets; `details/`, `fundamentals/`: the details panel API and the shared fundamentals cache.
- `client/src`:
  - `chart/`: chart core and the range bar.
  - `details/`: the Details sidebar tab; `screener/`: the screener page.
  - `indicators/`: indicator layer and dialog.
  - `drawings/`: drawing tools.
  - `components/`, `App.tsx`: app shell.
  - `api/`: HTTP and WebSocket clients.

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full requirements and the module contract.

## Known limitations

- **Screener data.**
  - Metrics that need long history (SMA50/200, 52-week range from stored bars, 13/26-week performance) fill in
    as the backfill proceeds; until then 52-week high/low and average volume come from the bulk file.
  - Not available from EODHD: optionable/shortable flags, chart patterns, all-time high/low, ETF tags, fund flows and
    active/passive. These filters are shown disabled. There is no Russell 2000 index option.
  - Some values are approximations: 5-year EPS growth is derived from P/E and PEG; 3-year dividend growth from
    dividends paid; "Yesterday before/after market" uses the next report's timing.
  - ETFs have no market cap (use the AUM filter). EODHD reports 0 net margin for some loss-making companies.
- **Details panel.** Extended-hours rules don't model market holidays. Forex, crypto and indices show only the
  price and volume.
- **Range bar.** On intraday charts in a non-UTC zone, lightweight-charts still places day/month tick marks on UTC
  boundaries (labels are in the chosen zone). 1D/5D ignore holidays. Only the next upcoming earnings is marked.

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
