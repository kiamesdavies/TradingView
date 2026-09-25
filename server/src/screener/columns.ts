// Result columns and Finviz-style views. Each column maps to one whitelisted metric column (or a fixed SQL
// expression over them); column ids are the keys of ScreenerResponse rows.
import type { ScreenerColumnDef, ScreenerView, StatFormat } from "@eodview/shared";

export interface ColumnSpec extends ScreenerColumnDef {
  /** Metric column(s) read; the first is the value unless `expr` is given. */
  cols: string[];
  /** SQL over quoted column refs, `$0`, `$1`… replaced with the resolved refs of `cols`. */
  expr?: string;
}

const c = (id: string, label: string, format: StatFormat, col = id, align: "left" | "right" = format === "text" || format === "date" ? "left" : "right"): ColumnSpec =>
  ({ id, label, format, align, cols: [col] });

export const COLUMNS: ColumnSpec[] = [
  { id: "ticker", label: "Ticker", format: "text", align: "left", cols: ["code", "symbol"], expr: "COALESCE($0, $1)" },
  c("company", "Company", "text", "name"),
  c("sector", "Sector", "text"),
  c("industry", "Industry", "text"),
  c("country", "Country", "text"),
  c("exchange", "Exchange", "text"),
  c("kind", "Type", "text"),
  c("market_cap", "Market Cap", "money"),
  c("pe", "P/E", "ratio"),
  c("forward_pe", "Fwd P/E", "ratio"),
  c("peg", "PEG", "ratio"),
  c("ps", "P/S", "ratio"),
  c("pb", "P/B", "ratio"),
  c("pcash", "P/C", "ratio"),
  c("pfcf", "P/FCF", "ratio"),
  c("ev_ebitda", "EV/EBITDA", "ratio"),
  c("ev_sales", "EV/Sales", "ratio"),
  c("eps_ttm", "EPS", "money"),
  c("eps_growth_this_y", "EPS this Y", "pct"),
  c("eps_growth_next_y", "EPS next Y", "pct"),
  c("eps_growth_qoq", "EPS Q/Q", "pct"),
  c("eps_growth_ttm", "EPS YoY TTM", "pct"),
  c("eps_growth_past_3y", "EPS past 3Y", "pct"),
  c("eps_growth_past_5y", "EPS past 5Y", "pct"),
  c("eps_growth_next_5y", "EPS next 5Y", "pct"),
  c("sales_growth_qoq", "Sales Q/Q", "pct"),
  c("sales_growth_ttm", "Sales YoY TTM", "pct"),
  c("sales_growth_past_3y", "Sales past 3Y", "pct"),
  c("sales_growth_past_5y", "Sales past 5Y", "pct"),
  c("eps_surprise_pct", "EPS Surprise", "pct"),
  c("dividend_yield", "Dividend", "pct"),
  c("payout_ratio", "Payout", "pct"),
  c("dividend_growth_3y", "Div Growth 3Y", "pct"),
  c("roa", "ROA", "pct"),
  c("roe", "ROE", "pct"),
  c("roic", "ROIC", "pct"),
  c("current_ratio", "Curr R", "ratio"),
  c("quick_ratio", "Quick R", "ratio"),
  c("lt_debt_eq", "LTDebt/Eq", "ratio"),
  c("debt_eq", "Debt/Eq", "ratio"),
  c("gross_margin", "Gross M", "pct"),
  c("oper_margin", "Oper M", "pct"),
  c("net_margin", "Profit M", "pct"),
  c("shares_outstanding", "Outstanding", "volume"),
  c("shares_float", "Float", "volume"),
  c("insider_own", "Insider Own", "pct"),
  c("insider_trans", "Insider Trans", "pct"),
  c("inst_own", "Inst Own", "pct"),
  c("inst_trans", "Inst Trans", "pct"),
  c("short_float", "Short Float", "pct"),
  c("short_ratio", "Short Ratio", "ratio"),
  c("perf_1w", "Perf Week", "pct"),
  c("perf_1m", "Perf Month", "pct"),
  c("perf_3m", "Perf Quart", "pct"),
  c("perf_6m", "Perf Half", "pct"),
  c("perf_1y", "Perf Year", "pct"),
  c("perf_ytd", "Perf YTD", "pct"),
  c("volatility_1w", "Volatility W", "pct"),
  c("volatility_1m", "Volatility M", "pct"),
  c("beta", "Beta", "ratio"),
  c("atr14", "ATR", "money"),
  c("atr_pct", "ATR %", "pct"),
  c("sma20_pct", "SMA20", "pct"),
  c("sma50_pct", "SMA50", "pct"),
  c("sma200_pct", "SMA200", "pct"),
  c("high_52w_pct", "52W High", "pct"),
  c("low_52w_pct", "52W Low", "pct"),
  c("high_20d_pct", "20D High", "pct"),
  c("low_20d_pct", "20D Low", "pct"),
  c("rsi14", "RSI", "number"),
  c("candlestick", "Candle", "text"),
  c("gap_pct", "Gap", "pct"),
  c("change_from_open_pct", "from Open", "pct"),
  c("rel_volume", "Rel Volume", "ratio"),
  c("avg_volume", "Avg Volume", "volume"),
  c("dollar_volume", "$ Volume", "money"),
  c("price", "Price", "money"),
  c("change_pct", "Change", "pct"),
  c("volume", "Volume", "volume"),
  c("earnings_date", "Earnings", "date"),
  c("earnings_timing", "Earn Time", "text"),
  c("last_earnings_date", "Last Earnings", "date"),
  c("target_price", "Target Price", "money"),
  c("target_upside_pct", "Target Upside", "pct"),
  c("analyst_recom", "Recom", "ratio"),
  c("ipo_date", "IPO Date", "date"),
  c("employees", "Employees", "number"),
  c("etf_sponsor", "Sponsor", "text"),
  c("etf_category", "Category", "text"),
  c("etf_aum", "AUM", "money"),
  c("etf_expense_ratio", "Expense", "pct"),
  c("etf_holdings_count", "Holdings", "number"),
  c("price_date", "As of", "date"),
];
const BY_ID = new Map(COLUMNS.map((col) => [col.id, col]));
export function getColumn(id: string): ColumnSpec | undefined {
  return BY_ID.get(id);
}

const OVERVIEW = ["ticker", "company", "sector", "industry", "country", "market_cap", "pe", "price", "change_pct", "volume"];

export const VIEWS: ScreenerView[] = [
  { id: "overview", label: "Overview", columns: OVERVIEW },
  {
    id: "valuation", label: "Valuation",
    columns: ["ticker", "market_cap", "pe", "forward_pe", "peg", "ps", "pb", "pcash", "pfcf", "eps_ttm",
      "eps_growth_this_y", "eps_growth_next_y", "eps_growth_past_5y", "eps_growth_next_5y", "sales_growth_past_5y",
      "price", "change_pct", "volume"],
  },
  {
    id: "financial", label: "Financial",
    columns: ["ticker", "market_cap", "dividend_yield", "roa", "roe", "roic", "current_ratio", "quick_ratio",
      "lt_debt_eq", "debt_eq", "gross_margin", "oper_margin", "net_margin", "earnings_date", "price", "change_pct", "volume"],
  },
  {
    id: "ownership", label: "Ownership",
    columns: ["ticker", "market_cap", "shares_outstanding", "shares_float", "insider_own", "insider_trans", "inst_own",
      "inst_trans", "short_float", "short_ratio", "avg_volume", "price", "change_pct", "volume"],
  },
  {
    id: "performance", label: "Performance",
    columns: ["ticker", "perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y", "volatility_1w",
      "volatility_1m", "analyst_recom", "avg_volume", "rel_volume", "price", "change_pct", "volume"],
  },
  {
    id: "technical", label: "Technical",
    columns: ["ticker", "beta", "atr14", "sma20_pct", "sma50_pct", "sma200_pct", "high_52w_pct", "low_52w_pct", "rsi14",
      "price", "change_pct", "change_from_open_pct", "gap_pct", "volume"],
  },
  {
    id: "etf", label: "ETF",
    columns: ["ticker", "company", "etf_sponsor", "etf_category", "etf_aum", "etf_expense_ratio", "etf_holdings_count",
      "perf_ytd", "perf_1y", "price", "change_pct", "volume"],
  },
  { id: "charts", label: "Charts", columns: OVERVIEW },
];
const VIEW_BY_ID = new Map(VIEWS.map((v) => [v.id, v]));
export function getView(id: string): ScreenerView | undefined {
  return VIEW_BY_ID.get(id);
}

export function columnDefs(): ScreenerColumnDef[] {
  return COLUMNS.map(({ id, label, format, align }) => ({ id, label, format, align }));
}
