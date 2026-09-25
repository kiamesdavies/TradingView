import { useSyncExternalStore, type ReactNode } from "react";
import type { Bar, Symbol, Timeframe } from "@eodview/shared";
import { findBarIndex } from "./candles";
import { formatChangePct, formatPrice, formatVolume } from "./format";
import type { ChartPalette } from "./theme";

export interface LegendSnapshot {
  bar: Bar;
  /** Close of the bar before `bar`, when loaded. */
  prevClose: number | null;
}

/**
 * Tiny external store so crosshair moves re-render only the legend, not the whole ChartView.
 */
export class LegendSource {
  private snapshot: LegendSnapshot | null = null;
  private hoverTime: number | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): LegendSnapshot | null => this.snapshot;

  /** Crosshair time (null = not hovering a bar → show the last bar). */
  setHover(time: number | null, bars: readonly Bar[]): void {
    this.hoverTime = time;
    this.refresh(bars);
  }

  refresh(bars: readonly Bar[]): void {
    let idx = this.hoverTime === null ? -1 : findBarIndex(bars, this.hoverTime);
    if (idx < 0) idx = bars.length - 1;
    const bar = bars[idx];
    const next: LegendSnapshot | null = bar ? { bar, prevClose: idx > 0 ? bars[idx - 1]!.close : null } : null;
    const prev = this.snapshot;
    if (prev === next || (prev && next && prev.bar === next.bar && prev.prevClose === next.prevClose)) return;
    this.snapshot = next;
    for (const cb of [...this.listeners]) cb();
  }
}

export function ChartLegend(props: {
  source: LegendSource;
  symbol: Symbol;
  tf: Timeframe;
  precision: number;
  palette: ChartPalette;
}) {
  const snap = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot, props.source.getSnapshot);
  const { palette: pal, precision } = props;

  let body: ReactNode = null;
  if (snap) {
    const { bar, prevClose } = snap;
    const ref = prevClose ?? bar.open;
    const change = bar.close - ref;
    const pct = ref !== 0 ? (change / ref) * 100 : NaN;
    const color = change >= 0 ? pal.up : pal.down;
    const item = (label: string, value: string) => (
      <span className="ev-chart-legend-item" key={label}>
        <span className="ev-chart-legend-label">{label}</span>
        <span style={{ color }}>{value}</span>
      </span>
    );
    body = (
      <>
        {item("O", formatPrice(bar.open, precision))}
        {item("H", formatPrice(bar.high, precision))}
        {item("L", formatPrice(bar.low, precision))}
        {item("C", formatPrice(bar.close, precision))}
        <span className="ev-chart-legend-item" style={{ color }}>
          {`${change >= 0 ? "+" : ""}${formatPrice(change, precision)} (${formatChangePct(pct)})`}
        </span>
        <span className="ev-chart-legend-item">
          <span className="ev-chart-legend-label">Vol</span>
          <span style={{ color }}>{formatVolume(bar.volume)}</span>
        </span>
      </>
    );
  }

  return (
    <div className="ev-chart-legend">
      <span className="ev-chart-legend-title">{props.symbol}</span>
      <span className="ev-chart-legend-tf">{props.tf}</span>
      {body}
    </div>
  );
}
