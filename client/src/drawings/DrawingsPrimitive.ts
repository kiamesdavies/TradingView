// A single lightweight-charts series primitive that renders every drawing of the current symbol.
import type {
  IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView,
  Logical, PrimitiveHoveredItem, SeriesAttachedParameter, SeriesType, Time,
} from "lightweight-charts";
import type { Drawing, UnixSeconds } from "@eodview/shared";
import {
  HANDLE_RADIUS, barInterval, bounds, fractionalCoordinate, fractionalLogical, hitTest, projectDrawing, timeToLogical, withAlpha,
  type Hit, type Projector, type Pt, type ScreenShape,
} from "./geometry";

// fancy-canvas is only a transitive dependency; derive its types from lightweight-charts instead.
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type MediaScope = Parameters<Parameters<RenderTarget["useMediaCoordinateSpace"]>[0]>[0];

export interface DrawingsRenderState {
  drawings: readonly Drawing[];
  selectedId: string | null;
  /** In-progress drawing that follows the mouse while it is being created. */
  preview: Drawing | null;
}

export interface DrawingsStyle {
  /** Fill of drag handles (chart background). */
  handleFill: string;
  /** Color of fib level labels. */
  labelColor: string;
}

export const DARK_STYLE: DrawingsStyle = { handleFill: "#131722", labelColor: "#d1d4dc" };
export const LIGHT_STYLE: DrawingsStyle = { handleFill: "#ffffff", labelColor: "#131722" };

interface RenderItem { drawing: Drawing; shape: ScreenShape; selected: boolean }

const FONT = "11px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

/** Readable text color (black/white) for a solid background color. */
function contrastText(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#131722" : "#ffffff";
}

/** Snap to the pixel grid so thin lines stay crisp. */
function crisp(v: number, lineWidth: number): number {
  return lineWidth % 2 === 1 ? Math.round(v) + 0.5 : Math.round(v);
}

class DrawingsRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: DrawingsPrimitive) {}

  draw(target: RenderTarget): void {
    const items = this.source.renderItems();
    if (items.length === 0) return;
    target.useMediaCoordinateSpace((scope) => {
      for (const it of items) this.drawItem(scope, it);
    });
  }

  private drawItem(scope: MediaScope, it: RenderItem): void {
    const { context: ctx, mediaSize } = scope;
    const { drawing: d, shape } = it;
    const lw = Math.max(1, d.lineWidth || 1);
    const [a, b] = shape.pts;
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = d.color;
    ctx.lineCap = "round";
    switch (d.type) {
      case "trendline":
        this.line(ctx, a!, b!);
        break;
      case "hline": {
        const y = crisp(a!.y, lw);
        this.line(ctx, { x: 0, y }, { x: mediaSize.width, y });
        break;
      }
      case "hray": {
        const y = crisp(a!.y, lw);
        this.line(ctx, { x: a!.x, y }, { x: mediaSize.width, y });
        break;
      }
      case "rect": {
        const r = bounds(a!, b!);
        ctx.fillStyle = withAlpha(d.color, 0.15);
        ctx.fillRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
        ctx.strokeRect(crisp(r.left, lw), crisp(r.top, lw), Math.round(r.right - r.left), Math.round(r.bottom - r.top));
        break;
      }
      case "fib":
        this.drawFib(ctx, it, lw);
        break;
    }
    if (it.selected) {
      const pts = d.type === "hline" ? [{ x: mediaSize.width / 2, y: a!.y }] : shape.pts;
      for (const p of pts) this.handle(ctx, p, d.color);
    }
    ctx.restore();
  }

  private drawFib(ctx: CanvasRenderingContext2D, it: RenderItem, lw: number): void {
    const { drawing: d, shape } = it;
    const [a, b] = shape.pts;
    const levels = shape.levels ?? [];
    const left = Math.min(a!.x, b!.x);
    const right = Math.max(a!.x, b!.x);
    // light fills between consecutive levels, alternating intensity
    for (let i = 0; i + 1 < levels.length; i++) {
      const y0 = levels[i]!.y;
      const y1 = levels[i + 1]!.y;
      ctx.fillStyle = withAlpha(d.color, i % 2 === 0 ? 0.08 : 0.14);
      ctx.fillRect(left, Math.min(y0, y1), right - left, Math.abs(y1 - y0));
    }
    ctx.font = FONT;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    const fmt = this.source.formatPrice.bind(this.source);
    for (const l of levels) {
      const y = crisp(l.y, lw);
      this.line(ctx, { x: left, y }, { x: right, y });
      ctx.fillStyle = d.color;
      ctx.fillText(`${l.ratio} (${fmt(l.price)})`, left + 4, y - 2);
    }
    // dashed diagonal connecting the two anchors
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    this.line(ctx, a!, b!);
    ctx.restore();
  }

  private line(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  private handle(ctx: CanvasRenderingContext2D, p: Pt, color: string): void {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = this.source.style.handleFill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  private readonly rendererImpl: DrawingsRenderer;
  constructor(source: DrawingsPrimitive) { this.rendererImpl = new DrawingsRenderer(source); }
  zOrder(): "top" { return "top"; }
  renderer(): IPrimitivePaneRenderer { return this.rendererImpl; }
}

/** Price-axis label for hline / hray drawings. */
class LevelAxisView implements ISeriesPrimitiveAxisView {
  constructor(private readonly source: DrawingsPrimitive, private readonly drawing: Drawing) {}
  private price(): number { return this.drawing.points[0]!.price; }
  coordinate(): number { return this.source.priceToY(this.price()) ?? -1000; }
  text(): string { return this.source.formatPrice(this.price()); }
  textColor(): string { return contrastText(this.drawing.color); }
  backColor(): string { return this.drawing.color; }
  visible(): boolean { return this.source.priceToY(this.price()) !== null; }
  tickVisible(): boolean { return true; }
}

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  style: DrawingsStyle = DARK_STYLE;
  /** When false (a creation tool is active) hovering shows no pointer cursor. */
  interactive = true;

  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;

  private state: DrawingsRenderState = { drawings: [], selectedId: null, preview: null };
  private items: RenderItem[] = [];
  private readonly paneViewList: readonly IPrimitivePaneView[] = [new DrawingsPaneView(this)];
  private axisViewList: readonly ISeriesPrimitiveAxisView[] = [];

  private timesRef: readonly UnixSeconds[] = [];
  private interval = 86400;

  constructor(private readonly getTimes: () => readonly UnixSeconds[]) {}

  // ---- ISeriesPrimitive ----
  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.redraw();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews(): void {
    this.items = this.computeItems();
  }

  paneViews(): readonly IPrimitivePaneView[] { return this.paneViewList; }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this.axisViewList; }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this.interactive) return null;
    const hit = this.hit({ x, y });
    if (!hit) return null;
    return {
      externalId: `drawing:${hit.id}`,
      zOrder: "top",
      distance: hit.distance,
      hitTestPriority: hit.part.kind === "handle" ? 2 : 1,
      cursorStyle: hit.part.kind === "handle" ? "move" : "pointer",
    };
  }

  // ---- public API used by DrawingLayer ----
  setState(state: DrawingsRenderState): void {
    const drawingsChanged = state.drawings !== this.state.drawings;
    this.state = state;
    if (drawingsChanged) {
      this.axisViewList = state.drawings
        .filter((d) => d.type === "hline" || d.type === "hray")
        .map((d) => new LevelAxisView(this, d));
    }
    this.redraw();
  }

  setStyle(style: DrawingsStyle): void {
    this.style = style;
    this.redraw();
  }

  /** Recompute projections and ask the chart to repaint (e.g. after bars changed). */
  redraw(): void {
    this.items = this.computeItems();
    this.requestUpdate?.();
  }

  /** Screen shapes of the committed drawings (no preview), in paint order. */
  shapes(): ScreenShape[] {
    const proj = this.projector();
    if (!proj) return [];
    const out: ScreenShape[] = [];
    for (const d of this.state.drawings) {
      const s = projectDrawing(d, proj);
      if (s) out.push(s);
    }
    return out;
  }

  hit(p: Pt): Hit | null {
    return hitTest(this.shapes(), p, this.state.selectedId);
  }

  renderItems(): readonly RenderItem[] { return this.items; }

  times(): readonly UnixSeconds[] {
    const t = this.getTimes();
    if (t !== this.timesRef) {
      this.timesRef = t;
      this.interval = barInterval(t);
    }
    return t;
  }

  timeToX(time: UnixSeconds): number | null {
    if (!this.chart) return null;
    const logical = timeToLogical(time, this.times(), this.interval);
    if (logical === null) return null;
    return this.logicalToX(logical);
  }

  /** logicalToCoordinate for fractional indexes (the library only handles integers). */
  logicalToX(logical: number): number | null {
    if (!this.chart) return null;
    const ts = this.chart.timeScale();
    return fractionalCoordinate(logical, (i) => ts.logicalToCoordinate(i as Logical));
  }

  /** Precise (fractional) logical index under x; the library rounds to an integer. */
  xToLogical(x: number): number | null {
    if (!this.chart) return null;
    const ts = this.chart.timeScale();
    return fractionalLogical(x, (c) => ts.coordinateToLogical(c), (i) => ts.logicalToCoordinate(i as Logical));
  }

  priceToY(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  formatPrice(price: number): string {
    return this.series ? this.series.priceFormatter().format(price) : price.toFixed(2);
  }

  projector(): Projector | null {
    if (!this.chart || !this.series) return null;
    return { timeToX: (t) => this.timeToX(t), priceToY: (p) => this.priceToY(p) };
  }

  private computeItems(): RenderItem[] {
    const proj = this.projector();
    if (!proj) return [];
    const { drawings, selectedId, preview } = this.state;
    const out: RenderItem[] = [];
    for (const d of drawings) {
      const shape = projectDrawing(d, proj);
      if (shape) out.push({ drawing: d, shape, selected: d.id === selectedId });
    }
    if (preview) {
      const shape = projectDrawing(preview, proj);
      if (shape) out.push({ drawing: preview, shape, selected: true });
    }
    return out;
  }
}
