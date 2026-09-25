import type { Symbol, UnixSeconds } from "@eodview/shared";
import { TickMarkType } from "lightweight-charts";

// Pure time-zone helpers for the range bar clock, the time axis and the crosshair label.
// lightweight-charts works in UTC; intraday labels are re-rendered in the chosen zone, daily+ bars are
// session dates at 00:00 UTC and are always formatted in UTC so they never shift across days.

/** Layout.timezone values: "UTC", "exchange", "local", or an IANA zone. */
export type TimeZoneSetting = string;

export const DEFAULT_TIMEZONE: TimeZoneSetting = "UTC";

/** Common zones offered in the clock menu (in addition to UTC / Exchange / Local). */
export const COMMON_ZONES: { tz: string; label: string }[] = [
  { tz: "America/Los_Angeles", label: "Los Angeles" },
  { tz: "America/Chicago", label: "Chicago" },
  { tz: "America/New_York", label: "New York" },
  { tz: "America/Toronto", label: "Toronto" },
  { tz: "America/Sao_Paulo", label: "São Paulo" },
  { tz: "Europe/London", label: "London" },
  { tz: "Europe/Berlin", label: "Berlin" },
  { tz: "Europe/Paris", label: "Paris" },
  { tz: "Europe/Zurich", label: "Zurich" },
  { tz: "Europe/Moscow", label: "Moscow" },
  { tz: "Africa/Lagos", label: "Lagos" },
  { tz: "Africa/Johannesburg", label: "Johannesburg" },
  { tz: "Asia/Dubai", label: "Dubai" },
  { tz: "Asia/Kolkata", label: "Kolkata" },
  { tz: "Asia/Singapore", label: "Singapore" },
  { tz: "Asia/Hong_Kong", label: "Hong Kong" },
  { tz: "Asia/Shanghai", label: "Shanghai" },
  { tz: "Asia/Tokyo", label: "Tokyo" },
  { tz: "Asia/Seoul", label: "Seoul" },
  { tz: "Australia/Sydney", label: "Sydney" },
  { tz: "Pacific/Auckland", label: "Auckland" },
];

const EXCHANGE_ZONES: Record<string, string> = {
  US: "America/New_York",
  NYSE: "America/New_York",
  NASDAQ: "America/New_York",
  LSE: "Europe/London",
  IL: "Europe/London",
  XETRA: "Europe/Berlin",
  F: "Europe/Berlin",
  BE: "Europe/Berlin",
  DU: "Europe/Berlin",
  HM: "Europe/Berlin",
  HA: "Europe/Berlin",
  MU: "Europe/Berlin",
  STU: "Europe/Berlin",
  PA: "Europe/Paris",
  AS: "Europe/Amsterdam",
  BR: "Europe/Brussels",
  MC: "Europe/Madrid",
  MI: "Europe/Rome",
  SW: "Europe/Zurich",
  VI: "Europe/Vienna",
  ST: "Europe/Stockholm",
  OL: "Europe/Oslo",
  CO: "Europe/Copenhagen",
  HE: "Europe/Helsinki",
  LS: "Europe/Lisbon",
  IR: "Europe/Dublin",
  WAR: "Europe/Warsaw",
  AT: "Europe/Athens",
  TO: "America/Toronto",
  V: "America/Toronto",
  NEO: "America/Toronto",
  CN: "America/Toronto",
  SA: "America/Sao_Paulo",
  MX: "America/Mexico_City",
  BA: "America/Argentina/Buenos_Aires",
  SN: "America/Santiago",
  HK: "Asia/Hong_Kong",
  SHG: "Asia/Shanghai",
  SHE: "Asia/Shanghai",
  TSE: "Asia/Tokyo",
  KO: "Asia/Seoul",
  KQ: "Asia/Seoul",
  TW: "Asia/Taipei",
  TWO: "Asia/Taipei",
  NSE: "Asia/Kolkata",
  BSE: "Asia/Kolkata",
  AU: "Australia/Sydney",
  NZ: "Pacific/Auckland",
  JK: "Asia/Jakarta",
  KLSE: "Asia/Kuala_Lumpur",
  BK: "Asia/Bangkok",
  PSE: "Asia/Manila",
  VN: "Asia/Ho_Chi_Minh",
  JSE: "Africa/Johannesburg",
  TA: "Asia/Jerusalem",
  SR: "Asia/Riyadh",
  IS: "Europe/Istanbul",
  XNAI: "Africa/Nairobi",
  XNSA: "Africa/Lagos",
  EGX: "Africa/Cairo",
};

/** Exchange-local zone for `TICKER.EXCHANGE`; FOREX / CC / INDX and unknown exchanges are UTC. */
export function exchangeTimeZone(symbol: Symbol): string {
  const dot = symbol.lastIndexOf(".");
  const ex = dot >= 0 ? symbol.slice(dot + 1).toUpperCase() : "";
  return EXCHANGE_ZONES[ex] ?? "UTC";
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a Layout.timezone setting to an IANA zone. */
export function resolveTimeZone(setting: TimeZoneSetting | undefined, symbol: Symbol, local = localTimeZone()): string {
  const s = setting || DEFAULT_TIMEZONE;
  if (s === "exchange") return exchangeTimeZone(symbol);
  if (s === "local") return local;
  if (s === "UTC" || s === "Etc/UTC") return "UTC";
  return isValidTimeZone(s) ? s : "UTC";
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partFormatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at instant `t`, in seconds (e.g. New York summer → -14400). */
export function tzOffsetSeconds(t: UnixSeconds, tz: string): number {
  if (tz === "UTC") return 0;
  const whole = Math.floor(t);
  const v: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(whole * 1000))) {
    if (p.type !== "literal") v[p.type] = Number(p.value);
  }
  const hour = v.hour === 24 ? 0 : (v.hour ?? 0);
  const wall = Date.UTC(v.year ?? 1970, (v.month ?? 1) - 1, v.day ?? 1, hour, v.minute ?? 0, v.second ?? 0) / 1000;
  return wall - whole;
}

/** A Date whose UTC fields read as the wall-clock time of `t` in `tz`. */
export function zonedDate(t: UnixSeconds, tz: string): Date {
  return new Date((t + tzOffsetSeconds(t, tz)) * 1000);
}

/** The instant of 00:00 wall-clock time in `tz` on the calendar date y-m-d (month 1-based). */
export function zonedMidnight(y: number, m: number, d: number, tz: string): UnixSeconds {
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const off = tzOffsetSeconds(guess, tz);
  let inst = guess - off;
  const off2 = tzOffsetSeconds(inst, tz);
  if (off2 !== off) inst = guess - off2;
  return inst;
}

/** The instant the calendar day containing `t` (in `tz`) started. */
export function zonedDayStart(t: UnixSeconds, tz: string): UnixSeconds {
  const z = zonedDate(t, tz);
  return zonedMidnight(z.getUTCFullYear(), z.getUTCMonth() + 1, z.getUTCDate(), tz);
}

/** "UTC", "UTC-4", "UTC+5:30". */
export function offsetLabel(t: UnixSeconds, tz: string): string {
  const off = tzOffsetSeconds(t, tz);
  if (off === 0) return "UTC";
  const sign = off > 0 ? "+" : "-";
  const abs = Math.abs(off);
  const h = Math.floor(abs / 3600);
  const m = Math.round((abs % 3600) / 60);
  return `UTC${sign}${h}${m ? `:${pad(m)}` : ""}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Range-bar clock text: "12:11:40 UTC", "08:11:40 (UTC-4)". */
export function formatClock(t: UnixSeconds, tz: string): string {
  const z = zonedDate(t, tz);
  const hms = `${pad(z.getUTCHours())}:${pad(z.getUTCMinutes())}:${pad(z.getUTCSeconds())}`;
  const label = offsetLabel(t, tz);
  return tz === "UTC" ? `${hms} UTC` : `${hms} (${label})`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Time-axis tick label. Intraday ticks are rendered in `tz`; daily+ in UTC (bar times are session dates). */
export function formatTickMark(t: UnixSeconds, type: TickMarkType, tz: string, intraday: boolean): string {
  const z = intraday ? zonedDate(t, tz) : new Date(t * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(z.getUTCFullYear());
    case TickMarkType.Month:
      return MONTHS[z.getUTCMonth()]!;
    case TickMarkType.DayOfMonth:
      return String(z.getUTCDate());
    case TickMarkType.Time:
      return `${pad(z.getUTCHours())}:${pad(z.getUTCMinutes())}`;
    case TickMarkType.TimeWithSeconds:
      return `${pad(z.getUTCHours())}:${pad(z.getUTCMinutes())}:${pad(z.getUTCSeconds())}`;
    default:
      return "";
  }
}

/** Crosshair time label: "Thu 25 Sep '26" (daily+), "Thu 25 Sep '26  14:30" (intraday, in `tz`). */
export function formatCrosshairTime(t: UnixSeconds, tz: string, intraday: boolean): string {
  const z = intraday ? zonedDate(t, tz) : new Date(t * 1000);
  const date = `${WEEKDAYS[z.getUTCDay()]} ${z.getUTCDate()} ${MONTHS[z.getUTCMonth()]} '${pad(z.getUTCFullYear() % 100)}`;
  if (!intraday) return date;
  return `${date}  ${pad(z.getUTCHours())}:${pad(z.getUTCMinutes())}`;
}
