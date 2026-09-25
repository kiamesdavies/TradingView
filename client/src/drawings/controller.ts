// Mouse / keyboard interaction for drawings on one chart instance.
// Owns the DrawingsPrimitive attached to handle.mainSeries; state lives in useDrawingStore.
import type { IChartApi } from "lightweight-charts";
import type { Drawing, DrawingPoint, DrawingType, UnixSeconds } from "@eodview/shared";
import type { ChartHandle } from "../chart/types";
import { useStore } from "../state/store";
import { newDrawingId, useDrawingStore } from "./drawingStore";
import { DARK_STYLE, DrawingsPrimitive, LIGHT_STYLE } from "./DrawingsPrimitive";
import { logicalToTime, movePoint, pointsRequired, translateDrawing, type HitPart, type Pt } from "./geometry";

/** A mouse press+release farther apart than this counts as a drag (drag-to-create). */
const DRAG_CREATE_PX = 5;

interface Pending { type: DrawingType; first: DrawingPoint; firstPx: Pt; color: string }

interface DragState {
  id: string;
  part: HitPart;
  original: Drawing;
  startLogical: number;
  startPrice: number;
}

/** Disables chart scroll/scale while any reason holds it and restores the previous options afterwards. */
class ScrollLock {
  private readonly reasons = new Set<string>();
  private saved: Pick<ReturnType<IChartApi["options"]>, "handleScroll" | "handleScale"> | null = null;
  constructor(private readonly handle: ChartHandle) {}

  set(reason: string, on: boolean): void {
    const before = this.reasons.size > 0;
    if (on) this.reasons.add(reason); else this.reasons.delete(reason);
    const after = this.reasons.size > 0;
    if (before === after) return;
    const chart = this.handle.chart;
    if (after) {
      const o = chart.options();
      // options() exposes live objects that applyOptions mutates, so snapshot them
      this.saved = structuredClone({ handleScroll: o.handleScroll, handleScale: o.handleScale });
      chart.applyOptions({ handleScroll: false, handleScale: false });
    } else if (this.saved) {
      chart.applyOptions(this.saved);
      this.saved = null;
    }
  }

  release(): void {
    this.reasons.clear();
    if (this.saved) {
      try { this.handle.chart.applyOptions(this.saved); } catch { /* chart removed */ }
      this.saved = null;
    }
  }
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

export class DrawingController {
  readonly primitive: DrawingsPrimitive;
  private readonly el: HTMLElement;
  private readonly lock: ScrollLock;
  private readonly cleanups: (() => void)[] = [];
  private times: readonly UnixSeconds[] = [];
  private pending: Pending | null = null;
  private preview: Drawing | null = null;
  private drag: DragState | null = null;
  /** Tool reset is deferred to pointerup so the chart does not start panning mid-click. */
  private resetToolOnUp = false;
  private disposed = false;

  constructor(private readonly handle: ChartHandle) {
    this.el = handle.chart.chartElement();
    this.lock = new ScrollLock(handle);
    this.times = handle.getBars().map((b) => b.time);
    this.primitive = new DrawingsPrimitive(() => this.times);
    handle.mainSeries.attachPrimitive(this.primitive);

    this.cleanups.push(handle.onBarsChanged((bars) => {
      this.times = bars.map((b) => b.time);
      this.primitive.redraw();
    }));

    this.cleanups.push(useDrawingStore.subscribe(() => this.pushState()));

    let tool = useStore.getState().ui.drawingTool;
    this.cleanups.push(useStore.subscribe((s) => {
      if (s.ui.drawingTool === tool) return;
      tool = s.ui.drawingTool;
      this.onToolChange();
    }));
    this.onToolChange();

    const onDown = (e: PointerEvent) => this.onPointerDown(e);
    const onMove = (e: PointerEvent) => this.onPointerMove(e);
    const onUp = (e: PointerEvent) => this.onPointerUp(e);
    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    // capture phase: runs before the chart's own handlers so scroll can be disabled in time
    this.el.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    this.cleanups.push(() => {
      this.el.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    });

    this.pushState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) c();
    this.lock.release();
    try { this.handle.mainSeries.detachPrimitive(this.primitive); } catch { /* series already removed */ }
  }

  setTheme(theme: "dark" | "light"): void {
    this.primitive.setStyle(theme === "light" ? LIGHT_STYLE : DARK_STYLE);
  }

  // ---------------------------------------------------------------- state

  private pushState(): void {
    const s = useDrawingStore.getState();
    this.primitive.setState({ drawings: s.drawings, selectedId: s.selectedId, preview: this.preview });
  }

  private tool(): DrawingType | "cursor" {
    return useStore.getState().ui.drawingTool;
  }

  private onToolChange(): void {
    this.cancelPending();
    const creating = this.tool() !== "cursor";
    this.primitive.interactive = !creating;
    this.lock.set("tool", creating);
    if (creating) useDrawingStore.getState().select(null);
    this.el.style.cursor = creating ? "crosshair" : "";
  }

  private cancelPending(): void {
    this.pending = null;
    if (this.preview) {
      this.preview = null;
      this.pushState();
    }
  }

  // ---------------------------------------------------------------- coordinates

  /** Pointer position relative to pane 0, or null when outside it (axes, other panes). */
  private local(e: { clientX: number; clientY: number }, clamp = false): Pt | null {
    const rect = this.el.getBoundingClientRect();
    const chart = this.handle.chart;
    const leftW = chart.priceScale("left").width();
    const size = chart.paneSize(0);
    let x = e.clientX - rect.left - leftW;
    let y = e.clientY - rect.top;
    if (clamp) {
      x = Math.max(0, Math.min(size.width, x));
      y = Math.max(0, Math.min(size.height, y));
      return { x, y };
    }
    if (x < 0 || y < 0 || x > size.width || y > size.height) return null;
    return { x, y };
  }

  private rawLogical(x: number): number | null {
    return this.primitive.xToLogical(x);
  }

  private rawPrice(y: number): number | null {
    return this.handle.mainSeries.coordinateToPrice(y);
  }

  /** Pixel -> (time, price) snapped to a bar; extrapolates beyond the loaded data. */
  private toPoint(p: Pt): DrawingPoint | null {
    const viaChart = this.handle.coordinateToPoint(p.x, p.y);
    if (viaChart) return { time: viaChart.time, price: viaChart.price };
    const logical = this.rawLogical(p.x);
    const price = this.rawPrice(p.y);
    if (logical === null || price === null) return null;
    const time = logicalToTime(Math.round(logical), this.times);
    return time === null ? null : { time, price };
  }

  // ---------------------------------------------------------------- pointer

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.local(e);
    if (!p) return;
    const tool = this.tool();

    if (tool !== "cursor") {
      e.preventDefault();
      const pt = this.toPoint(p);
      if (!pt) return;
      if (!this.pending) {
        const color = useStore.getState().ui.drawingColor;
        if (pointsRequired(tool) === 1) {
          this.commit({ id: newDrawingId(), type: tool, points: [pt], color, lineWidth: 2 });
          return;
        }
        this.pending = { type: tool, first: pt, firstPx: p, color };
        this.updatePreview(pt);
      } else {
        this.commitPending(pt);
      }
      return;
    }

    const hit = this.primitive.hit(p);
    const store = useDrawingStore.getState();
    if (!hit) {
      if (store.selectedId) store.select(null);
      return; // let the chart pan
    }
    const drawing = store.drawings.find((d) => d.id === hit.id);
    const logical = this.rawLogical(p.x);
    const price = this.rawPrice(p.y);
    if (!drawing || logical === null || price === null) return;
    e.preventDefault();
    e.stopPropagation();
    store.select(hit.id);
    this.drag = { id: hit.id, part: hit.part, original: drawing, startLogical: logical, startPrice: price };
    this.lock.set("drag", true);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag) {
      this.dragTo(e);
      return;
    }
    if (this.pending) {
      const p = this.local(e, true);
      const pt = p && this.toPoint(p);
      if (pt) this.updatePreview(pt);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag) {
      this.dragTo(e);
      this.drag = null;
      this.lock.set("drag", false);
      return;
    }
    // drag-to-create: press on the first point, release on the second
    if (this.pending && e.button === 0) {
      const p = this.local(e, true);
      if (p && Math.hypot(p.x - this.pending.firstPx.x, p.y - this.pending.firstPx.y) > DRAG_CREATE_PX) {
        const pt = this.toPoint(p);
        if (pt) this.commitPending(pt);
      }
    }
    if (this.resetToolOnUp) {
      this.resetToolOnUp = false;
      useStore.getState().setUi({ drawingTool: "cursor" });
    }
  }

  private dragTo(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const p = this.local(e, true);
    if (!p) return;
    let next: Drawing | null = null;
    if (drag.part.kind === "handle") {
      const pt = this.toPoint(p);
      if (pt) next = movePoint(drag.original, drag.part.index, pt);
    } else {
      const logical = this.rawLogical(p.x);
      const price = this.rawPrice(p.y);
      if (logical !== null && price !== null) {
        next = translateDrawing(drag.original, Math.round(logical - drag.startLogical), price - drag.startPrice, this.times);
      }
    }
    if (!next) return;
    const current = useDrawingStore.getState().drawings.find((d) => d.id === drag.id);
    if (!current) { this.drag = null; this.lock.set("drag", false); return; }
    if (samePoints(current, next)) return;
    useDrawingStore.getState().update(next);
  }

  // ---------------------------------------------------------------- creation

  private updatePreview(second: DrawingPoint): void {
    const pd = this.pending;
    if (!pd) return;
    this.preview = { id: "__preview__", type: pd.type, points: [pd.first, second], color: pd.color, lineWidth: 2 };
    this.pushState();
  }

  private commitPending(second: DrawingPoint): void {
    const pd = this.pending;
    if (!pd) return;
    this.pending = null;
    this.preview = null;
    this.commit({ id: newDrawingId(), type: pd.type, points: [pd.first, second], color: pd.color, lineWidth: 2 });
  }

  private commit(d: Drawing): void {
    useDrawingStore.getState().add(d);
    this.resetToolOnUp = true;
  }

  // ---------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) return;
    if (e.key === "Escape") {
      if (this.drag) {
        useDrawingStore.getState().update(this.drag.original);
        this.drag = null;
        this.lock.set("drag", false);
      }
      const hadWork = this.pending !== null || this.tool() !== "cursor" || useDrawingStore.getState().selectedId !== null;
      this.cancelPending();
      if (this.tool() !== "cursor") useStore.getState().setUi({ drawingTool: "cursor" });
      useDrawingStore.getState().select(null);
      if (hadWork) e.preventDefault();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const { selectedId, remove } = useDrawingStore.getState();
      if (!selectedId || this.drag) return;
      e.preventDefault();
      remove(selectedId);
    }
  }
}

function samePoints(a: Drawing, b: Drawing): boolean {
  return a.points.length === b.points.length
    && a.points.every((p, i) => p.time === b.points[i]!.time && p.price === b.points[i]!.price);
}
