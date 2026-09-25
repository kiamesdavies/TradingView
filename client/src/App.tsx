import { useCallback, useState } from "react";
import { ChartView } from "./chart/ChartView";
import type { ChartHandle } from "./chart/types";
import { DrawingLayer } from "./drawings/DrawingLayer";
import { DrawingToolbar } from "./drawings/DrawingToolbar";
import { IndicatorDialog } from "./indicators/IndicatorDialog";
import { IndicatorLayer } from "./indicators/IndicatorLayer";
import { useStore } from "./state/store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsDialog } from "./components/SettingsDialog";
import { useShell } from "./components/shellStore";
import { Sidebar } from "./components/Sidebar";
import { SymbolSearch } from "./components/SymbolSearch";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { useBoot } from "./components/useBoot";
import { useGlobalKeys } from "./components/useGlobalKeys";
import { useLiveQuotes } from "./components/useLiveQuotes";
import { useWsWiring } from "./components/useWsWiring";
import { ChartBottomBar } from "./chart/ChartBottomBar";
import { ScreenerPage } from "./screener/ScreenerPage";
import { usePageRoute } from "./components/usePageRoute";

export function App() {
  useBoot();
  useWsWiring();
  useGlobalKeys();
  usePageRoute();

  const layoutLoaded = useStore((s) => s.layoutLoaded);
  const symbol = useStore((s) => s.layout.symbol);
  const indicatorsOpen = useStore((s) => s.ui.indicatorsOpen);
  const page = useStore((s) => s.ui.page);
  const sidebarCollapsed = useShell((s) => s.sidebarCollapsed);
  const [handle, setHandle] = useState<ChartHandle | null>(null);

  // Keep the chart symbol's quote live (top bar last/change, alert default price).
  useLiveQuotes(layoutLoaded ? [symbol] : []);

  const onReady = useCallback((h: ChartHandle) => setHandle(h), []);
  const closeIndicators = useCallback(() => useStore.getState().setUi({ indicatorsOpen: false }), []);

  return (
    <div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}${page === "screener" ? " page-screener" : ""}`}>
      <TopBar />
      {page === "screener" ? (
        <main className="screener-area">
          <ErrorBoundary name="Screener">
            <ScreenerPage />
          </ErrorBoundary>
        </main>
      ) : (
        <>
          <nav className="left-toolbar" aria-label="Drawing tools">
            <ErrorBoundary name="Drawing toolbar" silent>
              <DrawingToolbar />
            </ErrorBoundary>
          </nav>
          <main className="chart-area">
            {layoutLoaded ? (
              <>
                <div className="chart-stack">
                  <ErrorBoundary name="Chart" resetKey={symbol}>
                    <ChartView onReady={onReady} />
                    <ErrorBoundary name="Indicators" silent resetKey={handle}>
                      <IndicatorLayer handle={handle} />
                    </ErrorBoundary>
                    <ErrorBoundary name="Drawings" silent resetKey={handle}>
                      <DrawingLayer handle={handle} />
                    </ErrorBoundary>
                  </ErrorBoundary>
                </div>
                <ErrorBoundary name="Range bar" silent resetKey={handle}>
                  <ChartBottomBar handle={handle} />
                </ErrorBoundary>
              </>
            ) : (
              <div className="chart-loading">
                <span className="spinner" /> Loading layout…
              </div>
            )}
          </main>
          {!sidebarCollapsed && <Sidebar handle={handle} />}
        </>
      )}

      <SymbolSearch />
      <ErrorBoundary name="Indicator dialog" silent>
        <IndicatorDialog open={indicatorsOpen} onClose={closeIndicators} />
      </ErrorBoundary>
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
