# EODView Agent API

EODView exposes its screener and market data to other programs and AI agents in two ways:

- **REST** under `/api/v1` (JSON, or CSV for screens), described by an OpenAPI 3.1 spec at `GET /api/openapi.json`.
- **MCP** (Model Context Protocol) at `POST /mcp` using the streamable HTTP transport, for Claude Code, Claude Desktop
  and other MCP clients.

Everything is read-only. Screens run against the local universe database that the background pipeline builds (see
the README), so **a screen costs no EODHD credits**, whether you run it once a day or every minute. Only the per-symbol
endpoints can call EODHD, and their results are cached (see [Cost](#cost-in-eodhd-credits)).

## Quick start

The server listens on `http://localhost:3001` by default. Callers on the same machine need no token.

```sh
# Momentum: mid caps and up, liquid, above the 50- and 200-day SMAs, up over 13 weeks; strongest 3-month performers first
curl 'http://localhost:3001/api/v1/screen?f=cap_midover,sh_avgvol_o500,ta_sma50_pa,ta_sma200_pa,ta_perf_13wup&o=-perf_3m&v=performance&limit=25'

# The same screen as CSV
curl 'http://localhost:3001/api/v1/screen?f=cap_midover,sh_avgvol_o500,ta_sma50_pa,ta_sma200_pa,ta_perf_13wup&o=-perf_3m&fmt=csv'

# New 52-week highs on above-normal volume
curl 'http://localhost:3001/api/v1/screen?f=ta_highlow52w_nh,sh_relvol_o1.5,sh_avgvol_o300&o=-rel_volume'

# Oversold large caps (RSI(14) under 30)
curl 'http://localhost:3001/api/v1/screen?f=cap_largeover,ta_rsi_os30&o=rsi14&v=technical'

# Earnings this week, S&P 500 only
curl 'http://localhost:3001/api/v1/screen?f=idx_sp500,earningsdate_thisweek&o=earnings_date'

# Custom ranges: price between $10 and $50, P/E at most 15
curl 'http://localhost:3001/api/v1/screen?f=sh_price_10to50,fa_pe_to15'

# Structured query (same body as the UI's ScreenerQuery; Finviz shorthands also accepted)
curl -X POST 'http://localhost:3001/api/v1/screen' -H 'content-type: application/json' \
  -d '{"f":"cap_midover,ta_sma50_pa","sort":"-perf_3m","view":"performance","limit":20}'

# What filters exist, and which ones have data in this market
curl 'http://localhost:3001/api/v1/filters?market=US'

# Per-symbol data
curl 'http://localhost:3001/api/v1/symbols/NVDA.US/overview'
curl 'http://localhost:3001/api/v1/symbols/NVDA.US/bars?tf=1D&limit=200&compact=1'
curl 'http://localhost:3001/api/v1/search?q=nvidia'
```

From another machine, add `-H "Authorization: Bearer $EODVIEW_TOKEN"` (see [Authentication](#authentication-and-tokens)).

## REST endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/v1/screen?f=&o=&v=&market=&universe=&tickers=&limit=&offset=&fmt=` | Screen result (below); `fmt=csv` for CSV |
| `POST /api/v1/screen[?fmt=csv]` body `ScreenerQuery` | Same |
| `GET /api/v1/filters?market=US` | `ScreenerMeta` + `asOf`: filters (with `code` and per-market `available`), columns, views, markets, universe status |
| `GET /api/v1/markets` | `{asOf, markets: MarketInfo[]}` |
| `GET /api/v1/universe/status?market=` | `UniverseStatus` + `market`, `asOf` |
| `GET /api/v1/search?q=&limit=&source=auto\|local\|remote` | `{q, source, asOf, count, results: SymbolInfo[]}` |
| `GET /api/v1/symbols/:symbol/overview` | `SymbolOverview` + `symbol`, `market`, `asOf` |
| `GET /api/v1/symbols/:symbol/bars?tf=1D&limit=500&to=&adj=1&compact=0` | `{symbol, market, tf, adjusted, asOf, count, hasMore, bars}`; `compact=1` gives `columns` + `rows` of `[date, open, high, low, close, volume]` |
| `GET /api/v1/symbols/:symbol/news?limit=20` | `{symbol, market, asOf, count, news: NewsItem[]}` |
| `GET /api/v1/symbols/:symbol/events?from=&to=` | `{symbol, market, asOf, count, events: ChartEvent[]}` (earnings, dividends, splits) |
| `GET /api/openapi.json` | OpenAPI 3.1 spec (no token needed) |

Symbols are `TICKER.EXCHANGE` (`AAPL.US`, `VOD.LSE`, `BTC-USD.CC`). A bare ticker means `.US`. `to`/`from` take unix
seconds or `YYYY-MM-DD`.

### Screen parameters

| Parameter | Meaning |
|---|---|
| `f` | Comma-separated Finviz filter codes: `<code>_<option>`. All filters must match (AND). `a\|b` inside one filter means either (OR), e.g. `sec_technology\|healthcare`. |
| custom ranges | `<code>_<min>to<max>` with either side optional (`sh_price_10to50`, `fa_pe_to15`, `sh_relvol_2to`) in the column's raw units: dollars, shares, percent points (5 = 5%). Write numbers out in full (`cap_2000000000to10000000000`). Date filters use `<code>_<YYYY-MM-DD>x<YYYY-MM-DD>`. |
| `o` | Sort column, `-` prefix for descending: `-perf_3m`, `market_cap`, `-rel_volume`. Finviz names work too (`-perf13w`, `-marketcap`, `-relativevolume`). Default `ticker`. |
| `v` | View (which columns come back): `overview` (default), `valuation`, `financial`, `ownership`, `performance`, `technical`, `etf`, or Finviz numbers `111`, `121`, `161`, `131`, `141`, `171`. |
| `market` | Market code from `/api/v1/markets` (`US`, …) or `ALL`. Default `US`. |
| `universe` | `stocks` (default), `etfs` (default when an `etf_*` filter is used) or `all`. |
| `tickers` (or `t`) | Restrict to these tickers: `AAPL,MSFT,NVDA`. |
| `limit`, `offset` | Paging; `limit` 1–500, default 50. |
| `fmt` | `json` (default) or `csv`. CSV responses carry `X-Total-Count` and `X-As-Of` headers. |

Screen result:

```json
{
  "market": "US", "universe": "stocks", "view": "performance",
  "f": "cap_midover,sh_avgvol_o500,ta_sma50_pa,ta_sma200_pa", "sort": "-perf_3m",
  "total": 425, "offset": 0, "limit": 3, "count": 3,
  "columns": ["symbol", "ticker", "perf_1w", "perf_1m", "perf_3m", "..."],
  "rows": [{ "symbol": "MRNA.US", "ticker": "MRNA", "perf_3m": 226.06, "...": "..." }],
  "asOf": "2026-09-24"
}
```

`asOf` is the last session in the universe database: screens are end-of-day data, not live quotes. `f` echoes the
filters that were applied, so an agent can check how its request was understood. Date-relative options (earnings,
IPO and news: "today", "this week", "after market close"…) use the selected market's own calendar day and close time
(e.g. Sydney for `market=AU`); `market=ALL` uses UTC days.

`POST /api/v1/screen` takes the UI's `ScreenerQuery` (`filters`, `market`, `universe`, `tickers`, `view`, `sort`,
`offset`, `limit`). For convenience `filters` may also contain code strings, `sort` may be a string like `"-perf_3m"`,
and `f`, `o`, `v` are accepted as in the query string.

### Errors

Errors are JSON `{"error": "...", "detail": "..."}` with a matching HTTP status: 400 bad parameters (the message names
the valid codes or columns), 401 missing or invalid token, 429 rate limit or agent credit budget spent (with `Retry-After`), 502/503 EODHD problems
or no API key configured.

## Authentication and tokens

- **Same machine**: requests from a loopback address with a loopback `Host` header (`localhost`, `127.0.0.1`, `[::1]`)
  and no proxy header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`) need no token. Set
  `EODVIEW_API_REQUIRE_TOKEN=1` to require a token for these too.
- **Everyone else**: `Authorization: Bearer <token>`. Tokens come from either
  - `EODVIEW_API_TOKENS`: a comma-separated list in the server's environment (at least 16 characters each), or
  - tokens created in Settings → API tokens, or with the API below. The server stores only a SHA-256 hash and the
    first 6 characters; the token itself is shown once.
- Tokens are read-only: they open `/api/v1/*` and `/mcp`, nothing else.
- Each token may make 120 requests per minute (`EODVIEW_API_RATE_LIMIT`, `0` = unlimited); loopback callers share
  600 per minute (`EODVIEW_API_LOOPBACK_RATE_LIMIT`). Every message of an MCP batch counts as one request, and a batch
  may hold at most 50 messages.
- EODHD calls made while serving agent requests (overview fundamentals, news, remote search, uncached bars…) are
  recorded in the pipeline's credit ledger and capped at 5,000 credits per UTC day (`EODVIEW_AGENT_CREDIT_BUDGET`;
  `0` = agents cannot trigger paid calls). Past the cap those calls answer 429 until midnight UTC; screens, filters,
  markets and local search keep working because they only read the local database.

Token management is guarded like `/api/config` (localhost only, or `Authorization: Bearer $EODVIEW_ADMIN_TOKEN` when
that variable is set):

```sh
curl -X POST http://localhost:3001/api/tokens -H 'content-type: application/json' -d '{"name":"research agent"}'
# → {"id":"…","name":"research agent","prefix":"qBA2Gp","createdAt":…,"lastUsedAt":null,"token":"qBA2Gp…"}
curl http://localhost:3001/api/tokens                 # list (no tokens, only prefixes and lastUsedAt)
curl -X DELETE http://localhost:3001/api/tokens/<id>  # revoke
```

To reach the server from other machines, bind it to your LAN or put it behind a reverse proxy, and use HTTPS if the
traffic leaves your network: a bearer token over plain HTTP can be read by anyone on the path.

**Behind a reverse proxy on the same host**, every request arrives from `127.0.0.1`, and some proxies also rewrite
`Host` to the upstream address: nginx does by default (`proxy_pass http://127.0.0.1:3001` sends
`Host: 127.0.0.1:3001`), as does Apache without `ProxyPreserveHost On`. The server treats any request that carries a
proxy header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `Via`) as remote, so it needs a token.
Caddy and Traefik add `X-Forwarded-For` by default. **nginx adds none of these unless you configure it**, so either
add them:

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

or, more robustly, set `EODVIEW_API_REQUIRE_TOKEN=1` and `EODVIEW_ADMIN_TOKEN` so that no request is trusted for being
local. The same applies to the Vite dev server if you start it with `--host`: it forwards requests from
`127.0.0.1` with the client's `Host` header and no proxy header.

## MCP

`POST /mcp` implements the MCP streamable HTTP transport (protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and
2024-11-05). The server is stateless: it answers every request with `application/json`, issues no session id and
opens no SSE stream (`GET /mcp` returns 405). Authentication is the same as for REST.

### Claude Code

```sh
# Same machine
claude mcp add --transport http eodview http://localhost:3001/mcp

# Another machine, with a token
claude mcp add --transport http eodview https://eodview.example.lan/mcp --header "Authorization: Bearer $EODVIEW_TOKEN"
```

### Other MCP clients

Clients that support remote HTTP servers take a URL and optional headers, for example:

```json
{
  "mcpServers": {
    "eodview": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that only speak stdio can go through a bridge such as `npx mcp-remote http://localhost:3001/mcp`
(add `--header "Authorization: Bearer <token>"` for remote servers).

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `screen` | `filters` (codes string, or a list of codes / `{id, value}` / `{id, min, max}`), `market`, `universe`, `tickers`, `sort`, `view`, `limit` (≤ 200, default 25), `offset`, `format` (`json`/`csv`) | Screen result as above (`csv` puts the rows in one CSV string, which uses fewer tokens) |
| `list_filters` | `market`, `group`, `query`, `available_only`, `include_options` | `{market, asOf, count, filters: [{id, code, label, group, appliesTo, available, reason?, custom?, options: [{code, label}]}]}` |
| `list_markets` | none | `{asOf, markets}` |
| `symbol_overview` | `symbol` | Profile, quote, extended hours, key stats, earnings, analyst consensus, latest news |
| `get_bars` | `symbol`, `tf` (default `1D`), `limit` (≤ 1000, default 200), `to`, `adjusted` | `{symbol, market, tf, asOf, columns, rows: [[date, o, h, l, c, v], …]}` |
| `symbol_news` | `symbol`, `limit` (≤ 50) | `{symbol, news: NewsItem[]}` |
| `search_symbols` | `query`, `limit`, `source` (`auto`/`local`/`remote`) | `{source, results: SymbolInfo[]}` |
| `universe_status` | `market` | Universe and pipeline status with `asOf` |

Every result is returned as JSON text and as `structuredContent`. Arguments that do not match a tool's schema (unknown
argument, `limit` out of range, missing `symbol`) produce a JSON-RPC `-32602` error. Semantic problems, such as an unknown
filter code or market, come back as a tool result with `isError: true` and a message that lists valid values, so the
model can correct itself.

### Example agent prompts

- "Use eodview to find US mid caps and larger that trade over 500K shares a day, sit above their 50- and 200-day
  moving averages and are up over the last 13 weeks. Sort by 3-month performance and show the top 20 with their 1-month
  and 3-month returns."
- "Screen for stocks reporting earnings this week that are within 5% of their 52-week high. For the top five by
  relative volume, get the overview and the last 60 daily bars, and summarise the setups."
- "Which technical filters are available on the LSE market? Then run a new-52-week-high screen there."
- "Check universe_status first. If the data is older than yesterday's close, tell me before screening."

## Cost in EODHD credits

| Call | Credits |
|---|---|
| `screen`, `filters`, `markets`, `universe/status`, `search` with `source=local` | none: reads the local database |
| `search` with `source=remote` (or `auto` with no local match) | 1 per uncached query |
| `bars` 1D/1W/1M | 1 per refresh of the cached tail (at most every 10 minutes per symbol); intraday more, cached 1 min to 6 h |
| `overview` | fundamentals 10 per symbol per 24 h, plus 1–2 for the live quote (cached 5–15 s), news 5 (cached 10 min) |
| `news` | 5 per uncached request (cached 10 min) |
| `events` | dividends and splits 1 each per symbol per 24 h (earnings come from the cached fundamentals) |

The universe pipeline's own spending (bulk prices, fundamentals) is capped by `EODVIEW_DAILY_CREDIT_BUDGET` and the
account reserve described in the README. Agent traffic spends only on per-symbol calls, capped at
`EODVIEW_AGENT_CREDIT_BUDGET` (default 5,000) per UTC day. That spend is recorded in the same ledger (job `agent`), so it
also counts toward the pipeline's daily budget. For example, 50 overviews a day cost at most about 50 × 17 = 850
credits.

## Filter code reference

Generated from the live filter registry with `bun run server/src/agentapi/gen-docs.ts`. Whether a filter is
`available` depends on the market's data coverage: check `GET /api/v1/filters?market=…` or `list_filters`. Options
listed as universe values (sector, industry, country, exchange, market, ETF category/sponsor) are slugs of the stored
values, e.g. `sec_technology`, `ind_semiconductors`, `geo_usa`.

#### Descriptive

| Code | Filter | Options (`<code>_<option>`) | Custom range |
|---|---|---|---|
| `exch` | Exchange | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `idx` | Index _(stocks)_ | `sp500` `ndx` `dji` |  |
| `sec` | Sector _(stocks)_ | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `ind` | Industry | `stocksonly` `exchangetradedfund` + universe values |  |
| `geo` | Country | `usa` `notusa` `asia` `europe` `latinamerica` `bric` + universe values |  |
| `cap` | Market Cap. _(stocks)_ | `mega` `large` `mid` `small` `micro` `nano` `largeover` `midover` `smallover` `microover` `largeunder` `midunder` `smallunder` `microunder` | `cap_<min>to<max>` (money) |
| `fa_div` | Dividend Yield | `none` `pos` `high` `veryhigh` `o1` `o2` `o3` `o4` `o5` `o6` `o7` `o8` `o9` `o10` | `fa_div_<min>to<max>` (pct) |
| `sh_short` | Float Short _(stocks)_ | `low` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `sh_short_<min>to<max>` (pct) |
| `an_recom` | Analyst Recom. _(stocks)_ | `strongbuy` `buybetter` `buy` `holdbetter` `hold` `holdworse` `sell` `sellworse` `strongsell` | `an_recom_<min>to<max>` (number) |
| `earningsdate` | Earnings Date _(stocks)_ | `today` `todaybefore` `todayafter` `tomorrow` `tomorrowbefore` `tomorrowafter` `yesterday` `yesterdaybefore` `yesterdayafter` `nextdays5` `prevdays5` `thisweek` `nextweek` `prevweek` `thismonth` | `earningsdate_<YYYY-MM-DD>x<YYYY-MM-DD>` (date) |
| `sh_avgvol` | Average Volume | `u50` `u100` `u500` `u750` `u1000` `o50` `o100` `o200` `o300` `o400` `o500` `o750` `o1000` `o2000` `100to500` `100to1000` `500to1000` `500to10000` | `sh_avgvol_<min>to<max>` (volume) |
| `sh_relvol` | Relative Volume | `o10` `o5` `o3` `o2` `o1.5` `o1` `o0.75` `o0.5` `o0.25` `u2` `u1.5` `u1` `u0.75` `u0.5` `u0.25` `u0.1` | `sh_relvol_<min>to<max>` (number) |
| `sh_curvol` | Current Volume | `u50` `u100` `u500` `u750` `u1000` `o0` `o50` `o100` `o200` `o300` `o400` `o500` `o750` `o1000` `o2000` `o5000` `o10000` `o20000` | `sh_curvol_<min>to<max>` (volume) |
| `sh_price` | Price $ | `u1` `u2` `u3` `u4` `u5` `u7` `u10` `u15` `u20` `u30` `u40` `u50` `o1` `o2` `o3` `o4` `o5` `o7` `o10` `o15` `o20` `o30` `o40` `o50` `o60` `o70` `o80` `o90` `o100` `1to5` `1to10` `1to20` `5to10` `5to20` `5to50` `10to20` `10to50` `20to50` `50to100` | `sh_price_<min>to<max>` (money) |
| `sh_dollarvol` | Dollar Volume | `u1` `o1` `o5` `o10` `o20` `o50` `o100` | `sh_dollarvol_<min>to<max>` (money) |
| `market` | Market | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `currency` | Currency | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `targetprice` | Target Price _(stocks)_ | `a50` `a40` `a30` `a20` `a10` `a5` `above` `below` `b5` `b10` `b20` `b30` `b40` `b50` | `targetprice_<min>to<max>` (pct) |
| `ipodate` | IPO Date | `today` `yesterday` `prevweek` `prevmonth` `prevquarter` `prevyear` `prev2yrs` `prev3yrs` `prev5yrs` `more1` `more5` `more10` `more15` `more20` `more25` | `ipodate_<YYYY-MM-DD>x<YYYY-MM-DD>` (date) |
| `sh_outstanding` | Shares Outstanding _(stocks)_ | `u1` `u5` `u10` `u20` `u50` `u100` `o1` `o2` `o5` `o10` `o20` `o50` `o100` `o200` `o500` `o1000` | `sh_outstanding_<min>to<max>` (volume) |
| `sh_float` | Float _(stocks)_ | `u1` `u5` `u10` `u20` `u50` `u100` `o1` `o2` `o5` `o10` `o20` `o50` `o100` `o200` `o500` `o1000` `u10p` `u20p` `u30p` `u40p` `u50p` `o50p` `o60p` `o70p` `o80p` `o90p` | `sh_float_<min>to<max>` (volume) |
| `employees` | Employees _(stocks)_ | `u10` `u50` `u100` `u500` `u1000` `u5000` `u10000` `o10` `o50` `o100` `o500` `o1000` `o5000` `o10000` `o50000` `o100000` | `employees_<min>to<max>` (number) |
| `sh_opt` | Option/Short _(stocks)_ | _unavailable: Optionable/shortable flags are not provided by EODHD_ |  |

#### Fundamental

| Code | Filter | Options (`<code>_<option>`) | Custom range |
|---|---|---|---|
| `fa_pe` | P/E _(stocks)_ | `low` `profitable` `high` `u5` `u10` `u15` `u20` `u25` `u30` `u35` `u40` `u45` `u50` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_pe_<min>to<max>` (number) |
| `fa_fpe` | Forward P/E _(stocks)_ | `low` `profitable` `high` `u5` `u10` `u15` `u20` `u25` `u30` `u35` `u40` `u45` `u50` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_fpe_<min>to<max>` (number) |
| `fa_peg` | PEG _(stocks)_ | `low` `high` `u1` `u2` `u3` `o1` `o2` `o3` | `fa_peg_<min>to<max>` (number) |
| `fa_ps` | P/S _(stocks)_ | `low` `high` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `o1` `o2` `o3` `o4` `o5` `o6` `o7` `o8` `o9` `o10` | `fa_ps_<min>to<max>` (number) |
| `fa_pb` | P/B _(stocks)_ | `low` `high` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `o1` `o2` `o3` `o4` `o5` `o6` `o7` `o8` `o9` `o10` | `fa_pb_<min>to<max>` (number) |
| `fa_pc` | Price/Cash _(stocks)_ | `low` `high` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `o1` `o2` `o3` `o4` `o5` `o6` `o7` `o8` `o9` `o10` `o20` `o30` `o40` `o50` | `fa_pc_<min>to<max>` (number) |
| `fa_pfcf` | Price/Free Cash Flow _(stocks)_ | `low` `high` `u5` `u10` `u15` `u20` `u25` `u30` `u35` `u40` `u45` `u50` `u60` `u70` `u80` `u90` `u100` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` `o60` `o70` `o80` `o90` `o100` | `fa_pfcf_<min>to<max>` (number) |
| `fa_evebitda` | EV/EBITDA _(stocks)_ | `neg` `low` `profitable` `high` `u5` `u10` `u15` `u20` `u25` `u30` `u35` `u40` `u45` `u50` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_evebitda_<min>to<max>` (number) |
| `fa_evsales` | EV/Sales _(stocks)_ | `neg` `low` `pos` `high` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `o1` `o2` `o3` `o4` `o5` `o6` `o7` `o8` `o9` `o10` | `fa_evsales_<min>to<max>` (number) |
| `fa_divgrowth` | Dividend Growth _(stocks)_ | `3ypos` `3yo5` `3yo10` `3yo15` `3yo20` `3yo25` `3yo30` `3yneg` | `fa_divgrowth_<min>to<max>` (pct) |
| `fa_epsyoy` | EPS Growth This Year _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_epsyoy_<min>to<max>` (pct) |
| `fa_epsyoy1` | EPS Growth Next Year _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_epsyoy1_<min>to<max>` (pct) |
| `fa_epsqoq` | EPS Growth Qtr Over Qtr _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_epsqoq_<min>to<max>` (pct) |
| `fa_epsyoyttm` | EPS Growth TTM _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_epsyoyttm_<min>to<max>` (pct) |
| `fa_eps3years` | EPS Growth Past 3 Years _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_eps3years_<min>to<max>` (pct) |
| `fa_eps5years` | EPS Growth Past 5 Years _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_eps5years_<min>to<max>` (pct) |
| `fa_estltgrowth` | EPS Growth Next 5 Years _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_estltgrowth_<min>to<max>` (pct) |
| `fa_salesqoq` | Sales Growth Qtr Over Qtr _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_salesqoq_<min>to<max>` (pct) |
| `fa_salesyoyttm` | Sales Growth TTM _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_salesyoyttm_<min>to<max>` (pct) |
| `fa_sales3years` | Sales Growth Past 3 Years _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_sales3years_<min>to<max>` (pct) |
| `fa_sales5years` | Sales Growth Past 5 Years _(stocks)_ | `neg` `pos` `poslow` `high` `u5` `u10` `u15` `u20` `u25` `u30` `o5` `o10` `o15` `o20` `o25` `o30` | `fa_sales5years_<min>to<max>` (pct) |
| `fa_epsrev` | Earnings & Revenue Surprise _(stocks)_ | `ep` `em` `en` `eo5` `eo10` `eo15` `eo20` `eo25` `eo30` `eo50` `eo100` `eu5` `eu10` `eu15` `eu20` `eu25` `eu30` `eu50` | `fa_epsrev_<min>to<max>` (pct) |
| `fa_roa` | Return on Assets _(stocks)_ | `pos` `neg` `verypos` `veryneg` `u-50` `u-45` `u-40` `u-35` `u-30` `u-25` `u-20` `u-15` `u-10` `u-5` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_roa_<min>to<max>` (pct) |
| `fa_roe` | Return on Equity _(stocks)_ | `pos` `neg` `verypos` `veryneg` `u-50` `u-45` `u-40` `u-35` `u-30` `u-25` `u-20` `u-15` `u-10` `u-5` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_roe_<min>to<max>` (pct) |
| `fa_roi` | Return on Invested Capital _(stocks)_ | `pos` `neg` `verypos` `veryneg` `u-50` `u-45` `u-40` `u-35` `u-30` `u-25` `u-20` `u-15` `u-10` `u-5` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `fa_roi_<min>to<max>` (pct) |
| `fa_curratio` | Current Ratio _(stocks)_ | `high` `low` `u1` `u0.5` `o0.5` `o1` `o1.5` `o2` `o3` `o4` `o5` `o10` | `fa_curratio_<min>to<max>` (number) |
| `fa_quickratio` | Quick Ratio _(stocks)_ | `high` `low` `u1` `u0.5` `o0.5` `o1` `o1.5` `o2` `o3` `o4` `o5` `o10` | `fa_quickratio_<min>to<max>` (number) |
| `fa_ltdebteq` | LT Debt/Equity _(stocks)_ | `high` `low` `u1` `u0.9` `u0.8` `u0.7` `u0.6` `u0.5` `u0.4` `u0.3` `u0.2` `u0.1` `o0.1` `o0.2` `o0.3` `o0.4` `o0.5` `o0.6` `o0.7` `o0.8` `o0.9` `o1` | `fa_ltdebteq_<min>to<max>` (number) |
| `fa_debteq` | Debt/Equity _(stocks)_ | `high` `low` `u1` `u0.9` `u0.8` `u0.7` `u0.6` `u0.5` `u0.4` `u0.3` `u0.2` `u0.1` `o0.1` `o0.2` `o0.3` `o0.4` `o0.5` `o0.6` `o0.7` `o0.8` `o0.9` `o1` | `fa_debteq_<min>to<max>` (number) |
| `fa_grossmargin` | Gross Margin _(stocks)_ | `pos` `neg` `high` `u90` `u80` `u70` `u60` `u50` `u45` `u40` `u35` `u30` `u25` `u20` `u15` `u10` `u5` `u0` `u-10` `u-20` `u-30` `u-50` `u-70` `u-100` `o0` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` `o60` `o70` `o80` `o90` | `fa_grossmargin_<min>to<max>` (pct) |
| `fa_opermargin` | Operating Margin _(stocks)_ | `pos` `neg` `high` `u90` `u80` `u70` `u60` `u50` `u45` `u40` `u35` `u30` `u25` `u20` `u15` `u10` `u5` `u0` `u-10` `u-20` `u-30` `u-50` `u-70` `u-100` `o0` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` `o60` `o70` `o80` `o90` | `fa_opermargin_<min>to<max>` (pct) |
| `fa_netmargin` | Net Profit Margin _(stocks)_ | `pos` `neg` `high` `u90` `u80` `u70` `u60` `u50` `u45` `u40` `u35` `u30` `u25` `u20` `u15` `u10` `u5` `u0` `u-10` `u-20` `u-30` `u-50` `u-70` `u-100` `o0` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` `o60` `o70` `o80` `o90` | `fa_netmargin_<min>to<max>` (pct) |
| `fa_payoutratio` | Payout Ratio _(stocks)_ | `none` `pos` `low` `high` `o0` `o10` `o20` `o30` `o40` `o50` `o60` `o70` `o80` `o90` `o100` `u10` `u20` `u30` `u40` `u50` `u60` `u70` `u80` `u90` `u100` | `fa_payoutratio_<min>to<max>` (pct) |
| `sh_insiderown` | Insider Ownership _(stocks)_ | `low` `high` `veryhigh` `o10` `o20` `o30` `o40` `o50` `o60` `o70` `o80` `o90` | `sh_insiderown_<min>to<max>` (pct) |
| `sh_insidertrans` | Insider Transactions _(stocks)_ | `veryneg` `neg` `pos` `verypos` `u-90` `u-80` `u-70` `u-60` `u-50` `u-45` `u-40` `u-35` `u-30` `u-25` `u-20` `u-15` `u-10` `u-5` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` `o60` `o70` `o80` `o90` | `sh_insidertrans_<min>to<max>` (pct) |
| `sh_instown` | Institutional Ownership _(stocks)_ | `low` `high` `u90` `u80` `u70` `u60` `u50` `u40` `u30` `u20` `u10` `o10` `o20` `o30` `o40` `o50` `o60` `o70` `o80` `o90` | `sh_instown_<min>to<max>` (pct) |
| `sh_insttrans` | Institutional Transactions _(stocks)_ | `veryneg` `neg` `pos` `verypos` `u-50` `u-45` `u-40` `u-35` `u-30` `u-25` `u-20` `u-15` `u-10` `u-5` `o5` `o10` `o15` `o20` `o25` `o30` `o35` `o40` `o45` `o50` | `sh_insttrans_<min>to<max>` (pct) |

#### Technical

| Code | Filter | Options (`<code>_<option>`) | Custom range |
|---|---|---|---|
| `ta_perf` | Performance | `dup` `ddown` `d-15` `d-10` `d-5` `d5` `d10` `d15` `1w-30` `1w-20` `1w-10` `1wdown` `1wup` `1w10` `1w20` `1w30` `4w-50` `4w-30` `4w-20` `4w-10` `4wdown` `4wup` `4w10` `4w20` `4w30` `4w50` `13w-50` `13w-30` `13w-20` `13w-10` `13wdown` `13wup` `13w10` `13w20` `13w30` `13w50` `26w-75` `26w-50` `26w-30` `26w-20` … (+63 more) |  |
| `ta_perf2` | Performance 2 | `dup` `ddown` `d-15` `d-10` `d-5` `d5` `d10` `d15` `1w-30` `1w-20` `1w-10` `1wdown` `1wup` `1w10` `1w20` `1w30` `4w-50` `4w-30` `4w-20` `4w-10` `4wdown` `4wup` `4w10` `4w20` `4w30` `4w50` `13w-50` `13w-30` `13w-20` `13w-10` `13wdown` `13wup` `13w10` `13w20` `13w30` `13w50` `26w-75` `26w-50` `26w-30` `26w-20` … (+63 more) |  |
| `ta_volatility` | Volatility | `wo3` `wo4` `wo5` `wo6` `wo7` `wo8` `wo9` `wo10` `wo12` `wo15` `mo2` `mo3` `mo4` `mo5` `mo6` `mo7` `mo8` `mo9` `mo10` `mo12` `mo15` |  |
| `ta_rsi` | RSI (14) | `ob90` `ob80` `ob70` `ob60` `os40` `os30` `os20` `os10` `nob60` `nob50` `nos50` `nos40` | `ta_rsi_<min>to<max>` (number) |
| `ta_gap` | Gap | `u` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `u15` `u20` `d` `d1` `d2` `d3` `d4` `d5` `d6` `d7` `d8` `d9` `d10` `d15` `d20` | `ta_gap_<min>to<max>` (pct) |
| `ta_sma20` | 20-Day Simple Moving Average | `pb` `pb10` `pb20` `pb30` `pb40` `pb50` `pa` `pa10` `pa20` `pa30` `pa40` `pa50` `pc` `pca` `pcb` `sa50` `sb50` `sa200` `sb200` | `ta_sma20_<min>to<max>` (pct) |
| `ta_sma50` | 50-Day Simple Moving Average | `pb` `pb10` `pb20` `pb30` `pb40` `pb50` `pa` `pa10` `pa20` `pa30` `pa40` `pa50` `pc` `pca` `pcb` `cross200` `cross200a` `cross200b` `sa20` `sb20` `sa200` `sb200` | `ta_sma50_<min>to<max>` (pct) |
| `ta_sma200` | 200-Day Simple Moving Average | `pb` `pb10` `pb20` `pb30` `pb40` `pb50` `pa` `pa10` `pa20` `pa30` `pa40` `pa50` `pc` `pca` `pcb` `cross50` `cross50a` `cross50b` `sa20` `sb20` `sa50` `sb50` | `ta_sma200_<min>to<max>` (pct) |
| `ta_change` | Change | `u` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `u15` `u20` `d` `d1` `d2` `d3` `d4` `d5` `d6` `d7` `d8` `d9` `d10` `d15` `d20` | `ta_change_<min>to<max>` (pct) |
| `ta_changeopen` | Change from Open | `u` `u1` `u2` `u3` `u4` `u5` `u6` `u7` `u8` `u9` `u10` `u15` `u20` `d` `d1` `d2` `d3` `d4` `d5` `d6` `d7` `d8` `d9` `d10` `d15` `d20` | `ta_changeopen_<min>to<max>` (pct) |
| `ta_highlow20d` | 20-Day High/Low | `nh` `nl` `b0to3h` `b0to5h` `b0to10h` `b5h` `b10h` `b15h` `b20h` `b30h` `b40h` `b50h` `a0to3l` `a0to5l` `a0to10l` `a5l` `a10l` `a15l` `a20l` `a30l` `a40l` `a50l` | `ta_highlow20d_<min>to<max>` (pct) |
| `ta_highlow50d` | 50-Day High/Low | `nh` `nl` `b0to3h` `b0to5h` `b0to10h` `b5h` `b10h` `b15h` `b20h` `b30h` `b40h` `b50h` `a0to3l` `a0to5l` `a0to10l` `a5l` `a10l` `a15l` `a20l` `a30l` `a40l` `a50l` | `ta_highlow50d_<min>to<max>` (pct) |
| `ta_highlow52w` | 52-Week High/Low | `nh` `nl` `b0to3h` `b0to5h` `b0to10h` `b5h` `b10h` `b15h` `b20h` `b30h` `b40h` `b50h` `b60h` `b70h` `b80h` `b90h` `a0to3l` `a0to5l` `a0to10l` `a5l` `a10l` `a15l` `a20l` `a30l` `a40l` `a50l` `a60l` `a70l` `a80l` `a90l` `a100l` `a120l` `a150l` `a200l` `a300l` `a500l` | `ta_highlow52w_<min>to<max>` (pct) |
| `ta_alltime` | All-Time High/Low | `nh` `nl` `b0to3h` `b0to5h` `b0to10h` `b5h` `b10h` `b15h` `b20h` `b30h` `b40h` `b50h` `b60h` `b70h` `b80h` `b90h` `a0to3l` `a0to5l` `a0to10l` `a5l` `a10l` `a15l` `a20l` `a30l` `a40l` `a50l` `a60l` `a70l` `a80l` `a90l` `a100l` `a120l` `a150l` `a200l` `a300l` `a500l` | `ta_alltime_<min>to<max>` (pct) |
| `ta_pattern` | Pattern | _unavailable: Chart pattern recognition (channels, wedges, triangles) is not implemented_ |  |
| `ta_candlestick` | Candlestick | `doji` `hammer` `invertedhammer` `shootingstar` `hangingman` `bullishengulfing` `bearishengulfing` `marubozuwhite` `marubozublack` `spinningtop` |  |
| `ta_beta` | Beta _(stocks)_ | `u0` `u0.5` `u1` `u1.5` `u2` `o0` `o0.5` `o1` `o1.5` `o2` `o2.5` `o3` `o4` `0to0.5` `0to1` `0.5to1` `0.5to1.5` `1to1.5` `1to2` | `ta_beta_<min>to<max>` (number) |
| `ta_averagetruerange` | Average True Range | `o0.25` `o0.5` `o0.75` `o1` `o1.5` `o2` `o2.5` `o3` `o3.5` `o4` `o4.5` `o5` `u0.25` `u0.5` `u0.75` `u1` `u1.5` `u2` `u2.5` `u3` `u3.5` `u4` `u4.5` `u5` | `ta_averagetruerange_<min>to<max>` (money) |

#### News

| Code | Filter | Options (`<code>_<option>`) | Custom range |
|---|---|---|---|
| `news_date` | Latest News | `today` `todayafter` `sinceyesterday` `sinceyesterdayafter` `yesterday` `yesterdayafter` `prevdays5` `thisweek` `thismonth` |  |

#### Etf

| Code | Filter | Options (`<code>_<option>`) | Custom range |
|---|---|---|---|
| `etf_assettype` | Asset Type _(etfs)_ | `equities` `fixedincome` `commodity` `currency` `realestate` `multiasset` `alternative` |  |
| `etf_category` | Single Category _(etfs)_ | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `etf_leverage` | Leveraged/Inverse _(etfs)_ | `leveraged` `inverse` `notleveraged` |  |
| `etf_sponsor` | Sponsor _(etfs)_ | _values from the universe as slugs (e.g. `sec_technology`); see `list_filters`_ |  |
| `etf_netexpense` | Net Expense Ratio _(etfs)_ | `u0.1` `u0.2` `u0.3` `u0.4` `u0.5` `u0.6` `u0.7` `u0.8` `u0.9` `u1` `o0.1` `o0.25` `o0.5` `o0.75` `o1` `o2` | `etf_netexpense_<min>to<max>` (pct) |
| `etf_aum` | Assets Under Management _(etfs)_ | `u50` `u100` `u250` `u500` `u1000` `u10000` `o50` `o100` `o250` `o500` `o1000` `o10000` `o50000` `o100000` | `etf_aum_<min>to<max>` (money) |
| `etf_holdings` | Holdings _(etfs)_ | `u10` `u25` `u50` `u100` `o10` `o25` `o50` `o100` `o250` `o500` `o1000` | `etf_holdings_<min>to<max>` (number) |
| `etf_tags` | Tags _(etfs)_ | _unavailable: Finviz ETF tags are proprietary; use Single Category / Asset Type_ |  |
| `etf_fundflows` | Net Flows _(etfs)_ | _unavailable: Fund flow data is not provided by EODHD_ |  |
| `etf_return` | Annualized Return _(etfs)_ | _unavailable: Use the Performance filters (price return) instead_ |  |
| `etf_activepassive` | Active/Passive _(etfs)_ | _unavailable: Not provided in EODHD ETF data_ |  |

#### Sort columns (`o=`) and views (`v=`)

`ticker` `company` `sector` `industry` `country` `exchange` `market` `currency` `kind` `market_cap` `market_cap_usd` `pe` `forward_pe` `peg` `ps` `pb` `pcash` `pfcf` `ev_ebitda` `ev_sales` `eps_ttm` `eps_growth_this_y` `eps_growth_next_y` `eps_growth_qoq` `eps_growth_ttm` `eps_growth_past_3y` `eps_growth_past_5y` `eps_growth_next_5y` `sales_growth_qoq` `sales_growth_ttm` `sales_growth_past_3y` `sales_growth_past_5y` `eps_surprise_pct` `dividend_yield` `payout_ratio` `dividend_growth_3y` `roa` `roe` `roic` `current_ratio` `quick_ratio` `lt_debt_eq` `debt_eq` `gross_margin` `oper_margin` `net_margin` `shares_outstanding` `shares_float` `insider_own` `insider_trans` `inst_own` `inst_trans` `short_float` `short_ratio` `perf_1w` `perf_1m` `perf_3m` `perf_6m` `perf_1y` `perf_ytd` `perf_3y` `perf_5y` `volatility_1w` `volatility_1m` `beta` `atr14` `atr_pct` `sma20_pct` `sma50_pct` `sma200_pct` `high_52w_pct` `low_52w_pct` `high_20d_pct` `low_20d_pct` `ath_pct` `atl_pct` `ath_date` `rsi14` `candlestick` `gap_pct` `change_from_open_pct` `rel_volume` `avg_volume` `dollar_volume` `dollar_volume_usd` `price_usd` `price` `change_pct` `volume` `earnings_date` `earnings_timing` `last_earnings_date` `target_price` `target_upside_pct` `analyst_recom` `ipo_date` `employees` `etf_sponsor` `etf_category` `etf_aum` `etf_expense_ratio` `etf_holdings_count` `price_date`

| View | Columns |
|---|---|
| `overview` | ticker, company, sector, industry, country, market_cap, pe, price, change_pct, volume |
| `valuation` | ticker, market_cap, pe, forward_pe, peg, ps, pb, pcash, pfcf, eps_ttm, eps_growth_this_y, eps_growth_next_y, eps_growth_past_5y, eps_growth_next_5y, sales_growth_past_5y, price, change_pct, volume |
| `financial` | ticker, market_cap, dividend_yield, roa, roe, roic, current_ratio, quick_ratio, lt_debt_eq, debt_eq, gross_margin, oper_margin, net_margin, earnings_date, price, change_pct, volume |
| `ownership` | ticker, market_cap, shares_outstanding, shares_float, insider_own, insider_trans, inst_own, inst_trans, short_float, short_ratio, avg_volume, price, change_pct, volume |
| `performance` | ticker, perf_1w, perf_1m, perf_3m, perf_6m, perf_ytd, perf_1y, perf_3y, perf_5y, volatility_1w, volatility_1m, analyst_recom, avg_volume, rel_volume, price, change_pct, volume |
| `technical` | ticker, beta, atr14, sma20_pct, sma50_pct, sma200_pct, high_52w_pct, low_52w_pct, ath_pct, rsi14, price, change_pct, change_from_open_pct, gap_pct, volume |
| `etf` | ticker, company, etf_sponsor, etf_category, etf_aum, etf_expense_ratio, etf_holdings_count, perf_ytd, perf_1y, price, change_pct, volume |
| `charts` | ticker, company, sector, industry, country, market_cap, pe, price, change_pct, volume |
