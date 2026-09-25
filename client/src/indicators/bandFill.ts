import type {
  IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive,
  SeriesAttachedParameter, SeriesType, Time, UTCTimestamp,
} from "lightweight-charts";
import type { IndicatorPoint } from "@eodview/shared/src/indicators/index";

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

interface BandCoord { x: number; top: number; bottom: number }

/** First index whose time is >= t (arrays are ascending). */
function lowerBound(points: readonly IndicatorPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid]!.time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

class BandRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly coords: readonly BandCoord[], private readonly color: string, private readonly alpha: number) {}

  draw(target: RenderTarget): void {
    if (this.coords.length < 2) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      const first = this.coords[0]!;
      ctx.moveTo(first.x, first.top);
      for (let i = 1; i < this.coords.length; i++) ctx.lineTo(this.coords[i]!.x, this.coords[i]!.top);
      for (let i = this.coords.length - 1; i >= 0; i--) ctx.lineTo(this.coords[i]!.x, this.coords[i]!.bottom);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }
}

/**
 * Series primitive that shades the area between two lines (Bollinger upper/lower). Attach it to any series
 * that shares the lines' price scale; it draws beneath the series.
 */
export class BandFill implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private upper: IndicatorPoint[] = [];
  private lower: IndicatorPoint[] = [];
  private coords: BandCoord[] = [];
  private readonly view: IPrimitivePaneView;

  constructor(private color: string, private readonly alpha = 0.1) {
    this.view = {
      zOrder: () => "bottom",
      renderer: () => new BandRenderer(this.coords, this.color, this.alpha),
    };
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setData(upper: IndicatorPoint[], lower: IndicatorPoint[]): void {
    this.upper = upper;
    this.lower = lower;
    this.requestUpdate?.();
  }

  setColor(color: string): void {
    this.color = color;
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    const chart = this.chart;
    const series = this.series;
    const n = Math.min(this.upper.length, this.lower.length);
    this.coords = [];
    if (!chart || !series || n === 0) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleRange();
    let from = 0;
    let to = n;
    if (range) {
      // One extra point on each side so the fill reaches the pane edges.
      from = Math.max(0, lowerBound(this.upper, range.from as number) - 1);
      to = Math.min(n, lowerBound(this.upper, range.to as number) + 2);
    }
    for (let i = from; i < to; i++) {
      const u = this.upper[i]!;
      const l = this.lower[i]!;
      const x = ts.timeToCoordinate(u.time as UTCTimestamp);
      const top = series.priceToCoordinate(u.value);
      const bottom = series.priceToCoordinate(l.value);
      if (x === null || top === null || bottom === null) continue;
      this.coords.push({ x, top, bottom });
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }
}
