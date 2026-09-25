import type { Bar, Tick, Timeframe, UnixSeconds } from "@eodview/shared";

// Pure candle math shared by the chart: time bucketing, live-tick aggregation and Heikin-Ashi.
// Everything here is side-effect free so it can be unit tested with `bun test`.

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const INTRADAY_SECONDS: Partial<Record<Timeframe, number>> = {
  "1m": MIN,
  "5m": 5 * MIN,
  "15m": 15 * MIN,
  "30m": 30 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
};

export function isIntraday(tf: Timeframe): boolean {
  return INTRADAY_SECONDS[tf] !== undefined;
}

/** Nominal bar length in seconds (1M ≈ 30 days; only used for spacing estimates). */
export function tfSeconds(tf: Timeframe): number {
  const s = INTRADAY_SECONDS[tf];
  if (s !== undefined) return s;
  if (tf === "1D") return DAY;
  if (tf === "1W") return 7 * DAY;
  return 30 * DAY;
}

/** Exchange-local time zone whose calendar date defines a daily session, or undefined for UTC-dated markets. */
export function sessionTimeZone(symbol: string): string | undefined {
  // US daily bars are stamped with the New York session date; extended hours run until 20:00 ET (00:00-01:00 UTC).
  return /\.US$/i.test(symbol) ? "America/New_York" : undefined;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** 00:00 UTC of the calendar date that `timeSec` falls on in `tz` (UTC when omitted). */
export function sessionDayStart(timeSec: UnixSeconds, tz?: string): UnixSeconds {
  if (!tz) return Math.floor(timeSec / DAY) * DAY;
  let f = dayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });
    dayFormatters.set(tz, f);
  }
  let y = 1970, m = 1, d = 1;
  for (const p of f.formatToParts(new Date(timeSec * 1000))) {
    if (p.type === "year") y = Number(p.value);
    else if (p.type === "month") m = Number(p.value);
    else if (p.type === "day") d = Number(p.value);
  }
  return Date.UTC(y, m - 1, d) / 1000;
}

/**
 * Start of the bucket containing `timeSec` (UTC).
 * - Intraday: aligned to a grid of `tfSeconds`. With `anchor` (typically the last loaded bar's time) the grid is
 *   phased to the anchor, so a feed whose 1h bars start at :30 keeps its phase; without it the grid is epoch-aligned.
 * - 1D: 00:00 UTC of the date. 1W: Monday 00:00 UTC (ISO week). 1M: first day of the month 00:00 UTC.
 *   With `tz` (for raw trade times, never for bar times, which already are session dates) the date is the
 *   calendar date in that zone, so e.g. US after-hours trades after 00:00 UTC stay in their session's bar.
 */
export function bucketStart(timeSec: UnixSeconds, tf: Timeframe, anchor?: UnixSeconds, tz?: string): UnixSeconds {
  const step = INTRADAY_SECONDS[tf];
  if (step !== undefined) {
    const base = anchor ?? 0;
    return base + Math.floor((timeSec - base) / step) * step;
  }
  const dayStart = sessionDayStart(timeSec, tz);
  if (tf === "1D") return dayStart;
  if (tf === "1W") {
    const dow = new Date(dayStart * 1000).getUTCDay(); // 0 = Sunday
    return dayStart - ((dow + 6) % 7) * DAY;
  }
  const d = new Date(dayStart * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

export type TickResult =
  | { kind: "ignored" }
  | { kind: "update"; bar: Bar }
  | { kind: "append"; bar: Bar };

export interface PriceOptions {
  /** Session time zone for daily+ bucketing (see `sessionTimeZone`). */
  tz?: string;
  /** Extremes of a server-coalesced tick window (all within the same bucket as `price`). */
  open?: number;
  high?: number;
  low?: number;
}

const pos = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;

/**
 * Fold a trade/price into the last bar of `bars` (ascending). Does not mutate `bars`.
 * - same bucket as the last bar → update high/low/close, add volume
 * - newer bucket → new bar opened at the price (or the coalesced window's open)
 * - older than the last bar, or nothing loaded → ignored (never creates bars outside the loaded range)
 *
 * Daily+ bars may be stamped with the first trading day of their period (e.g. 1W on a Tuesday after a holiday),
 * so buckets are compared rather than raw times.
 */
export function applyPrice(
  bars: readonly Bar[], price: number, volume: number, timeSec: UnixSeconds, tf: Timeframe, opts: PriceOptions = {},
): TickResult {
  const last = bars[bars.length - 1];
  if (!last || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timeSec)) return { kind: "ignored" };
  const vol = Number.isFinite(volume) && volume > 0 ? volume : 0;
  const intraday = isIntraday(tf);
  const lastBucket = intraday ? last.time : bucketStart(last.time, tf);
  const bucket = intraday ? bucketStart(timeSec, tf, last.time) : bucketStart(timeSec, tf, undefined, opts.tz);
  if (bucket < lastBucket) return { kind: "ignored" };
  const hi = Math.max(price, pos(opts.high) ? opts.high : price);
  const lo = Math.min(price, pos(opts.low) ? opts.low : price);
  if (bucket === lastBucket) {
    return {
      kind: "update",
      bar: {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, hi),
        low: Math.min(last.low, lo),
        close: price,
        volume: last.volume + vol,
      },
    };
  }
  const open = pos(opts.open) ? opts.open : price;
  return {
    kind: "append",
    bar: { time: bucket, open, high: Math.max(hi, open), low: Math.min(lo, open), close: price, volume: vol },
  };
}

/** `applyPrice` for a streamed tick (tick.time is in milliseconds). */
export function applyTick(bars: readonly Bar[], tick: Tick, tf: Timeframe, tz?: string): TickResult {
  return applyPrice(bars, tick.price, tick.volume, tick.time / 1000, tf, { tz, open: tick.open, high: tick.high, low: tick.low });
}

/** One Heikin-Ashi step: `prev` is the previous HA bar (undefined for the first bar). */
export function heikinAshiStep(prev: Bar | undefined, bar: Bar): Bar {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (bar.open + bar.close) / 2;
  return {
    time: bar.time,
    open,
    high: Math.max(bar.high, open, close),
    low: Math.min(bar.low, open, close),
    close,
    volume: bar.volume,
  };
}

export function toHeikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = new Array(bars.length);
  let prev: Bar | undefined;
  for (let i = 0; i < bars.length; i++) {
    prev = heikinAshiStep(prev, bars[i]!);
    out[i] = prev;
  }
  return out;
}

/**
 * Merge `older` bars in front of `bars`, dropping any overlap (keeps `bars` authoritative).
 * Both inputs ascending.
 */
export function prependBars(older: readonly Bar[], bars: readonly Bar[]): Bar[] {
  if (bars.length === 0) return [...older];
  const first = bars[0]!.time;
  const head = older.filter((b) => b.time < first);
  return head.concat(bars);
}

/**
 * Merge a fresh REST tail (`fresh`, ascending) into `bars`: the range fresh[0]..fresh[last] is replaced by `fresh`,
 * and local bars newer than fresh's last bar (the in-progress candle built from ticks, which EOD data and cached
 * intraday windows lag behind) are kept. When the local and fresh last bars share a timestamp, that bar is
 * still forming: keep the wider high/low, the larger volume and the local (streamed) close.
 */
export function mergeTail(bars: readonly Bar[], fresh: readonly Bar[]): Bar[] {
  if (fresh.length === 0) return [...bars];
  const start = fresh[0]!.time;
  const end = fresh[fresh.length - 1]!.time;
  const head = bars.filter((b) => b.time < start);
  const tail = bars.filter((b) => b.time > end);
  const merged = fresh.slice();
  const localEnd = bars[bars.length - 1];
  if (tail.length === 0 && localEnd && localEnd.time === end) {
    const f = merged[merged.length - 1]!;
    merged[merged.length - 1] = {
      time: end,
      open: f.open,
      high: Math.max(f.high, localEnd.high),
      low: Math.min(f.low, localEnd.low),
      close: localEnd.close,
      volume: Math.max(f.volume, localEnd.volume),
    };
  }
  return head.concat(merged, tail);
}

/** Index of the bar with exactly `time`, or -1 (bars ascending). */
export function findBarIndex(bars: readonly Bar[], time: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid]!.time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function addMonths(timeSec: UnixSeconds, months: number): UnixSeconds {
  const d = new Date(timeSec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1) / 1000;
}

/**
 * Time at a (possibly fractional or out-of-range) logical index. Inside the data it snaps to the nearest bar;
 * beyond either edge it extrapolates by one timeframe step per index (calendar months for 1M).
 */
export function timeAtLogical(bars: readonly Bar[], logical: number, tf: Timeframe): UnixSeconds | null {
  const n = bars.length;
  if (n === 0 || !Number.isFinite(logical)) return null;
  const i = Math.round(logical);
  if (i >= 0 && i < n) return bars[i]!.time;
  const edge = i < 0 ? bars[0]!.time : bars[n - 1]!.time;
  const k = i < 0 ? i : i - (n - 1);
  if (tf === "1M") return addMonths(bucketStart(edge, "1M"), k);
  return edge + k * tfSeconds(tf);
}
