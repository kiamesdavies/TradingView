// New York wall-clock helpers (DST-aware via Intl). Pure.

export const NY_TZ = "America/New_York";
export const REGULAR_OPEN_MIN = 9 * 60 + 30; // 09:30
export const REGULAR_CLOSE_MIN = 16 * 60;    // 16:00

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export interface NyClock {
  /** Days since 1970-01-01 of the New York calendar date. */
  day: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes since New York midnight. */
  minutes: number;
  date: string; // "2026-09-24"
}

export function nyClock(ms: number): NyClock {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  const day = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return {
    day,
    weekday: (day + 4) % 7, // 1970-01-01 was a Thursday
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export const isWeekday = (weekday: number): boolean => weekday >= 1 && weekday <= 5;

/** NY calendar day of the most recent weekday session whose 09:30 open is at or before `c` (holidays ignored). */
export function lastSessionDay(c: NyClock): number {
  let day = isWeekday(c.weekday) && c.minutes >= REGULAR_OPEN_MIN ? c.day : c.day - 1;
  while (!isWeekday((day + 4) % 7)) day--;
  return day;
}

/** "2026-10-29" → days since epoch (UTC), NaN when malformed. */
export function dateToDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}
