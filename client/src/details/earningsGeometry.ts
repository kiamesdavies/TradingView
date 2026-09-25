// Pure scale/geometry for the details-panel earnings chart (EPS dots / revenue bars). Covered by earningsGeometry.test.ts.
import type { EarningsPoint, RevenuePoint } from "@eodview/shared";
import { formatCompact, quarterLabel } from "./format";

export interface ChartBox {
  width: number;
  height: number;
  /** Space reserved on the right for the y-axis labels. */
  axisWidth?: number;
  /** Space reserved at the bottom for the x labels. */
  labelHeight?: number;
  padTop?: number;
  padLeft?: number;
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
  step: number;
}

const NICE = [1, 2, 2.5, 5, 10];

/** Smallest "nice" step >= raw (1, 2, 2.5, 5 × 10^k). */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const n of NICE) if (n * mag >= raw * (1 - 1e-9)) return n * mag;
  return 10 * mag;
}

/** Round away float noise (0.30000000000000004 -> 0.3). */
const clean = (v: number) => Number(v.toPrecision(12));

/**
 * Nice linear scale covering [lo, hi] with at most `maxTicks` ticks (min 2 intervals when possible).
 * Degenerate ranges (single value / all equal) are padded symmetrically; `includeZero` forces 0 into the domain.
 */
export function niceScale(values: readonly number[], maxTicks = 5, includeZero = false): Scale | null {
  const vs = values.filter((v) => Number.isFinite(v));
  if (vs.length === 0) return null;
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi - lo < 1e-12) {
    const pad = Math.abs(hi) > 1e-12 ? Math.abs(hi) * 0.25 : 1;
    if (includeZero && lo === 0 && hi === 0) {
      hi = 1;
    } else if (includeZero && lo >= 0) {
      hi += pad;
    } else if (includeZero && hi <= 0) {
      lo -= pad;
    } else {
      lo -= pad;
      hi += pad;
    }
  }
  const intervals = Math.max(1, maxTicks - 1);
  let step = niceStep((hi - lo) / intervals);
  let min = Math.floor(lo / step + 1e-9) * step;
  let max = Math.ceil(hi / step - 1e-9) * step;
  // Rounding outward can add an interval; widen the step until the tick budget fits.
  for (let guard = 0; guard < 10 && Math.round((max - min) / step) + 1 > maxTicks; guard++) {
    step = niceStep(step * 1.5);
    min = Math.floor(lo / step + 1e-9) * step;
    max = Math.ceil(hi / step - 1e-9) * step;
  }
  if (max - min < 1e-12) max = min + step;
  const ticks: number[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) ticks.push(clean(min + i * step));
  return { min: clean(min), max: clean(max), ticks, step: clean(step) };
}

/** Decimals needed to print ticks at this step (0.25 -> 2, 0.5 -> 1, 2 -> 0). */
export function stepDecimals(step: number): number {
  for (let d = 0; d <= 6; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) return d;
  return 6;
}

export type DotKind = "estimate" | "beat" | "miss" | "actual";

export interface Dot {
  kind: DotKind;
  cx: number;
  cy: number;
  value: number;
}

export interface Column {
  index: number;
  label: string;
  showLabel: boolean;
  /** Center x and hover band. */
  cx: number;
  bandLeft: number;
  bandWidth: number;
}

export interface YTick {
  value: number;
  y: number;
  label: string;
}

export interface Plot {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EpsChartGeometry {
  plot: Plot;
  ticks: YTick[];
  columns: Column[];
  /** Dots per column (estimate first, so the actual draws on top). */
  dots: Dot[][];
  zeroY: number | null;
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  negative: boolean;
}

export interface RevenueChartGeometry {
  plot: Plot;
  ticks: YTick[];
  columns: Column[];
  bars: (Bar | null)[];
  zeroY: number;
}

function layout(box: ChartBox): Plot {
  const axisWidth = box.axisWidth ?? 40;
  const labelHeight = box.labelHeight ?? 20;
  const padTop = box.padTop ?? 8;
  const padLeft = box.padLeft ?? 4;
  const right = Math.max(padLeft + 10, box.width - axisWidth);
  const bottom = Math.max(padTop + 10, box.height - labelHeight);
  return { left: padLeft, top: padTop, right, bottom };
}

/** Approximate width of one x label ("Q3 '25") at 11px. */
export const X_LABEL_WIDTH = 38;

function columnsFor(labels: string[], plot: Plot): Column[] {
  const n = labels.length;
  const w = n > 0 ? (plot.right - plot.left) / n : 0;
  // Thin labels on narrow widths: keep every k-th, always including the last (most recent / upcoming).
  const k = n > 0 ? Math.max(1, Math.ceil(X_LABEL_WIDTH / Math.max(1, w))) : 1;
  return labels.map((label, i) => ({
    index: i,
    label,
    showLabel: (n - 1 - i) % k === 0,
    cx: plot.left + (i + 0.5) * w,
    bandLeft: plot.left + i * w,
    bandWidth: w,
  }));
}

function yMapper(scale: Scale, plot: Plot): (v: number) => number {
  const span = scale.max - scale.min || 1;
  return (v) => plot.bottom - ((v - scale.min) / span) * (plot.bottom - plot.top);
}

export function classifyActual(actual: number, estimate: number | null): DotKind {
  if (estimate === null || !Number.isFinite(estimate)) return "actual";
  return actual >= estimate - 1e-9 ? "beat" : "miss";
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** EPS dot chart: hollow estimate + filled actual per quarter; upcoming quarters only show the estimate. */
export function epsChartGeometry(points: readonly EarningsPoint[], box: ChartBox): EpsChartGeometry | null {
  const values: number[] = [];
  for (const p of points) {
    if (finite(p.epsEstimate)) values.push(p.epsEstimate);
    if (!p.upcoming && finite(p.epsActual)) values.push(p.epsActual);
  }
  const scale = niceScale(values, 5);
  if (!scale) return null;
  const plot = layout(box);
  const y = yMapper(scale, plot);
  const columns = columnsFor(points.map((p) => quarterLabel(p.period)), plot);
  const dots = points.map((p, i) => {
    const out: Dot[] = [];
    const cx = columns[i].cx;
    if (finite(p.epsEstimate)) out.push({ kind: "estimate", cx, cy: y(p.epsEstimate), value: p.epsEstimate });
    if (!p.upcoming && finite(p.epsActual)) {
      out.push({ kind: classifyActual(p.epsActual, finite(p.epsEstimate) ? p.epsEstimate : null), cx, cy: y(p.epsActual), value: p.epsActual });
    }
    return out;
  });
  const dec = stepDecimals(scale.step);
  const ticks = scale.ticks.map((v) => ({ value: v, y: y(v), label: tickLabel(v, dec) }));
  const zeroY = scale.min < 0 && scale.max > 0 ? y(0) : null;
  return { plot, ticks, columns, dots, zeroY };
}

function tickLabel(v: number, dec: number): string {
  const s = v.toFixed(dec);
  return Number(s) === 0 ? (0).toFixed(dec) : s.replace(/^-/, "−");
}

/** Revenue bar chart from a zero baseline (negative values hang below it). */
export function revenueChartGeometry(points: readonly RevenuePoint[], box: ChartBox): RevenueChartGeometry | null {
  const values = points.map((p) => p.revenue).filter(finite);
  const scale = niceScale(values, 5, true);
  if (!scale) return null;
  const plot = layout(box);
  const y = yMapper(scale, plot);
  const columns = columnsFor(points.map((p) => quarterLabel(p.period)), plot);
  const zeroY = y(0);
  const bars = points.map((p, i) => {
    if (!finite(p.revenue)) return null;
    const c = columns[i];
    const width = Math.max(2, Math.min(28, c.bandWidth * 0.55));
    const vy = y(p.revenue);
    return {
      x: c.cx - width / 2,
      y: Math.min(vy, zeroY),
      width,
      height: Math.max(1, Math.abs(zeroY - vy)),
      value: p.revenue,
      negative: p.revenue < 0,
    };
  });
  const ticks = scale.ticks.map((v) => ({ value: v, y: y(v), label: v === 0 ? "0" : trimZeros(formatCompact(v)) }));
  return { plot, ticks, columns, bars, zeroY };
}

/** "150.0B" -> "150B", "2.50B" -> "2.5B", "1.25M" unchanged. */
export function trimZeros(label: string): string {
  return label.replace(/(\.\d*?)0+(?=[KMBT]?$)/, "$1").replace(/\.(?=[KMBT]?$)/, "");
}

/** Column index under an x coordinate (in chart space), or null outside the plot. */
export function columnAt(columns: readonly Column[], x: number): number | null {
  for (const c of columns) if (x >= c.bandLeft && x < c.bandLeft + c.bandWidth) return c.index;
  return null;
}

/** Surprise % recomputed when the API left it null: (actual − est) / |est|. */
export function surprisePct(p: EarningsPoint): number | null {
  if (finite(p.surprisePct)) return p.surprisePct;
  if (!finite(p.epsActual) || !finite(p.epsEstimate) || p.epsEstimate === 0) return null;
  return ((p.epsActual - p.epsEstimate) / Math.abs(p.epsEstimate)) * 100;
}
