# Known limitations

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
- **Single user.** There is no auth apart from the config guard and the agent API tokens. Don't expose the
  server to the internet without a reverse proxy that adds authentication, and behind a proxy set
  `EODVIEW_ADMIN_TOKEN` and `EODVIEW_API_REQUIRE_TOKEN=1` (a same-host proxy makes every request look local).
