// US market calendar helpers (pure): New York wall clock, NYSE holidays, recent sessions, price-job timing.
import { addDays } from "./util";

const NY_TZ = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export interface NyParts { date: string; hour: number; minute: number; weekday: number }

/** New York wall-clock parts for an instant. weekday 0 = Sunday. */
export function nyParts(ms: number): NyParts {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour), minute: Number(p.minute), weekday: weekdayOf(date) };
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export const isWeekend = (date: string): boolean => {
  const d = weekdayOf(date);
  return d === 0 || d === 6;
};

/** UTC ms of a New York wall-clock time on `date` (handles DST). */
export function nyWallToUtc(date: string, hour: number, minute: number): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  // Offset of NY at (approximately) that instant; refine once for DST edges.
  let guess = naive + 5 * 3600_000;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(guess);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const wall = Date.UTC(py, pm - 1, pd, p.hour, p.minute);
    guess += naive - wall;
  }
  return guess;
}

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

export function isSession(date: string, extraHolidays?: ReadonlySet<string>): boolean {
  if (isWeekend(date)) return false;
  if (nyseHolidays(Number(date.slice(0, 4))).has(date)) return false;
  return !extraHolidays?.has(date);
}

/** Up to `n` session dates ending at `end` (inclusive), newest first. */
export function recentSessions(end: string, n: number, extraHolidays?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let d = end;
  for (let guard = 0; out.length < n && guard < n * 2 + 30; guard++) {
    if (isSession(d, extraHolidays)) out.push(d);
    d = addDays(d, -1);
  }
  return out;
}

export function previousSession(date: string, extraHolidays?: ReadonlySet<string>): string {
  let d = addDays(date, -1);
  while (!isSession(d, extraHolidays)) d = addDays(d, -1);
  return d;
}

export function nextSession(date: string, extraHolidays?: ReadonlySet<string>): string {
  let d = addDays(date, 1);
  while (!isSession(d, extraHolidays)) d = addDays(d, 1);
  return d;
}

/** EODHD publishes US end-of-day data after the close; the first attempt is at this NY time. */
export const PRICE_ATTEMPT_NY = { hour: 18, minute: 30 };

/** The newest session whose data should be available by now (its 18:30 NY has passed). */
export function expectedLatestSession(nowMs: number, extraHolidays?: ReadonlySet<string>): string {
  const p = nyParts(nowMs);
  const afterAttempt = p.hour > PRICE_ATTEMPT_NY.hour || (p.hour === PRICE_ATTEMPT_NY.hour && p.minute >= PRICE_ATTEMPT_NY.minute);
  if (isSession(p.date, extraHolidays) && afterAttempt) return p.date;
  return previousSession(p.date, extraHolidays);
}

/** UTC ms of the first price attempt for the session after `date`. */
export function nextPriceAttemptAfter(date: string, extraHolidays?: ReadonlySet<string>): number {
  return nyWallToUtc(nextSession(date, extraHolidays), PRICE_ATTEMPT_NY.hour, PRICE_ATTEMPT_NY.minute);
}

export function priceAttemptAt(date: string): number {
  return nyWallToUtc(date, PRICE_ATTEMPT_NY.hour, PRICE_ATTEMPT_NY.minute);
}

/** Next midnight UTC (EODHD resets daily usage then). */
export function nextUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
