import type { IChartApi, ISeriesApi, PriceFormat, SeriesType } from "lightweight-charts";
import type { Bar } from "@eodview/shared";

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
}
