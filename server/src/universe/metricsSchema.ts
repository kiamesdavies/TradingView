// Contract between the universe pipeline (writer) and the screener (reader).
// One row per tracked symbol in table `universe_metrics`. The pipeline creates the table from this list
// (adding missing columns on startup) and fills every column it can; unknown values stay NULL.
// Units: *_pct columns are percentages (5.2 = +5.2%), dates "YYYY-MM-DD". Prices (price, open, sma*, ath, atl,
// target_price…) are in the symbol's quote currency (`currency`, which may be a minor unit such as GBX = pence);
// market_cap and per-share fundamentals are in the MAJOR unit (GBP for GBX); *_usd columns convert with
// fx_to_usd (USD per 1 unit of `currency`) from the daily FX job.
// v3 (pipeline owner): multi-market columns (market, indices, *_usd, fx_to_usd) and full-history metrics.

export type MetricType = "TEXT" | "REAL" | "INTEGER";
export interface MetricColumn { col: string; type: MetricType; desc: string }

export const METRIC_COLUMNS: MetricColumn[] = [
  // ---- identity / descriptive
  { col: "symbol", type: "TEXT", desc: "PK, EODHD symbol AAPL.US" },
  { col: "code", type: "TEXT", desc: "AAPL" },
  { col: "name", type: "TEXT", desc: "company / fund name" },
  { col: "kind", type: "TEXT", desc: "'stock' | 'etf'" },
  { col: "market", type: "TEXT", desc: "EODHD exchange code of the listing (US, ST, LSE, TO, ...; see universe/markets.ts)" },
  { col: "exchange", type: "TEXT", desc: "US: NYSE | NASDAQ | AMEX | NYSE ARCA | BATS; elsewhere the market code" },
  { col: "sector", type: "TEXT", desc: "EODHD General.Sector" },
  { col: "industry", type: "TEXT", desc: "EODHD General.Industry" },
  { col: "country", type: "TEXT", desc: "Issuer country: AddressData country when outside the US (ADRs), else General.CountryName" },
  { col: "currency", type: "TEXT", desc: "quote currency of the prices (symbol list Currency, e.g. USD, SEK, GBX)" },
  { col: "ipo_date", type: "TEXT", desc: "General.IPODate" },
  { col: "in_sp500", type: "INTEGER", desc: "0/1 GSPC.INDX component" },
  { col: "in_ndx", type: "INTEGER", desc: "0/1 NDX.INDX component" },
  { col: "in_dji", type: "INTEGER", desc: "0/1 DJI.INDX component" },
  { col: "indices", type: "TEXT", desc: "index memberships as comma-wrapped ids, e.g. ',SP500,NDX,' or ',OMXS30,OMXSPI,' (match with LIKE '%,ID,%')" },
  { col: "market_cap", type: "REAL", desc: "latest close * shares outstanding (fallback Highlights.MarketCapitalization), major currency unit" },
  { col: "market_cap_usd", type: "REAL", desc: "market_cap in USD" },
  { col: "shares_outstanding", type: "REAL", desc: "" },
  { col: "shares_float", type: "REAL", desc: "" },
  { col: "employees", type: "INTEGER", desc: "" },

  // ---- price & volume (from daily bars; adjusted closes for returns)
  { col: "price", type: "REAL", desc: "last close" },
  { col: "prev_close", type: "REAL", desc: "" },
  { col: "open", type: "REAL", desc: "last session open" },
  { col: "change_pct", type: "REAL", desc: "last close vs prev close" },
  { col: "change_from_open_pct", type: "REAL", desc: "close vs open" },
  { col: "gap_pct", type: "REAL", desc: "open vs prev close" },
  { col: "volume", type: "REAL", desc: "last session volume" },
  { col: "avg_volume", type: "REAL", desc: "63-session average volume (3M)" },
  { col: "rel_volume", type: "REAL", desc: "volume / avg_volume" },
  { col: "dollar_volume", type: "REAL", desc: "price * avg_volume (quote currency)" },
  { col: "dollar_volume_usd", type: "REAL", desc: "dollar_volume in USD (compare liquidity across markets)" },
  { col: "fx_to_usd", type: "REAL", desc: "USD per 1 unit of `currency` (GBX: GBPUSD/100); 1 for USD" },
  { col: "price_usd", type: "REAL", desc: "price in USD" },

  // ---- performance (adjusted)
  { col: "perf_1w", type: "REAL", desc: "5 sessions" },
  { col: "perf_2w", type: "REAL", desc: "10 sessions" },
  { col: "perf_1m", type: "REAL", desc: "21 sessions" },
  { col: "perf_3m", type: "REAL", desc: "63 sessions" },
  { col: "perf_6m", type: "REAL", desc: "126 sessions" },
  { col: "perf_ytd", type: "REAL", desc: "vs last close of previous year" },
  { col: "perf_1y", type: "REAL", desc: "252 sessions" },
  { col: "perf_3y", type: "REAL", desc: "vs the last close on/before the same date 3 years earlier (needs EODVIEW_HISTORY_YEARS >= 3)" },
  { col: "perf_5y", type: "REAL", desc: "same, 5 years (needs EODVIEW_HISTORY_YEARS >= 5)" },
  { col: "perf_3m_rank_pct", type: "REAL", desc: "percentile 0..100 of perf_3m within the same market and kind" },
  { col: "rs_score", type: "REAL", desc: "IBD-style weighted return %: 0.4*perf_3m + 0.2*(6m) + 0.2*(9m) + 0.2*(12m)" },
  { col: "rs_rank", type: "INTEGER", desc: "relative strength rating 1..99: percentile of rs_score within the same market and kind" },

  // ---- full history (per-ticker backfill; split/dividend-adjusted basis, like the chart's ADJ view)
  { col: "ath", type: "REAL", desc: "all-time high (adjusted, quote currency)" },
  { col: "ath_date", type: "TEXT", desc: "" },
  { col: "ath_pct", type: "REAL", desc: "price vs all-time high % (<= 0)" },
  { col: "atl", type: "REAL", desc: "all-time low (adjusted)" },
  { col: "atl_date", type: "TEXT", desc: "" },
  { col: "atl_pct", type: "REAL", desc: "price vs all-time low % (>= 0)" },
  { col: "first_trade_date", type: "TEXT", desc: "first date in EODHD's full history (listing date proxy)" },

  // ---- technical
  { col: "sma20", type: "REAL", desc: "" },
  { col: "sma50", type: "REAL", desc: "" },
  { col: "sma200", type: "REAL", desc: "" },
  { col: "sma20_pct", type: "REAL", desc: "price vs SMA20 %" },
  { col: "sma50_pct", type: "REAL", desc: "price vs SMA50 %" },
  { col: "sma200_pct", type: "REAL", desc: "price vs SMA200 %" },
  { col: "sma20_vs_sma50_pct", type: "REAL", desc: "SMA20 vs SMA50 %" },
  { col: "sma50_vs_sma200_pct", type: "REAL", desc: "SMA50 vs SMA200 %" },
  { col: "sma20_cross", type: "TEXT", desc: "'above'|'below'|'cross_above'|'cross_below' (price vs SMA20 today; cross = happened last session)" },
  { col: "sma50_cross", type: "TEXT", desc: "same for SMA50" },
  { col: "sma200_cross", type: "TEXT", desc: "same for SMA200" },
  { col: "sma50_200_cross", type: "TEXT", desc: "SMA50 vs SMA200: 'above'|'below'|'cross_above'(golden)|'cross_below'(death)" },
  { col: "rsi14", type: "REAL", desc: "Wilder RSI(14)" },
  { col: "atr14", type: "REAL", desc: "Wilder ATR(14)" },
  { col: "atr_pct", type: "REAL", desc: "atr14 / price %" },
  { col: "adr_pct", type: "REAL", desc: "average daily range % over 20 sessions: mean(high/low) - 1" },
  { col: "volatility_1w", type: "REAL", desc: "avg (high-low)/close % over 5 sessions" },
  { col: "volatility_1m", type: "REAL", desc: "avg (high-low)/close % over 21 sessions" },
  { col: "high_20d_pct", type: "REAL", desc: "price vs 20-session high % (<=0)" },
  { col: "low_20d_pct", type: "REAL", desc: "price vs 20-session low % (>=0)" },
  { col: "high_50d_pct", type: "REAL", desc: "" },
  { col: "low_50d_pct", type: "REAL", desc: "" },
  { col: "high_52w_pct", type: "REAL", desc: "" },
  { col: "low_52w_pct", type: "REAL", desc: "" },
  { col: "new_high", type: "TEXT", desc: "'20d'|'50d'|'52w'|NULL — made a new high this session (largest window)" },
  { col: "new_low", type: "TEXT", desc: "same for lows" },
  { col: "beta", type: "REAL", desc: "Technicals.Beta" },
  { col: "candlestick", type: "TEXT", desc: "last-bar pattern: doji|hammer|inverted_hammer|shooting_star|hanging_man|bullish_engulfing|bearish_engulfing|marubozu_white|marubozu_black|spinning_top|NULL" },

  // ---- valuation
  { col: "pe", type: "REAL", desc: "price / EPS TTM" },
  { col: "forward_pe", type: "REAL", desc: "Valuation.ForwardPE" },
  { col: "peg", type: "REAL", desc: "Highlights.PEGRatio" },
  { col: "ps", type: "REAL", desc: "Valuation.PriceSalesTTM" },
  { col: "pb", type: "REAL", desc: "Valuation.PriceBookMRQ" },
  { col: "pcash", type: "REAL", desc: "market cap / cash & short-term investments (MRQ)" },
  { col: "pfcf", type: "REAL", desc: "market cap / FCF TTM" },
  { col: "ev_ebitda", type: "REAL", desc: "Valuation.EnterpriseValueEbitda" },
  { col: "ev_sales", type: "REAL", desc: "Valuation.EnterpriseValueRevenue" },
  { col: "eps_ttm", type: "REAL", desc: "" },
  { col: "dividend_yield", type: "REAL", desc: "%" },
  { col: "payout_ratio", type: "REAL", desc: "%" },
  { col: "dividend_growth_3y", type: "REAL", desc: "% CAGR of annual dividends/share" },

  // ---- growth (%)
  { col: "eps_growth_this_y", type: "REAL", desc: "current-FY estimate vs last FY EPS" },
  { col: "eps_growth_next_y", type: "REAL", desc: "next-FY estimate vs current-FY estimate" },
  { col: "eps_growth_qoq", type: "REAL", desc: "latest quarter EPS vs same quarter last year" },
  { col: "eps_growth_ttm", type: "REAL", desc: "TTM EPS vs prior TTM" },
  { col: "eps_growth_past_3y", type: "REAL", desc: "CAGR" },
  { col: "eps_growth_past_5y", type: "REAL", desc: "CAGR" },
  { col: "eps_growth_next_5y", type: "REAL", desc: "Earnings.Trend +5y growth if present" },
  { col: "sales_growth_qoq", type: "REAL", desc: "latest quarter revenue vs same quarter last year" },
  { col: "sales_growth_ttm", type: "REAL", desc: "" },
  { col: "sales_growth_past_3y", type: "REAL", desc: "CAGR" },
  { col: "sales_growth_past_5y", type: "REAL", desc: "CAGR" },
  { col: "eps_surprise_pct", type: "REAL", desc: "last reported quarter" },

  // ---- profitability / health (%, ratios)
  { col: "roa", type: "REAL", desc: "%" },
  { col: "roe", type: "REAL", desc: "%" },
  { col: "roic", type: "REAL", desc: "% NOPAT / (debt + equity)" },
  { col: "gross_margin", type: "REAL", desc: "%" },
  { col: "oper_margin", type: "REAL", desc: "%" },
  { col: "net_margin", type: "REAL", desc: "%" },
  { col: "current_ratio", type: "REAL", desc: "" },
  { col: "quick_ratio", type: "REAL", desc: "" },
  { col: "lt_debt_eq", type: "REAL", desc: "" },
  { col: "debt_eq", type: "REAL", desc: "" },

  // ---- ownership
  { col: "insider_own", type: "REAL", desc: "%" },
  { col: "insider_trans", type: "REAL", desc: "% net shares bought(+)/sold(-) by insiders last 6 months vs shares held" },
  { col: "inst_own", type: "REAL", desc: "%" },
  { col: "inst_trans", type: "REAL", desc: "% change in institutional holdings (Holders.Institutions totalShares change)" },
  { col: "short_float", type: "REAL", desc: "%" },
  { col: "short_ratio", type: "REAL", desc: "days to cover" },

  // ---- analysts & events
  { col: "analyst_recom", type: "REAL", desc: "finviz scale 1=Strong Buy .. 5=Strong Sell (convert from EODHD 5=strong buy: 6 - rating)" },
  { col: "target_price", type: "REAL", desc: "" },
  { col: "target_upside_pct", type: "REAL", desc: "target vs price %" },
  { col: "earnings_date", type: "TEXT", desc: "next report date YYYY-MM-DD" },
  { col: "earnings_timing", type: "TEXT", desc: "'bmo' | 'amc' | NULL" },
  { col: "last_earnings_date", type: "TEXT", desc: "most recent report date" },
  { col: "latest_news_at", type: "INTEGER", desc: "unix seconds of newest news article seen" },

  // ---- ETF
  { col: "etf_expense_ratio", type: "REAL", desc: "%" },
  { col: "etf_aum", type: "REAL", desc: "ETF_Data.TotalAssets" },
  { col: "etf_sponsor", type: "TEXT", desc: "ETF_Data.Company_Name" },
  { col: "etf_category", type: "TEXT", desc: "ETF_Data.Category / asset class" },
  { col: "etf_holdings_count", type: "INTEGER", desc: "" },

  // ---- bookkeeping
  { col: "price_date", type: "TEXT", desc: "date of `price`" },
  { col: "fundamentals_at", type: "INTEGER", desc: "unix seconds fundamentals were fetched" },
  { col: "history_at", type: "INTEGER", desc: "unix seconds the full history (ath/atl) was fetched" },
  { col: "updated_at", type: "INTEGER", desc: "unix seconds this row was recomputed" },
];

export const METRICS_TABLE = "universe_metrics";
export const METRIC_COLUMN_SET = new Set(METRIC_COLUMNS.map((c) => c.col));
