// Pure geometry for drawings: time <-> logical index mapping, screen projection,
// hit-testing and drawing transforms. No DOM / chart dependencies so it can be unit tested.
import type { Drawing, DrawingPoint, DrawingType, UnixSeconds } from "@eodview/shared";

export interface Pt { x: number; y: number }

/** Hit tolerance in CSS pixels. */
export const HIT_TOLERANCE = 6;
/** Radius of the drag handles drawn on the selected drawing. */
export const HANDLE_RADIUS = 5;

export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Number of points needed to complete a drawing of the given type. */
export function pointsRequired(type: DrawingType): 1 | 2 {
  return type === "hline" || type === "hray" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// time <-> logical index
// ---------------------------------------------------------------------------

/** Typical spacing between bars in seconds (median of the last deltas); 86400 when unknown. */
export function barInterval(times: readonly UnixSeconds[]): number {
  const deltas: number[] = [];
  for (let i = Math.max(1, times.length - 64); i < times.length; i++) {
    const d = times[i]! - times[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 86400;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

/** Index of the last element <= t, or -1. `times` ascending. */
function floorIndex(times: readonly UnixSeconds[], t: UnixSeconds): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Maps a time to a (possibly fractional) logical bar index. Exact bar times map to their index,
 * times between bars interpolate, times outside the loaded range extrapolate with the bar interval.
 */
export function timeToLogical(t: UnixSeconds, times: readonly UnixSeconds[], interval = barInterval(times)): number | null {
  const n = times.length;
  if (n === 0) return null;
  const first = times[0]!;
  const last = times[n - 1]!;
  if (t <= first) return (t - first) / interval;
  if (t >= last) return n - 1 + (t - last) / interval;
  const i = floorIndex(times, t);
  const a = times[i]!;
  if (a === t) return i;
  const b = times[i + 1]!;
  return i + (t - a) / (b - a);
}

/** Inverse of timeToLogical. Fractional indexes inside the data interpolate between bar times. */
export function logicalToTime(logical: number, times: readonly UnixSeconds[], interval = barInterval(times)): UnixSeconds | null {
  const n = times.length;
  if (n === 0) return null;
  if (logical <= 0) return Math.round(times[0]! + logical * interval);
  if (logical >= n - 1) return Math.round(times[n - 1]! + (logical - (n - 1)) * interval);
  const i = Math.floor(logical);
  const frac = logical - i;
  const a = times[i]!;
  if (frac === 0) return a;
  return Math.round(a + (times[i + 1]! - a) * frac);
}

/**
 * Coordinate of a fractional logical index, interpolated between the two neighbouring integer
 * indexes (lightweight-charts' logicalToCoordinate only supports integers).
 */
export function fractionalCoordinate(logical: number, toCoord: (index: number) => number | null): number | null {
  const i = Math.floor(logical);
  const a = toCoord(i);
  if (a === null) return null;
  const frac = logical - i;
  if (frac === 0) return a;
  const b = toCoord(i + 1);
  return b === null ? null : a + (b - a) * frac;
}

/** Fractional logical index under x, given integer conversions in both directions. */
export function fractionalLogical(
  x: number,
  toLogical: (x: number) => number | null,
  toCoord: (index: number) => number | null,
): number | null {
  const l = toLogical(x);
  if (l === null) return null;
  const i = Math.round(l);
  const a = toCoord(i);
  const b = toCoord(i + 1);
  if (a === null || b === null || b === a) return i;
  return i + (x - a) / (b - a);
}

// ---------------------------------------------------------------------------
// distances
// ---------------------------------------------------------------------------

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from p to segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the horizontal ray starting at `origin` and going right. */
export function distToHRay(p: Pt, origin: Pt): number {
  if (p.x >= origin.x) return Math.abs(p.y - origin.y);
  return dist(p, origin);
}

// ---------------------------------------------------------------------------
// fib
// ---------------------------------------------------------------------------

export interface FibLevel { ratio: number; price: number }

/**
 * Retracement levels between p0 (start) and p1 (end). Level 0 sits at the end point and level 1
 * at the start point, matching TradingView (drawn low->high, 0.618 is measured back from the high).
 */
export function fibLevels(startPrice: number, endPrice: number, ratios: readonly number[] = FIB_LEVELS): FibLevel[] {
  return ratios.map((ratio) => ({ ratio, price: endPrice - (endPrice - startPrice) * ratio }));
}

// ---------------------------------------------------------------------------
// projection + hit testing
// ---------------------------------------------------------------------------

export interface Projector {
  timeToX(time: UnixSeconds): number | null;
  priceToY(price: number): number | null;
}

/** Screen-space version of a drawing. `pts[i]` corresponds to `drawing.points[i]`. */
export interface ScreenShape {
  id: string;
  type: DrawingType;
  pts: Pt[];
  /** fib only: y of each level, parallel to FIB_LEVELS */
  levels?: { ratio: number; price: number; y: number }[];
}

export function projectDrawing(d: Drawing, proj: Projector): ScreenShape | null {
  const pts: Pt[] = [];
  for (const p of d.points) {
    const y = proj.priceToY(p.price);
    // hline ignores time, so a missing x must not hide it
    const x = d.type === "hline" ? (proj.timeToX(p.time) ?? 0) : proj.timeToX(p.time);
    if (x === null || y === null) return null;
    pts.push({ x, y });
  }
  if (pts.length < pointsRequired(d.type)) return null;
  const shape: ScreenShape = { id: d.id, type: d.type, pts };
  if (d.type === "fib") {
    const levels: { ratio: number; price: number; y: number }[] = [];
    for (const l of fibLevels(d.points[0]!.price, d.points[1]!.price)) {
      const y = proj.priceToY(l.price);
      if (y === null) return null;
      levels.push({ ...l, y });
    }
    shape.levels = levels;
  }
  return shape;
}

/** Axis-aligned bounds of two points. */
export function bounds(a: Pt, b: Pt): { left: number; right: number; top: number; bottom: number } {
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
}

/** Distance from p to the body (strokes) of a shape. */
export function distToShape(shape: ScreenShape, p: Pt): number {
  const [a, b] = shape.pts;
  switch (shape.type) {
    case "hline":
      return Math.abs(p.y - a!.y);
    case "hray":
      return distToHRay(p, a!);
    case "trendline":
      return distToSegment(p, a!, b!);
    case "rect": {
      const r = bounds(a!, b!);
      const tl = { x: r.left, y: r.top };
      const tr = { x: r.right, y: r.top };
      const bl = { x: r.left, y: r.bottom };
      const br = { x: r.right, y: r.bottom };
      return Math.min(distToSegment(p, tl, tr), distToSegment(p, tr, br), distToSegment(p, br, bl), distToSegment(p, bl, tl));
    }
    case "fib": {
      const left = Math.min(a!.x, b!.x);
      const right = Math.max(a!.x, b!.x);
      let best = distToSegment(p, a!, b!);
      for (const l of shape.levels ?? []) {
        best = Math.min(best, distToSegment(p, { x: left, y: l.y }, { x: right, y: l.y }));
      }
      return best;
    }
  }
}

export type HitPart = { kind: "body" } | { kind: "handle"; index: number };
export interface Hit { id: string; part: HitPart; distance: number }

/**
 * Finds the drawing under p. Handles win over bodies (the selected drawing's handles first),
 * then the nearest body within tolerance; later (top-most) drawings win ties.
 */
export function hitTest(shapes: readonly ScreenShape[], p: Pt, selectedId: string | null, tol = HIT_TOLERANCE): Hit | null {
  const handleTol = Math.max(tol, HANDLE_RADIUS + 2);
  let best: Hit | null = null;
  let bestScore = Infinity;
  for (const s of shapes) {
    // hline's single point is a meaningless anchor on the x axis; only its line matters
    if (s.type !== "hline") {
      for (let i = 0; i < s.pts.length; i++) {
        const d = dist(p, s.pts[i]!);
        if (d <= handleTol) {
          // selected handles: score < 0 ; other handles: [0, handleTol]
          const score = (s.id === selectedId ? -1000 : 0) + d;
          if (score <= bestScore) { bestScore = score; best = { id: s.id, part: { kind: "handle", index: i }, distance: d }; }
        }
      }
    }
    const d = distToShape(s, p);
    if (d <= tol) {
      const score = 1000 + d; // bodies after any handle
      if (score <= bestScore) { bestScore = score; best = { id: s.id, part: { kind: "body" }, distance: d }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// transforms
// ---------------------------------------------------------------------------

/**
 * Moves all points of a drawing by a whole number of bars and a price delta.
 * Moving in logical space keeps points aligned to bars across gaps (weekends, holidays).
 */
export function translateDrawing(d: Drawing, dLogical: number, dPrice: number, times: readonly UnixSeconds[]): Drawing {
  const interval = barInterval(times);
  const points: DrawingPoint[] = d.points.map((p) => {
    let time = p.time;
    if (dLogical !== 0 && d.type !== "hline") {
      const l = timeToLogical(p.time, times, interval);
      if (l !== null) time = logicalToTime(l + dLogical, times, interval) ?? p.time;
    }
    return { time, price: p.price + dPrice };
  });
  return { ...d, points };
}

export function movePoint(d: Drawing, index: number, point: DrawingPoint): Drawing {
  return { ...d, points: d.points.map((p, i) => (i === index ? point : p)) };
}

/** "#rrggbb" / "#rgb" -> rgba(); other formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Validates an untrusted Drawing (e.g. from the server). */
export function isValidDrawing(d: unknown): d is Drawing {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Partial<Drawing>;
  const types: DrawingType[] = ["trendline", "hline", "hray", "rect", "fib"];
  return typeof o.id === "string"
    && typeof o.type === "string" && types.includes(o.type)
    && Array.isArray(o.points)
    && o.points.length >= pointsRequired(o.type)
    && o.points.every((p) => typeof p === "object" && p !== null && Number.isFinite(p.time) && Number.isFinite(p.price))
    && typeof o.color === "string";
}
