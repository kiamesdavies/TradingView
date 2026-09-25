// Pure technical-indicator math. Every function takes ascending `Bar[]` and returns `{time, value}` points
// aligned to the bar times. Warmup bars (where the indicator is undefined) are skipped, so outputs are NaN-free
// and may be shorter than the input (or empty when there are not enough bars).
import type { Bar, UnixSeconds } from "../types";

export interface IndicatorPoint {
  time: UnixSeconds;
  value: number;
}

export type PriceSource = "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4";
export const PRICE_SOURCES: PriceSource[] = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

export function isPriceSource(v: unknown): v is PriceSource {
  return typeof v === "string" && (PRICE_SOURCES as string[]).includes(v);
}

export function sourceValue(bar: Bar, source: PriceSource): number {
  switch (source) {
    case "close": return bar.close;
    case "open": return bar.open;
    case "high": return bar.high;
    case "low": return bar.low;
    case "hl2": return (bar.high + bar.low) / 2;
    case "hlc3": return (bar.high + bar.low + bar.close) / 3;
    case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

export function sourceValues(bars: readonly Bar[], source: PriceSource = "close"): number[] {
  return bars.map((b) => sourceValue(b, source));
}

function assertPeriod(period: number, name = "period"): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`${name} must be a positive integer, got ${period}`);
}

// ---------- array-level primitives (value[] -> value[] with NaN during warmup) ----------

/** Rolling simple mean; NaN until `period` values are available. */
export function smaValues(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average with k = 2/(period+1), seeded with the SMA of the first `period` values
 * (the TradingView / TA-Lib convention). Leading NaNs in `values` are skipped before seeding.
 */
export function emaValues(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let start = 0;
  while (start < values.length && Number.isNaN(values[start]!)) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i]!;
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA, alpha = 1/period), seeded with the SMA of the first `period` values. */
export function rmaValues(values: readonly number[], period: number): number[] {
  assertPeriod(period);
  const out = new Array<number>(values.length).fill(NaN);
  let start = 0;
  while (start < values.length && Number.isNaN(values[start]!)) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i]!;
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Zip bar times with values, dropping non-finite (warmup) entries. */
export function toPoints(bars: readonly Bar[], values: readonly number[]): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  const n = Math.min(bars.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) out.push({ time: bars[i]!.time, value: v });
  }
  return out;
}

// ---------- indicators ----------

export function sma(bars: readonly Bar[], period = 20, source: PriceSource = "close"): IndicatorPoint[] {
  return toPoints(bars, smaValues(sourceValues(bars, source), period));
}

export function ema(bars: readonly Bar[], period = 20, source: PriceSource = "close"): IndicatorPoint[] {
  return toPoints(bars, emaValues(sourceValues(bars, source), period));
}

/**
 * Relative Strength Index (Wilder). The first value is at index `period` (needs `period` price changes);
 * average gain/loss are seeded with simple means and then Wilder-smoothed.
 */
export function rsi(bars: readonly Bar[], period = 14, source: PriceSource = "close"): IndicatorPoint[] {
  assertPeriod(period);
  const src = sourceValues(bars, source);
  const out: IndicatorPoint[] = [];
  if (src.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = src[i]! - src[i - 1]!;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const value = (): number => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out.push({ time: bars[period]!.time, value: value() });
  for (let i = period + 1; i < src.length; i++) {
    const d = src[i]! - src[i - 1]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: bars[i]!.time, value: value() });
  }
  return out;
}

export interface MacdResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

/**
 * MACD = EMA(fast) − EMA(slow); signal = EMA(signal) of the MACD line (seeded with SMA of the first `signal`
 * MACD values); histogram = MACD − signal. The MACD line starts at bar `slow-1`, signal/histogram at `slow+signal-2`.
 */
export function macd(
  bars: readonly Bar[], fast = 12, slow = 26, signal = 9, source: PriceSource = "close",
): MacdResult {
  assertPeriod(fast, "fast");
  assertPeriod(slow, "slow");
  assertPeriod(signal, "signal");
  const src = sourceValues(bars, source);
  const f = emaValues(src, fast);
  const s = emaValues(src, slow);
  const line = f.map((v, i) => v - s[i]!);
  const sig = emaValues(line, signal);
  const hist = line.map((v, i) => v - sig[i]!);
  return { macd: toPoints(bars, line), signal: toPoints(bars, sig), histogram: toPoints(bars, hist) };
}

export interface BollingerResult {
  middle: IndicatorPoint[];
  upper: IndicatorPoint[];
  lower: IndicatorPoint[];
}

/** Bollinger Bands: SMA(period) ± stdDev × population standard deviation over the same window. */
export function bollinger(
  bars: readonly Bar[], period = 20, stdDev = 2, source: PriceSource = "close",
): BollingerResult {
  assertPeriod(period);
  const src = sourceValues(bars, source);
  const middle: IndicatorPoint[] = [];
  const upper: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i]!;
    if (i >= period) sum -= src[i - period]!;
    if (i < period - 1) continue;
    const mean = sum / period;
    // Two-pass variance over the window: numerically stable and cheap for typical periods.
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = src[j]! - mean;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / period);
    const time = bars[i]!.time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + stdDev * sd });
    lower.push({ time, value: mean - stdDev * sd });
  }
  return { middle, upper, lower };
}

/** True range per bar; the first bar uses high − low (no previous close). */
export function trueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

/**
 * Average True Range (Wilder). Seeded with the simple mean of TR over bars 1..period (the first bar has no
 * previous close, so it is excluded, matching Wilder / TA-Lib); first value at index `period`.
 */
export function atr(bars: readonly Bar[], period = 14): IndicatorPoint[] {
  assertPeriod(period);
  const tr = trueRange(bars);
  tr[0] = NaN; // exclude the first bar from the seed
  return toPoints(bars, rmaValues(tr, period));
}

export type VwapAnchor = "session" | "cumulative";

/**
 * Volume-weighted average price of the typical price (default hlc3).
 * - `session`: resets at every UTC day boundary — use for intraday timeframes (US equity sessions do not cross
 *   00:00 UTC; crypto/forex reset at 00:00 UTC, as TradingView does).
 * - `cumulative`: anchored to the first bar passed in — use for daily and higher timeframes, so it is the VWAP
 *   of the loaded history and shifts when older history is backfilled.
 * Bars with zero volume contribute nothing; while the anchor's cumulative volume is still zero (e.g. forex feeds
 * without volume) the value falls back to the equal-weighted mean of the source over the anchor period.
 */
export function vwap(
  bars: readonly Bar[], anchor: VwapAnchor = "session", source: PriceSource = "hlc3",
): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let pv = 0;
  let vol = 0;
  let plain = 0;
  let count = 0;
  let day = Number.NaN;
  for (const b of bars) {
    if (anchor === "session") {
      const d = Math.floor(b.time / 86_400);
      if (d !== day) {
        day = d;
        pv = 0; vol = 0; plain = 0; count = 0;
      }
    }
    const p = sourceValue(b, source);
    const v = b.volume > 0 && Number.isFinite(b.volume) ? b.volume : 0;
    pv += p * v;
    vol += v;
    plain += p;
    count++;
    out.push({ time: b.time, value: vol > 0 ? pv / vol : plain / count });
  }
  return out;
}

/** Simple moving average of volume. */
export function volumeMa(bars: readonly Bar[], period = 20): IndicatorPoint[] {
  return toPoints(bars, smaValues(bars.map((b) => b.volume), period));
}
