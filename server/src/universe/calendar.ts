// Market calendars (pure): wall clock in any IANA zone, NYSE holiday rules, sessions, price-job timing.
// A MarketCalendar combines a market's zone, weekend, close + publish delay and extra (learned) holidays.
// The ny*/US-named helpers are the US calendar, kept for existing callers and tests.
import { hhmm, type MarketDef } from "./markets";
import { addDays } from "./util";

// ---------- wall clock ----------
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface WallParts { date: string; hour: number; minute: number; weekday: number }
export type NyParts = WallParts;

/** Wall-clock parts of an instant in `tz`. weekday 0 = Sunday. */
export function tzParts(ms: number, tz: string): WallParts {
  const p: Record<string, string> = {};
  for (const x of fmtFor(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: weekdayOf(date) };
}

/** Local calendar date in `tz`. */
export const tzDate = (ms: number, tz: string): string => tzParts(ms, tz).date;

/** UTC ms of a wall-clock time in `tz` on `date` (handles DST; minutes may exceed 59 / hours 23). */
export function wallToUtc(date: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, tz);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const wall = Date.UTC(py, pm - 1, pd, p.hour, p.minute);
    if (wall === naive) break;
    guess += naive - wall;
  }
  return guess;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export const isWeekend = (date: string): boolean => {
  const d = weekdayOf(date);
  return d === 0 || d === 6;
};

// ---------- NYSE holidays ----------
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return iso(year, month, day);
}
function lastWeekday(year: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return iso(year, month, lastDay - ((lastDow - weekday + 7) % 7));
}
function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Saturday → Friday, Sunday → Monday. */
function observed(date: string): string {
  const d = weekdayOf(date);
  return d === 6 ? addDays(date, -1) : d === 0 ? addDays(date, 1) : date;
}
function easter(year: number): string {
  // Anonymous Gregorian algorithm.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

const holidayCache = new Map<number, Set<string>>();
/** Regular NYSE full-day holidays for a year (special closures are learned from empty bulk days). */
export function nyseHolidays(year: number): Set<string> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const s = new Set<string>();
  const ny = iso(year, 1, 1);
  if (weekdayOf(ny) !== 6) s.add(observed(ny)); // NYSE does not observe a Saturday New Year on Friday
  s.add(nthWeekday(year, 1, 1, 3)); // MLK
  s.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  s.add(addDays(easter(year), -2)); // Good Friday
  s.add(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) s.add(observed(iso(year, 6, 19))); // Juneteenth
  s.add(observed(iso(year, 7, 4)));
  s.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  s.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  s.add(observed(iso(year, 12, 25)));
  holidayCache.set(year, s);
  return s;
}

// ---------- market calendars ----------
export interface MarketCalendar {
  timezone: string;
  weekend: readonly number[];
  nyse: boolean;
  /** Local minutes after midnight of the first price attempt (close + publish delay). */
  attemptMin: number;
  holidays: ReadonlySet<string>;
}

const EMPTY = new Set<string>();

export function calendarFor(
  m: Pick<MarketDef, "timezone" | "weekend" | "close" | "publishDelayMin" | "nyseHolidays">,
  holidays: ReadonlySet<string> = EMPTY,
): MarketCalendar {
  return { timezone: m.timezone, weekend: m.weekend, nyse: !!m.nyseHolidays, attemptMin: hhmm(m.close) + m.publishDelayMin, holidays };
}

/** EODHD publishes US end-of-day data after the close; the first attempt is at this NY time (16:00 + 150 min). */
export const PRICE_ATTEMPT_NY = { hour: 18, minute: 30 };
const US_CAL_BASE = { timezone: "America/New_York", weekend: [0, 6], nyseHolidays: true, close: "16:00", publishDelayMin: 150 };
const usCal = (extra?: ReadonlySet<string>): MarketCalendar => calendarFor(US_CAL_BASE, extra ?? EMPTY);

export function isMarketSession(cal: MarketCalendar, date: string): boolean {
  if (cal.weekend.includes(weekdayOf(date))) return false;
  if (cal.nyse && nyseHolidays(Number(date.slice(0, 4))).has(date)) return false;
  return !cal.holidays.has(date);
}

/** Up to `n` session dates ending at `end` (inclusive), newest first. */
export function marketRecentSessions(cal: MarketCalendar, end: string, n: number): string[] {
  const out: string[] = [];
  let d = end;
  for (let guard = 0; out.length < n && guard < n * 2 + 30; guard++) {
    if (isMarketSession(cal, d)) out.push(d);
    d = addDays(d, -1);
  }
  return out;
}

export function marketPreviousSession(cal: MarketCalendar, date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 30 && !isMarketSession(cal, d); i++) d = addDays(d, -1);
  return d;
}

export function marketNextSession(cal: MarketCalendar, date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 30 && !isMarketSession(cal, d); i++) d = addDays(d, 1);
  return d;
}

/** UTC ms of the first price attempt for session `date`. */
export function marketAttemptAt(cal: MarketCalendar, date: string): number {
  return wallToUtc(date, 0, cal.attemptMin, cal.timezone);
}

/** The newest session whose data should be available by now (its attempt time has passed). */
export function marketExpectedLatest(cal: MarketCalendar, nowMs: number): string {
  const today = tzDate(nowMs, cal.timezone);
  if (isMarketSession(cal, today) && nowMs >= marketAttemptAt(cal, today)) return today;
  return marketPreviousSession(cal, today);
}

/** UTC ms of the first price attempt for the session after `date`. */
export function marketNextAttemptAfter(cal: MarketCalendar, date: string): number {
  return marketAttemptAt(cal, marketNextSession(cal, date));
}

// ---------- US wrappers (v2 API) ----------
export const nyParts = (ms: number): NyParts => tzParts(ms, "America/New_York");
export const nyWallToUtc = (date: string, hour: number, minute: number): number => wallToUtc(date, hour, minute, "America/New_York");
export const isSession = (date: string, extraHolidays?: ReadonlySet<string>): boolean => isMarketSession(usCal(extraHolidays), date);
export const recentSessions = (end: string, n: number, extraHolidays?: ReadonlySet<string>): string[] => marketRecentSessions(usCal(extraHolidays), end, n);
export const previousSession = (date: string, extraHolidays?: ReadonlySet<string>): string => marketPreviousSession(usCal(extraHolidays), date);
export const nextSession = (date: string, extraHolidays?: ReadonlySet<string>): string => marketNextSession(usCal(extraHolidays), date);
export const expectedLatestSession = (nowMs: number, extraHolidays?: ReadonlySet<string>): string => marketExpectedLatest(usCal(extraHolidays), nowMs);
export const nextPriceAttemptAfter = (date: string, extraHolidays?: ReadonlySet<string>): number => marketNextAttemptAfter(usCal(extraHolidays), date);
export const priceAttemptAt = (date: string): number => marketAttemptAt(usCal(), date);

/** Next midnight UTC (EODHD resets daily usage then). */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
