// Pure formatting helpers for the symbol details panel. Covered by format.test.ts.
import type { KeyStat, NewsItem, StatFormat, Symbol, SymbolOverview } from "@eodview/shared";

export const DASH = "—";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Compact number with a suffix: 2.04B, 164.5K, −1.20M, 812.33. Always 2 decimals below 1000, 2/1/0 above by magnitude. */
export function formatCompact(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  const sign = v < 0 ? "−" : "";
  const abs = Math.abs(v);
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [n, u] of units) {
    if (abs >= n) {
      const x = abs / n;
      return `${sign}${x >= 100 ? x.toFixed(1) : x.toFixed(2)}${u}`;
    }
  }
  return `${sign}${abs.toFixed(2)}`;
}

/** Share volume: 7.73M, 812K, 950. Zero/negative -> dash. */
export function formatVolumeStat(v: number | null | undefined): string {
  if (!isNum(v) || v <= 0) return DASH;
  if (v < 1000) return String(Math.round(v));
  return formatCompact(v);
}

/** "In 47 days", "Tomorrow", "Today", "Yesterday", "3 days ago". */
export function formatDaysUntil(days: number | null | undefined): string {
  if (!isNum(days)) return DASH;
  const d = Math.round(days);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  return d > 0 ? `In ${d} days` : `${-d} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parse "YYYY-MM-DD" (or a longer ISO string) to {y, m (1-12), d}; null when unparsable. */
export function parseIsoDate(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** "2026-10-29" or unix seconds -> "Oct 29, 2026". Unparsable strings are returned as-is. */
export function formatDate(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return DASH;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return DASH;
    const dt = new Date(v * 1000);
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
  }
  const p = parseIsoDate(v);
  return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : v;
}

/** Percent value already in percent units (0.45 -> "0.45%"). */
export function formatPctValue(v: number | null | undefined, signed = false): string {
  if (!isNum(v)) return DASH;
  const s = Math.abs(v).toFixed(2);
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  return `${sign}${s}%`;
}

export function formatNumber(v: number, maxDecimals = 2): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: maxDecimals }).replace(/^-/, "−");
}

/** Format a key stat value per its StatFormat. Null/empty -> dash. */
export function formatStat(value: KeyStat["value"], format: StatFormat): string {
  if (value === null || value === undefined || value === "") return DASH;
  if (typeof value === "string") {
    if (format === "date") return formatDate(value);
    const n = Number(value);
    // Numeric strings get the numeric treatment; anything else is text.
    if (format === "text" || value.trim() === "" || !Number.isFinite(n)) return value;
    return formatStat(n, format);
  }
  if (!Number.isFinite(value)) return DASH;
  switch (format) {
    case "volume": return formatVolumeStat(value);
    case "money": return formatCompact(value);
    case "pct": return formatPctValue(value);
    case "ratio": return value.toFixed(2).replace(/^-/, "−");
    case "days": return formatDaysUntil(value);
    case "date": return formatDate(value);
    case "number": return Math.abs(value) >= 1e6 ? formatCompact(value) : formatNumber(value);
    case "text": return String(value);
  }
}

/** Fiscal period end "2025-09-30" -> "Q3 '25" (calendar quarter of the period end). */
export function quarterLabel(period: string): string {
  const p = parseIsoDate(period);
  if (!p) return period;
  return `Q${Math.ceil(p.m / 3)} '${String(p.y % 100).padStart(2, "0")}`;
}

/** Resolve the layout timezone to an IANA zone (undefined = browser local). "exchange" -> the symbol's session zone. */
export function resolveTimeZone(layoutTz: string | undefined, symbol: Symbol): string | undefined {
  // Unset means UTC, the chart's default (chart/timezone.ts DEFAULT_TIMEZONE), so the panel matches the chart clock.
  if (!layoutTz) return "UTC";
  if (layoutTz === "exchange") {
    const ex = symbol.slice(symbol.lastIndexOf(".") + 1).toUpperCase();
    return EXCHANGE_TZ[ex];
  }
  if (layoutTz === "local") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: layoutTz });
    return layoutTz;
  } catch {
    return undefined;
  }
}

const EXCHANGE_TZ: Record<string, string> = {
  US: "America/New_York", TO: "America/Toronto", V: "America/Toronto", LSE: "Europe/London", XETRA: "Europe/Berlin",
  F: "Europe/Berlin", PA: "Europe/Paris", AS: "Europe/Amsterdam", MI: "Europe/Rome", MC: "Europe/Madrid",
  SW: "Europe/Zurich", HK: "Asia/Hong_Kong", TSE: "Asia/Tokyo", KO: "Asia/Seoul", AU: "Australia/Sydney",
  NSE: "Asia/Kolkata", BSE: "Asia/Kolkata", SHG: "Asia/Shanghai", SHE: "Asia/Shanghai", SA: "America/Sao_Paulo",
  INDX: "America/New_York", FOREX: "UTC", CC: "UTC",
};

/** "16:00 EDT" / "20:00 UTC" / "09:30 GMT+2" in the given zone (local when undefined). */
export function formatClock(unixSec: number, tz?: string): string {
  if (!isNum(unixSec) || unixSec <= 0) return DASH;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}

/** "Sep 17" (month-day in the given zone); prefixed with the year when not in `now`'s year. */
export function formatShortDate(unixSec: number, tz?: string, nowMs: number = Date.now()): string {
  if (!isNum(unixSec)) return DASH;
  const f = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" }).formatToParts(new Date(ms));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { y: g("year"), md: `${g("month")} ${g("day")}` };
  };
  const a = f(unixSec * 1000);
  return a.y === f(nowMs).y ? a.md : `${a.md}, ${a.y}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", else short date. */
export function formatRelative(unixSec: number, nowMs: number = Date.now(), tz?: string): string {
  if (!isNum(unixSec)) return DASH;
  const s = Math.round(nowMs / 1000 - unixSec);
  if (s < 60) return "just now";
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return plural(Math.floor(s / 60), "minute");
  if (s < 86400) return plural(Math.floor(s / 3600), "hour");
  if (s < 7 * 86400) return plural(Math.floor(s / 86400), "day");
  return formatShortDate(unixSec, tz, nowMs);
}

export type Sentiment = "positive" | "negative" | "neutral";
export function sentimentOf(v: number | null | undefined): Sentiment {
  if (!isNum(v)) return "neutral";
  if (v > 0.1) return "positive";
  if (v < -0.1) return "negative";
  return "neutral";
}

/** True for asset classes that have no company fundamentals (forex, crypto, indices). */
export function lacksFundamentals(symbol: Symbol, profileType?: string): boolean {
  if (/\.(FOREX|CC|INDX)$/i.test(symbol)) return true;
  const t = (profileType ?? "").toLowerCase();
  return t === "currency" || t === "index" || t.includes("crypto");
}

type Analyst = NonNullable<SymbolOverview["analyst"]>;
export type Consensus = "Strong buy" | "Buy" | "Neutral" | "Sell" | "Strong sell";

/** Consensus from the EODHD 1..5 rating, falling back to the count-weighted average. Null when neither exists. */
export function consensusOf(a: Analyst): { label: Consensus; score: number } | null {
  let score = isNum(a.rating) && a.rating > 0 ? a.rating : null;
  if (score === null) {
    const n = analystTotal(a);
    if (n === 0) return null;
    score = (a.strongBuy * 5 + a.buy * 4 + a.hold * 3 + a.sell * 2 + a.strongSell * 1) / n;
  }
  const label: Consensus =
    score >= 4.5 ? "Strong buy" : score >= 3.5 ? "Buy" : score >= 2.5 ? "Neutral" : score >= 1.5 ? "Sell" : "Strong sell";
  return { label, score };
}

export function analystTotal(a: Analyst): number {
  const c = (x: number) => (isNum(x) && x > 0 ? x : 0);
  return c(a.strongBuy) + c(a.buy) + c(a.hold) + c(a.sell) + c(a.strongSell);
}

/** Percent upside of `target` over `price`; null when either is missing. */
export function upsidePct(target: number | null | undefined, price: number | null | undefined): number | null {
  if (!isNum(target) || !isNum(price) || price <= 0) return null;
  return (target / price - 1) * 100;
}

/** Stable pleasant color for a letter avatar. */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

/** "https://www.apple.com/" -> "apple.com". */
export function displayHost(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Absolute http(s) URL or null (never a javascript: link). */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withProto);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Latest item by publish time (NewsItem list may come unsorted). */
export function sortNews(items: readonly NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.publishedAt - a.publishedAt);
}
