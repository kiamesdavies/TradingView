// Pure price/technical metrics for one symbol from its stored daily bars (see technicals.test.ts).
//
// Split/dividend handling: every stored row keeps EODHD's raw OHLC plus the adjusted close EODHD reported
// when the row was fetched. The per-row factor adj_close/close rescales that row's OHLC and volume, and the
// whole series is then expressed on the latest bar's basis (k = close/adj_close of the last row, normally 1)
// so SMAs, highs/lows and ATR compare directly with today's raw price. Returns use the same series.
// The pipeline keeps the stored adj_close consistent by re-pulling a symbol's history after a split or dividend.

export interface SymbolBars {
  date: string[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  adjClose: number[];
  volume: number[];
}

export interface TechOptions {
  /** True when the symbol's first bar is newer than the universe's first stored date (i.e. a recent listing):
   *  windows longer than its history then use what exists instead of reporting NULL. */
  listedWithinHistory?: boolean;
  /** Fallbacks from EODHD's extended bulk row, used while local history is too short. */
  bulk?: { hi250?: number | null; lo250?: number | null; avgVol50?: number | null } | null;
}

export type Row = Record<string, number | string | null>;

export const TECH_COLUMNS = [
  "price", "prev_close", "open", "change_pct", "change_from_open_pct", "gap_pct", "volume", "avg_volume",
  "rel_volume", "dollar_volume", "perf_1w", "perf_1m", "perf_3m", "perf_6m", "perf_ytd", "perf_1y",
  "sma20", "sma50", "sma200", "sma20_pct", "sma50_pct", "sma200_pct", "sma20_vs_sma50_pct", "sma50_vs_sma200_pct",
  "sma20_cross", "sma50_cross", "sma200_cross", "sma50_200_cross", "rsi14", "atr14", "atr_pct",
  "volatility_1w", "volatility_1m", "high_20d_pct", "low_20d_pct", "high_50d_pct", "low_50d_pct",
  "high_52w_pct", "low_52w_pct", "new_high", "new_low", "candlestick", "price_date",
] as const;

const pct = (a: number | null, b: number | null): number | null =>
  a === null || b === null || b === 0 || !Number.isFinite(a) || !Number.isFinite(b) ? null : (a / b - 1) * 100;

function mean(xs: number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i]!;
  return s / (to - from);
}

/** SMA of the last `k` values ending at index `end` (inclusive); null when not enough data. */
export function smaAt(xs: number[], k: number, end: number): number | null {
  if (k <= 0 || end - k + 1 < 0 || end >= xs.length) return null;
  return mean(xs, end - k + 1, end + 1);
}

/** Wilder RSI of the full series (value at the last element). */
export function wilderRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder ATR (value at the last bar). The seed averages the first `period` true ranges that have a prior close. */
export function wilderAtr(high: number[], low: number[], close: number[], period = 14): number | null {
  const n = close.length;
  if (n < period + 1) return null;
  const tr = (i: number) => Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr(i);
  atr /= period;
  for (let i = period + 1; i < n; i++) atr = (atr * (period - 1) + tr(i)) / period;
  return atr;
}

export type CrossState = "above" | "below" | "cross_above" | "cross_below";
/** Position of `now` vs `level` today, flagging a cross that happened between the previous and the last session. */
export function crossState(prev: number | null, prevLevel: number | null, now: number, level: number | null): CrossState | null {
  if (level === null) return null;
  const aboveNow = now >= level;
  if (prev === null || prevLevel === null) return aboveNow ? "above" : "below";
  const abovePrev = prev >= prevLevel;
  if (aboveNow && !abovePrev) return "cross_above";
  if (!aboveNow && abovePrev) return "cross_below";
  return aboveNow ? "above" : "below";
}

export type Candle = { o: number; h: number; l: number; c: number };
export type Pattern =
  | "doji" | "hammer" | "inverted_hammer" | "shooting_star" | "hanging_man"
  | "bullish_engulfing" | "bearish_engulfing" | "marubozu_white" | "marubozu_black" | "spinning_top";

/**
 * Last-bar candlestick pattern. `trend` is the prior short-term direction (-1 down, 1 up, 0 unknown) which
 * separates hammer/hanging man and inverted hammer/shooting star (same shapes, opposite context).
 * Precedence: engulfing, marubozu, doji, hammer family, spinning top.
 */
export function candlestick(cur: Candle, prev: Candle | null, trend: -1 | 0 | 1): Pattern | null {
  const range = cur.h - cur.l;
  if (!(range > 0)) return null;
  const body = Math.abs(cur.c - cur.o);
  const upper = cur.h - Math.max(cur.o, cur.c);
  const lower = Math.min(cur.o, cur.c) - cur.l;
  const bull = cur.c > cur.o, bear = cur.c < cur.o;

  if (prev) {
    const pBody = Math.abs(prev.c - prev.o);
    if (bull && prev.c < prev.o && cur.o <= prev.c && cur.c >= prev.o && body > pBody) return "bullish_engulfing";
    if (bear && prev.c > prev.o && cur.o >= prev.c && cur.c <= prev.o && body > pBody) return "bearish_engulfing";
  }
  if (body >= 0.9 * range && upper <= 0.05 * range && lower <= 0.05 * range) return bull ? "marubozu_white" : "marubozu_black";
  if (body <= 0.1 * range) return "doji";
  const smallBody = body <= 0.35 * range;
  if (smallBody && lower >= 2 * body && upper <= 0.15 * range) {
    if (trend < 0) return "hammer";
    if (trend > 0) return "hanging_man";
  }
  if (smallBody && upper >= 2 * body && lower <= 0.15 * range) {
    if (trend < 0) return "inverted_hammer";
    if (trend > 0) return "shooting_star";
  }
  if (body <= 0.3 * range && upper >= body && lower >= body) return "spinning_top";
  return null;
}

/** Clean + adjust a symbol's bars. Rows with non-positive or non-finite prices are dropped. */
export function adjustedSeries(b: SymbolBars) {
  const date: string[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  const rawClose: number[] = [], rawOpen: number[] = [], rawVol: number[] = [];
  for (let i = 0; i < b.close.length; i++) {
    const cl = b.close[i]!, ad = b.adjClose[i]!;
    if (!(cl > 0) || !Number.isFinite(cl)) continue;
    const op = b.open[i]! > 0 ? b.open[i]! : cl, hi = b.high[i]! > 0 ? b.high[i]! : cl, lo = b.low[i]! > 0 ? b.low[i]! : cl;
    const f = ad > 0 && Number.isFinite(ad) ? ad / cl : 1;
    date.push(b.date[i]!);
    o.push(op * f); h.push(Math.max(hi, op, cl) * f); l.push(Math.min(lo, op, cl) * f); c.push(cl * f);
    const vol = Number.isFinite(b.volume[i]!) && b.volume[i]! > 0 ? b.volume[i]! : 0;
    v.push(vol / f);
    rawClose.push(cl); rawOpen.push(op); rawVol.push(vol);
  }
  const n = c.length;
  if (n) {
    // Express everything on the last bar's basis so levels compare with today's raw price.
    const k = rawClose[n - 1]! / c[n - 1]!;
    if (k !== 1) for (let i = 0; i < n; i++) { o[i] = o[i]! * k; h[i] = h[i]! * k; l[i] = l[i]! * k; c[i] = c[i]! * k; v[i] = v[i]! / k; }
  }
  return { date, o, h, l, c, v, rawClose, rawOpen, rawVol };
}

/** All price/technical columns of universe_metrics for one symbol. Empty history → all NULL. */
export function computeTechnicals(bars: SymbolBars, opts: TechOptions = {}): Row {
  const out: Row = {};
  for (const col of TECH_COLUMNS) out[col] = null;
  const s = adjustedSeries(bars);
  const n = s.c.length;
  if (!n) return out;
  const last = n - 1;
  const young = !!opts.listedWithinHistory;
  const enough = (k: number) => n >= k || (young && n >= 2);
  const bulk = opts.bulk ?? null;

  const price = s.rawClose[last]!;
  const prevClose = n >= 2 ? s.c[last - 1]! : null;
  const open = s.rawOpen[last]!;
  out.price = price;
  out.price_date = s.date[last]!;
  out.open = open;
  out.prev_close = prevClose;
  out.change_pct = pct(price, prevClose);
  out.change_from_open_pct = pct(price, open);
  out.gap_pct = pct(open, prevClose);

  // ---- volume
  const volume = s.rawVol[last]!;
  out.volume = volume;
  let avgVol: number | null = null;
  if (n >= 63) avgVol = mean(s.v, n - 63, n);
  else if (young && n >= 5) avgVol = mean(s.v, 0, n);
  else if (bulk?.avgVol50 && bulk.avgVol50 > 0) avgVol = bulk.avgVol50;
  else if (n >= 5) avgVol = mean(s.v, 0, n);
  out.avg_volume = avgVol;
  out.rel_volume = avgVol && avgVol > 0 ? volume / avgVol : null;
  out.dollar_volume = avgVol !== null ? price * avgVol : null;

  // ---- performance
  const perf = (k: number) => (n > k ? pct(s.c[last]!, s.c[last - k]!) : null);
  out.perf_1w = perf(5);
  out.perf_1m = perf(21);
  out.perf_3m = perf(63);
  out.perf_6m = perf(126);
  out.perf_1y = perf(252);
  const yearStart = `${s.date[last]!.slice(0, 4)}-01-01`;
  let ytdBase = -1;
  for (let i = last; i >= 0; i--) if (s.date[i]! < yearStart) { ytdBase = i; break; }
  out.perf_ytd = ytdBase >= 0 ? pct(s.c[last]!, s.c[ytdBase]!) : null;

  // ---- moving averages & crosses
  const sma = (k: number, end: number) => smaAt(s.c, k, end);
  const sma20 = sma(20, last), sma50 = sma(50, last), sma200 = sma(200, last);
  out.sma20 = sma20; out.sma50 = sma50; out.sma200 = sma200;
  out.sma20_pct = pct(price, sma20);
  out.sma50_pct = pct(price, sma50);
  out.sma200_pct = pct(price, sma200);
  out.sma20_vs_sma50_pct = pct(sma20, sma50);
  out.sma50_vs_sma200_pct = pct(sma50, sma200);
  const prevC = n >= 2 ? s.c[last - 1]! : null;
  out.sma20_cross = crossState(prevC, sma(20, last - 1), price, sma20);
  out.sma50_cross = crossState(prevC, sma(50, last - 1), price, sma50);
  out.sma200_cross = crossState(prevC, sma(200, last - 1), price, sma200);
  out.sma50_200_cross = sma50 === null || sma200 === null ? null : crossState(sma(50, last - 1), sma(200, last - 1), sma50, sma200);

  // ---- oscillators / volatility
  out.rsi14 = wilderRsi(s.c, 14);
  const atr = wilderAtr(s.h, s.l, s.c, 14);
  out.atr14 = atr;
  out.atr_pct = atr === null ? null : (atr / price) * 100;
  const vol = (k: number) => {
    if (n < k) return null;
    let sum = 0;
    for (let i = n - k; i < n; i++) sum += ((s.h[i]! - s.l[i]!) / s.c[i]!) * 100;
    return sum / k;
  };
  out.volatility_1w = vol(5);
  out.volatility_1m = vol(21);

  // ---- highs / lows
  const hiLo = (k: number): [number, number] | null => {
    if (!enough(k)) return null;
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.max(0, n - k); i < n; i++) { if (s.h[i]! > hi) hi = s.h[i]!; if (s.l[i]! < lo) lo = s.l[i]!; }
    return [hi, lo];
  };
  const w20 = hiLo(20), w50 = hiLo(50);
  let w252 = hiLo(252);
  if (!w252 && bulk?.hi250 && bulk?.lo250 && bulk.hi250 > 0 && bulk.lo250 > 0) {
    // EODHD's 250-day range; widen with today's bar in case it isn't included yet.
    w252 = [Math.max(bulk.hi250, s.h[last]!), Math.min(bulk.lo250, s.l[last]!)];
  }
  out.high_20d_pct = w20 ? pct(price, w20[0]) : null;
  out.low_20d_pct = w20 ? pct(price, w20[1]) : null;
  out.high_50d_pct = w50 ? pct(price, w50[0]) : null;
  out.low_50d_pct = w50 ? pct(price, w50[1]) : null;
  out.high_52w_pct = w252 ? pct(price, w252[0]) : null;
  out.low_52w_pct = w252 ? pct(price, w252[1]) : null;
  if (n >= 2) {
    const hToday = s.h[last]!, lToday = s.l[last]!;
    const newHigh = (w: [number, number] | null) => w !== null && hToday >= w[0];
    const newLow = (w: [number, number] | null) => w !== null && lToday <= w[1];
    out.new_high = newHigh(w252) ? "52w" : newHigh(w50) ? "50d" : newHigh(w20) ? "20d" : null;
    out.new_low = newLow(w252) ? "52w" : newLow(w50) ? "50d" : newLow(w20) ? "20d" : null;
  }

  // ---- candlestick
  const cur = { o: s.o[last]!, h: s.h[last]!, l: s.l[last]!, c: s.c[last]! };
  const prev = n >= 2 ? { o: s.o[last - 1]!, h: s.h[last - 1]!, l: s.l[last - 1]!, c: s.c[last - 1]! } : null;
  let trend: -1 | 0 | 1 = 0;
  if (n >= 7) {
    const d = s.c[last - 1]! - s.c[last - 6]!;
    trend = d > 0 ? 1 : d < 0 ? -1 : 0;
  }
  out.candlestick = candlestick(cur, prev, trend);
  return out;
}
