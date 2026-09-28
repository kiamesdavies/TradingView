import { create } from "zustand";
import type {
  Alert, AlertEvent, AlertInput, ChartType, DrawingType, IndicatorConfig, Layout, Quote, Symbol, Theme, Timeframe, Watchlist,
} from "@eodview/shared";
import { api } from "../api/http";

export const DEFAULT_LAYOUT: Layout = {
  symbol: "AAPL.US",
  tf: "1D",
  chartType: "candles",
  theme: "dark",
  logScale: false,
  indicators: [],
  recentSymbols: [],
};

export interface UiState {
  /** "measure" is the ruler: a temporary measurement, never saved. */
  drawingTool: DrawingType | "cursor" | "measure";
  drawingColor: string;
  searchOpen: boolean;
  indicatorsOpen: boolean;
  settingsOpen: boolean;
  sidebarTab: "watchlist" | "alerts" | "details";
  page: "chart" | "screener";
  upstream: "connected" | "disconnected" | "no_key" | "unknown";
}

export interface AppState {
  layout: Layout;
  layoutLoaded: boolean;
  watchlists: Watchlist[];
  alerts: Alert[];
  alertHistory: AlertEvent[];
  quotes: Record<Symbol, Quote>;
  ui: UiState;

  setLayout(patch: Partial<Layout>): void;
  setSymbol(symbol: Symbol): void;
  setTimeframe(tf: Timeframe): void;
  setChartType(t: ChartType): void;
  setTheme(t: Theme): void;
  setIndicators(list: IndicatorConfig[]): void;
  setUi(patch: Partial<UiState>): void;
  setQuote(q: Quote): void;
  setWatchlists(w: Watchlist[]): void;
  setAlerts(a: Alert[]): void;
  pushAlertEvent(e: AlertEvent): void;
  createAlert(input: AlertInput): Promise<Alert>;
}

export const useStore = create<AppState>((set, get) => ({
  layout: DEFAULT_LAYOUT,
  layoutLoaded: false,
  watchlists: [],
  alerts: [],
  alertHistory: [],
  quotes: {},
  ui: {
    drawingTool: "cursor",
    drawingColor: "#2962ff",
    searchOpen: false,
    indicatorsOpen: false,
    settingsOpen: false,
    sidebarTab: "watchlist",
    page: location.hash.startsWith("#/screener") ? "screener" : "chart",
    upstream: "unknown",
  },

  setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
  setSymbol: (symbol) =>
    set((s) => ({
      layout: {
        ...s.layout,
        symbol,
        recentSymbols: [symbol, ...s.layout.recentSymbols.filter((x) => x !== symbol)].slice(0, 20),
      },
    })),
  setTimeframe: (tf) => set((s) => ({ layout: { ...s.layout, tf } })),
  setChartType: (chartType) => set((s) => ({ layout: { ...s.layout, chartType } })),
  setTheme: (theme) => set((s) => ({ layout: { ...s.layout, theme } })),
  setIndicators: (indicators) => set((s) => ({ layout: { ...s.layout, indicators } })),
  setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
  setQuote: (q) => set((s) => ({ quotes: { ...s.quotes, [q.symbol]: q } })),
  setWatchlists: (watchlists) => set({ watchlists }),
  setAlerts: (alerts) => set({ alerts }),
  pushAlertEvent: (e) => set((s) => ({ alertHistory: [e, ...s.alertHistory].slice(0, 200) })),
  createAlert: async (input) => {
    const alert = await api.post<Alert>("/alerts", input);
    set({ alerts: [...get().alerts, alert] });
    return alert;
  },
}));
