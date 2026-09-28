# Configuration & reference

Everything you can configure in EODView, plus the REST surface and the screener's data pipeline.
For the agent API (REST v1 + MCP) see [AGENT-API.md](AGENT-API.md); for hosting see [../deploy/README.md](../deploy/README.md).

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

**Who can use the config endpoints.** `GET/PUT /api/config` (and the other admin endpoints: API tokens, universe
jobs and markets) only answer loopback callers whose `Host` header is also a loopback name and that carry no proxy
header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`). If you set `EODVIEW_ADMIN_TOKEN`,
they instead require `Authorization: Bearer <token>`; the Settings dialog then shows a field for the token.
Behind a reverse proxy on the same machine, set `EODVIEW_ADMIN_TOKEN`: nginx forwards requests from `127.0.0.1` with
`Host: 127.0.0.1:3001` and no proxy header by default, which would otherwise look local (see
[AGENT-API.md](AGENT-API.md#authentication-and-tokens)).

**Cross-site protection.** `/ws` upgrades and every POST/PUT/DELETE under `/api` are refused (403) when the
browser's `Origin` is not the server's own origin, a loopback origin (such as the Vite dev server on :5173) or listed
in `EODVIEW_ALLOWED_ORIGINS`. JSON request bodies must be sent as `Content-Type: application/json` (415 otherwise).
Clients that send no `Origin` (curl, scripts) are not affected.

## Screener data pipeline

The screener does not query EODHD per request. A background job loop in the server (`server/src/universe/`)
keeps a table with one row of metrics per stock/ETF in every enabled market, in the SQLite database.

**Markets.** Default: `US, AU, TW, OL, XETRA, ST` — the tier-1 momentum markets from
[MARKET-STUDY.md](MARKET-STUDY.md) plus Stockholm. Override with `EODVIEW_MARKETS=US,ST,TO` (any code in
`server/src/universe/markets.ts`: US, TO, V, LSE, XETRA, PA, AS, ST, OL, CO, HE, SW, MC, AU, KO, KQ, TW, TWO, HK).
Each market runs on its own time zone and close time; prices are converted to USD (`*_usd` columns, London pence
handled) so size and liquidity filters compare across markets. Filters are greyed out per market when less than 15% of
that market's symbols have the data (e.g. short float, insider and institutional data are US-only).

| Job | What it does | Cost (API credits) |
|---|---|---|
| `symbols:<M>` | Stock/ETF list per market (weekly) | ~1 each |
| `prices:<M>` | Latest session for every symbol from the market's bulk EOD file, ~2.5 h after its close; plus splits/dividends and re-downloads of affected histories | 100 per market-session (+200 for US splits/dividends) + 1 per re-download |
| `backfill:<M>` | Full history once per symbol via `/eod/<symbol>` (1 credit however long): all-time high/low from the full history, the last `EODVIEW_HISTORY_YEARS` years stored. Markets not in `EODVIEW_ACTIONS_BULK_MARKETS` re-fetch every history once per 60 days, spread evenly over the days, so splits and dividends the daily check cannot see get restated | 1 per symbol (+ 1/60 of the market per day) |
| `fx` | Currency → USD rates for enabled markets (daily) | 1 per currency |
| `earnings` | Earnings calendar (daily) | ~1 |
| `indices:<M>` | Index membership (S&P 500, Nasdaq-100, Dow, OMXS30, …; weekly) | 10 per index |
| `news` | Latest news across all tickers, for the News filter (every 2 hours) | 5 per 250 articles |
| `fundamentals` | Per-symbol fundamentals, highest USD dollar volume first across markets, rolling refresh; at most `EODVIEW_FUNDAMENTALS_MAX_PER_RUN` per run, then a 1 h pause. A symbol that fails (5xx, timeout, plan limit) backs off on its own (1 h, doubling, up to 7 days); only key, rate-limit or connectivity errors stop the job | 10 per symbol |
| `metrics` | Recomputes the metrics table (technicals, performance, ATH, valuation, USD columns…) | none |

**First run.** Symbols, latest prices, earnings dates and index membership are ready within minutes. The per-ticker
backfill is ~1 credit per symbol (US ≈ 11.4k, all six default markets ≈ 17k) and runs at ≤ 800 requests/min, so
about 20–30 minutes. Fundamentals are the expensive part (10 credits × ~10k stocks): they fill in over 2–3 days
within the daily budget. The screener works throughout; filters without enough data yet are shown as unavailable.
Steady-state upkeep is roughly 10–15k credits a day.

**Credit budget.** Before every paid request the pipeline checks two limits and pauses until 00:00 UTC when either
is reached ("budget exhausted, resumes …" in the job status):

- its own usage today must stay under `EODVIEW_DAILY_CREDIT_BUDGET` (default 40,000), and
- the account's total usage (EODHD `/api/user`, checked at most every 5 minutes) must stay below the plan's daily
  limit minus `EODVIEW_CREDIT_RESERVE` (default 15,000), leaving room for charts and your other tools.

The background jobs `backfill` and `fundamentals` stop another `EODVIEW_JOB_CREDIT_RESERVE` credits (default 3,000)
short of both limits, so the daily prices, splits/dividends and FX jobs always have room. Agent API calls to EODHD are
recorded in the same ledger (see the Agent API section).

A bulk session with clearly fewer rows than the previous one is re-downloaded hourly, at most 3 times, then accepted.
Markets without the bulk splits/dividends feed detect splits from the day's price change against the market's median
move: moves beyond −45%/+80%, or close to a 5:4, 4:3 or 3:2 ratio (or the reverse), trigger a history re-download.

Set `EODVIEW_UNIVERSE=off` to disable the loop (the screener then shows whatever is already stored; jobs can still be
started by hand). Job status: `GET /api/universe/status`; run one job now: `POST /api/universe/jobs/<name>/run`
(localhost only, like `/api/config`).

## REST endpoints (beyond the v1 chart API)

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
| `EODVIEW_MARKETS` | `US,AU,TW,OL,XETRA,ST` | Markets the screener pipeline tracks |
| `EODVIEW_HISTORY_YEARS` | `5` | Years of daily history stored per symbol (3Y/5Y performance need ≥ 3/5) |
| `EODVIEW_BACKFILL_MAX_SYMBOLS` | none | Testing: cap backfilled symbols per market |
| `EODVIEW_FUNDAMENTALS_MAX_PER_RUN` | `500` | Fundamentals fetched per run before a 1 h pause |
| `EODVIEW_RATE_PER_MIN` / `EODVIEW_CONCURRENCY` | `800` / `8` | Request rate and parallelism of the per-ticker backfill |
| `EODVIEW_ACTIONS_BULK_MARKETS` | `US` | Markets whose splits/dividends come from EODHD's bulk lists |
| `EODVIEW_API_TOKENS` | none | Comma-separated bearer tokens for the agent API (in addition to tokens created in Settings) |
| `EODVIEW_API_REQUIRE_TOKEN` | unset | Set to `1` to require a token even for callers on this machine |
| `EODVIEW_API_RATE_LIMIT` | `120` | Agent API requests per minute per token |
| `EODVIEW_API_LOOPBACK_RATE_LIMIT` | `600` | Agent API requests per minute from this machine (all loopback callers together) |
| `EODVIEW_AGENT_CREDIT_BUDGET` | `5000` | EODHD credits agent requests may spend per UTC day (overview, news, remote search…) |
| `EODVIEW_DAILY_CREDIT_BUDGET` | `40000` | Maximum EODHD credits the pipeline spends per UTC day |
| `EODVIEW_CREDIT_RESERVE` | `15000` | Credits of the plan's daily limit the pipeline never touches |
| `EODVIEW_JOB_CREDIT_RESERVE` | `3000` | Credits `backfill` and `fundamentals` leave unused for the daily prices/actions/FX jobs |
| `EODVIEW_API_PORT` | `3001` | Dev only: the server port the Vite dev server proxies `/api`, `/ws` and `/mcp` to |

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

See [REQUIREMENTS.md](REQUIREMENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md)
for the full requirements and the module contract.
