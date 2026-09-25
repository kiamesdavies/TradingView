// America/New_York calendar helpers for date-relative screener filters (earnings date, IPO date, latest news).
// Dates are "YYYY-MM-DD" strings; arithmetic is done on the calendar date (UTC midnight) so DST never shifts a day.

export const MARKET_TZ = "America/New_York";

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s;
}

/** Today's calendar date in New York. */
export function nyToday(now: Date): string {
  return dateFmt.format(now);
}

function toUtc(date: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
}

export function addDays(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addYears(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday */
export function weekday(date: string): number {
  return toUtc(date).getUTCDay();
}

/** Monday of the week containing `date` (weeks run Monday..Sunday). */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

export function monthStart(date: string): string {
  return date.slice(0, 8) + "01";
}

export function monthEnd(date: string): string {
  return addDays(addMonths(monthStart(date), 1), -1);
}

const fmtCache = new Map<string, { date: Intl.DateTimeFormat; parts: Intl.DateTimeFormat }>();
function fmts(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }),
      parts: new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      }),
    };
    fmtCache.set(tz, f);
  }
  return f;
}

/** Today's calendar date in the IANA zone `tz` ("UTC" allowed). */
export function todayIn(now: Date, tz: string): string {
  return tz === MARKET_TZ ? nyToday(now) : fmts(tz).date.format(now);
}

/** Unix seconds of a wall-clock time on `date` in the IANA zone `tz` (DST-safe). */
export function wallToUnix(date: string, hour: number, minute: number, tz: string): number {
  if (tz === MARKET_TZ) return nyWallToUnix(date, hour, minute);
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmts(tz).parts.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!);
    ts += guess - wall;
  }
  return Math.floor(ts / 1000);
}

/** Unix seconds of a New York wall-clock time on `date`. */
export function nyWallToUnix(date: string, hour = 0, minute = 0): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, hour, minute);
  // offset = (NY wall time of `guess`) - guess; iterate twice to settle across DST transitions
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(partsFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    const wall = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
    ts += guess - wall;
  }
  return Math.floor(ts / 1000);
}
