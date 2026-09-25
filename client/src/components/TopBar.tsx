import { useStore } from "../state/store";
import { ChartTypeMenu } from "./ChartTypeMenu";
import { direction, formatChange, formatPct, formatPrice, splitSymbol } from "./format";
import { GearIcon, IndicatorsIcon, MoonIcon, PanelIcon, SearchIcon, SunIcon } from "./icons";
import { useShell } from "./shellStore";
import { StatusDot } from "./StatusDot";
import { TimeframeBar } from "./TimeframeBar";

function SymbolQuote() {
  const symbol = useStore((s) => s.layout.symbol);
  const q = useStore((s) => s.quotes[symbol]);
  if (!q) return null;
  const dir = direction(q.change);
  return (
    <div className="tb-quote" aria-live="off">
      <span className="tb-quote-price">{formatPrice(q.price, symbol)}</span>
      <span className={`tb-quote-chg ${dir}`}>
        {formatChange(q.change, symbol, q.price)} ({formatPct(q.changePct)})
      </span>
    </div>
  );
}

export function TopBar() {
  const symbol = useStore((s) => s.layout.symbol);
  const logScale = useStore((s) => s.layout.logScale);
  const theme = useStore((s) => s.layout.theme);
  const indicatorCount = useStore((s) => s.layout.indicators.length);
  const setLayout = useStore((s) => s.setLayout);
  const setTheme = useStore((s) => s.setTheme);
  const setUi = useStore((s) => s.setUi);
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const { code, exchange } = splitSymbol(symbol);

  return (
    <header className="topbar">
      <button
        type="button"
        className="tb-btn symbol-btn"
        onClick={() => useShell.getState().openSearch()}
        title="Search symbol (or just start typing)"
      >
        <SearchIcon />
        <span className="symbol-code">{code}</span>
        {exchange && <span className="symbol-ex">{exchange}</span>}
      </button>
      <SymbolQuote />
      <div className="tb-sep" />
      <TimeframeBar />
      <div className="tb-sep" />
      <ChartTypeMenu />
      <div className="tb-sep" />
      <button type="button" className="tb-btn" onClick={() => setUi({ indicatorsOpen: true })} title="Indicators">
        <IndicatorsIcon />
        <span className="tb-label">Indicators</span>
        {indicatorCount > 0 && <span className="count-pill">{indicatorCount}</span>}
      </button>
      <button
        type="button"
        className={`tb-btn${logScale ? " active" : ""}`}
        aria-pressed={logScale}
        onClick={() => setLayout({ logScale: !logScale })}
        title="Logarithmic price scale"
      >
        log
      </button>

      <div className="tb-spacer" />

      <StatusDot />
      <button
        type="button"
        className="icon-btn"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
      <button
        type="button"
        className={`icon-btn${sidebarCollapsed ? "" : " active"}`}
        onClick={() => useShell.getState().toggleSidebar()}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-label="Toggle sidebar"
        aria-pressed={!sidebarCollapsed}
      >
        <PanelIcon />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => useShell.getState().openSettings()}
        title="Settings"
        aria-label="Settings"
      >
        <GearIcon />
      </button>
    </header>
  );
}
