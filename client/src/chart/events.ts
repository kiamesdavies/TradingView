import type { Bar, ChartEvent, ChartEventType, Symbol, Timeframe, UnixSeconds } from "@eodview/shared";
import { bucketStart, isIntraday, sessionDayStart } from "./candles";

// Pure mapping of chart events (earnings / dividends / splits) onto loaded bars as series markers.

const DAY = 86_400;

export const EVENT_COLORS: Record<ChartEventType, string> = {
  earnings: "#2962ff",
  dividend: "#089981",
  split: "#ff9800",
};

export const EVENT_TITLES: Record<ChartEventType, string> = {
  earnings: "Earnings",
  dividend: "Dividend",
  split: "Split",
};

const EVENT_LETTER: Record<ChartEventType, string> = { earnings: "E", dividend: "D", split: "S" };

/** Chart events exist only for stocks/ETFs: skip forex, crypto, indices and other non-equity pseudo-exchanges. */
export function eventsSupported(symbol: Symbol): boolean {
  return !/\.(FOREX|CC|INDX|COMM|GBOND|MONEY|EUFUND|BOND)$/i.test(symbol);
}

export interface EventMarker {
  id: string;
  time: UnixSeconds;          // bar time the marker sits on
  position: "belowBar";
  shape: "circle";
  color: string;
  text: string;
  size: number;
  event: ChartEvent;
}

export interface BuildMarkersOptions {
  /** Exchange session zone used to find the session date of intraday bars (see candles.sessionTimeZone). */
  tz?: string;
  /** Current time (for "E in Nd"). */
  now: UnixSeconds;
}

/** Index of the last bar with time <= t, or -1. */
function lastAtOrBefore(bars: readonly Bar[], t: UnixSeconds): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Bar time a daily+ event (session date 00:00 UTC) belongs to, or null when outside the loaded bars. */
function dailyBarFor(bars: readonly Bar[], t: UnixSeconds, tf: Timeframe): UnixSeconds | null {
  const i = lastAtOrBefore(bars, t);
  const bucket = bucketStart(t, tf);
  if (i >= 0 && bucketStart(bars[i]!.time, tf) === bucket) return bars[i]!.time;
  const next = bars[i + 1];
  if (!next || i < 0) return null; // before the first loaded bar, or after the last one
  // Event on a non-trading day (weekend/holiday): attach to the next session.
  if (bucketStart(next.time, tf) === bucket) return next.time;
  if (tf === "1D" && next.time - t < 7 * DAY) return next.time;
  return null;
}

/** Days from today (UTC date of `now`) until event date `t`. */
export function daysUntil(t: UnixSeconds, now: UnixSeconds): number {
  const today = Math.floor(now / DAY) * DAY;
  return Math.round((Math.floor(t / DAY) * DAY - today) / DAY);
}

/**
 * Markers for `events` on `bars` (ascending), sorted by time.
 * - Daily+: each event goes on the bar whose period contains its date (next session for non-trading days).
 * - Intraday: on the first bar of the event's session date; events outside the loaded sessions are dropped.
 * - The nearest upcoming earnings (date after the last bar) is placed on the last bar as "E in Nd".
 *   Other future events are dropped (lightweight-charts markers need an existing bar).
 */
export function buildEventMarkers(
  events: readonly ChartEvent[], bars: readonly Bar[], tf: Timeframe, opts: BuildMarkersOptions,
): EventMarker[] {
  const n = bars.length;
  if (n === 0 || events.length === 0) return [];
  const intraday = isIntraday(tf);
  const last = bars[n - 1]!;
  const lastSession = intraday ? sessionDayStart(last.time, opts.tz) : bucketStart(last.time, tf);

  let firstBarOfDay: Map<number, UnixSeconds> | null = null;
  if (intraday) {
    firstBarOfDay = new Map();
    for (const b of bars) {
      const d = sessionDayStart(b.time, opts.tz);
      if (!firstBarOfDay.has(d)) firstBarOfDay.set(d, b.time);
    }
  }

  const out: EventMarker[] = [];
  let upcoming: ChartEvent | null = null;
  events.forEach((ev, idx) => {
    if (!Number.isFinite(ev.time)) return;
    const future = intraday ? ev.time > lastSession : ev.time > last.time && bucketStart(ev.time, tf) > lastSession;
    if (ev.upcoming || future) {
      if (ev.type === "earnings" && ev.time >= Math.floor(opts.now / DAY) * DAY - DAY && (!upcoming || ev.time < upcoming.time)) {
        upcoming = ev;
      }
      if (future) return;
    }
    const time = intraday ? (firstBarOfDay!.get(ev.time) ?? null) : dailyBarFor(bars, ev.time, tf);
    if (time === null) return;
    out.push({
      id: `ev-${ev.type}-${ev.time}-${idx}`,
      time,
      position: "belowBar",
      shape: "circle",
      color: EVENT_COLORS[ev.type],
      text: EVENT_LETTER[ev.type],
      size: 1,
      event: ev,
    });
  });

  const up = upcoming as ChartEvent | null;
  if (up && !out.some((m) => m.event === up)) {
    const d = daysUntil(up.time, opts.now);
    out.push({
      id: `ev-upcoming-${up.time}`,
      time: last.time,
      position: "belowBar",
      shape: "circle",
      color: EVENT_COLORS.earnings,
      text: d <= 0 ? "E today" : `E in ${d}d`,
      size: 1,
      event: up,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** "Earnings · Aug 5, 2026" style tooltip header. */
export function eventTitle(ev: ChartEvent): string {
  const d = new Date(ev.time * 1000);
  const date = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return `${EVENT_TITLES[ev.type]}${ev.upcoming ? " (upcoming)" : ""} · ${date}`;
}
