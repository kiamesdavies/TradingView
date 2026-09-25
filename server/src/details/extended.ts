// Pre-/post-market quote from EODHD /us-quote-delayed. Pure (clock passed in).
import type { ExtendedQuote } from "@eodview/shared";
import { REGULAR_CLOSE_MIN, REGULAR_OPEN_MIN, isWeekday, lastSessionDay, nyClock } from "./time";

export interface ExtendedInput {
  /** Extended-hours last trade (us-quote-delayed ethPrice / ethTime in ms). */
  ethPrice: number | null | undefined;
  ethTimeMs: number | null | undefined;
  /** Regular-session last price the change is measured against. */
  regularPrice: number | null | undefined;
  /** Unix seconds of the regular session's last trade, when known; ethTime must be newer. */
  regularTime?: number | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * "pre" when the extended trade happened before 09:30 New York time on today's (weekday) date and the
 * regular session has not opened yet; "post" when it happened at/after 16:00 on the most recent session
 * day and the next session has not opened yet (so it stays visible overnight and over the weekend).
 * Trades during regular hours, on weekends, or older than the current session context yield null.
 * Exchange holidays are not modelled.
 */
export function classifyExtended(input: ExtendedInput, nowMs: number): ExtendedQuote | null {
  const { ethPrice, ethTimeMs, regularPrice } = input;
  if (!finite(ethPrice) || !finite(ethTimeMs) || ethTimeMs <= 0 || !finite(regularPrice) || regularPrice <= 0) return null;
  if (finite(input.regularTime) && ethTimeMs / 1000 <= input.regularTime) return null;
  if (ethTimeMs > nowMs + 5 * 60_000) return null; // clock skew guard

  const eth = nyClock(ethTimeMs);
  const now = nyClock(nowMs);
  if (!isWeekday(eth.weekday)) return null;

  let session: ExtendedQuote["session"];
  if (eth.minutes < REGULAR_OPEN_MIN) {
    // pre-market in progress today
    if (eth.day !== now.day || !isWeekday(now.weekday) || now.minutes >= REGULAR_OPEN_MIN) return null;
    session = "pre";
  } else if (eth.minutes >= REGULAR_CLOSE_MIN) {
    // after-hours of the latest session, until the next session opens
    const sameSession = lastSessionDay(now) === eth.day;
    const afterClose = now.day > eth.day || now.minutes >= REGULAR_CLOSE_MIN;
    if (!sameSession || !afterClose) return null;
    session = "post";
  } else {
    return null;
  }

  const change = ethPrice - regularPrice;
  return {
    session,
    price: ethPrice,
    change: round(change, 6),
    changePct: round((change / regularPrice) * 100, 4),
    time: Math.floor(ethTimeMs / 1000),
  };
}

/** Regular-session trade time to compare against: only a quote time that falls inside regular hours counts. */
export function regularTradeTime(quoteTimeSec: number | null | undefined): number | null {
  if (!finite(quoteTimeSec) || quoteTimeSec <= 0) return null;
  const c = nyClock(quoteTimeSec * 1000);
  return isWeekday(c.weekday) && c.minutes >= REGULAR_OPEN_MIN && c.minutes < REGULAR_CLOSE_MIN ? quoteTimeSec : null;
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
