import type { IChartApi, ISeriesApi, PriceFormat, SeriesType } from "lightweight-charts";
import type { Bar, Symbol, Timeframe, UnixSeconds } from "@eodview/shared";

export type BarsChangeKind = "reset" | "update" | "prepend";

/** Handed out by ChartView once the chart exists; IndicatorLayer and DrawingLayer attach through it. */
export interface ChartHandle {
  chart: IChartApi;
  /** Price series on pane 0. Recreated when chart type changes -> handle is re-issued via onReady. */
  mainSeries: ISeriesApi<SeriesType>;
  /** Raw (non-Heikin) bars currently loaded, ascending. */
  getBars(): Bar[];
  /** reset: symbol/tf changed; update: last bar changed or appended from a tick; prepend: older history loaded. */
  onBarsChanged(cb: (bars: Bar[], kind: BarsChangeKind) => void): () => void;
  /**
   * Called whenever the main series' price format is (re)applied, e.g. once bars for a 5-decimal instrument load.
   * Price-unit overlays should adopt it so their labels match (and so the shared right scale stays consistent).
   */
  onPriceFormatChanged(cb: (format: PriceFormat) => void): () => void;
  /** Convert a pixel coordinate on pane 0 to time/price (null outside data). */
  coordinateToPoint(x: number, y: number): { time: number; price: number } | null;

  // ---- v2 (range bar) ----
  /** Symbol / timeframe of the bars currently held (may lag the store briefly while a load starts). */
  getSymbol(): Symbol;
  getTimeframe(): Timeframe;
  /** Resolves true once bars for the store's current symbol at `tf` are loaded; false on failure/supersede/timeout. */
  whenLoaded(tf: Timeframe): Promise<boolean>;
  /**
   * Backfill until the oldest loaded bar is at/before `fromTime` (-Infinity = all history) or history runs out.
   * Resolves true when covered (or no older data exists).
   */
  ensureHistory(fromTime: UnixSeconds, maxPages?: number): Promise<boolean>;
  /** Show bars in [from, to] (to defaults to the last bar) with a little right padding. */
  setVisibleTimeRange(from: UnixSeconds, to?: UnixSeconds): void;
  /** Scroll so the bar at/after `time` is centred, keeping the current zoom. */
  scrollToTime(time: UnixSeconds): void;
  /** Fit all loaded bars. */
  fitContent(): void;
}
