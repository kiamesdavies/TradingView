// Chart event markers (earnings, dividends, splits) from EODHD data. Pure.
import type { ChartEvent } from "@eodview/shared";
import { dateToDay } from "./time";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Numbers and numeric strings → number; everything else → null. */
export function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && v !== "NA") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const dayToUnix = (day: number): number => day * 86400;

function fmtNum(x: number, digits = 2): string {
  return x.toFixed(digits);
}

function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

export interface EarningsRow {
  period: string;
  reportDate?: string;
  timing?: "BeforeMarket" | "AfterMarket";
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
}

/** Earnings.History (object keyed by period, or array) → rows ascending by period. */
export function earningsRows(history: unknown): EarningsRow[] {
  const list = Array.isArray(history) ? history : isObj(history) ? Object.values(history) : [];
  const out: EarningsRow[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const period = typeof r.date === "string" ? r.date : "";
    if (!Number.isFinite(dateToDay(period))) continue;
    const epsActual = numOrNull(r.epsActual);
    const epsEstimate = numOrNull(r.epsEstimate);
    let surprisePct = epsActual === null ? null : numOrNull(r.surprisePercent);
    if (surprisePct === null && epsActual !== null && epsEstimate !== null && epsEstimate !== 0) {
      surprisePct = ((epsActual - epsEstimate) / Math.abs(epsEstimate)) * 100;
    }
    const row: EarningsRow = { period, epsActual, epsEstimate, surprisePct };
    if (typeof r.reportDate === "string" && Number.isFinite(dateToDay(r.reportDate))) row.reportDate = r.reportDate;
    if (r.beforeAfterMarket === "BeforeMarket" || r.beforeAfterMarket === "AfterMarket") row.timing = r.beforeAfterMarket;
    out.push(row);
  }
  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

/** Upcoming = not reported yet and the report date is today or later. */
export function isUpcoming(row: EarningsRow, todayDay: number): boolean {
  return row.epsActual === null && row.reportDate !== undefined && dateToDay(row.reportDate) >= todayDay;
}

export function earningsDetail(row: EarningsRow, upcoming: boolean): string {
  const when = row.timing === "BeforeMarket" ? " (before open)" : row.timing === "AfterMarket" ? " (after close)" : "";
  if (upcoming || row.epsActual === null) {
    return `Earnings ${row.reportDate ?? row.period}${when}` + (row.epsEstimate !== null ? ` · EPS est ${fmtNum(row.epsEstimate)}` : "");
  }
  let s = `EPS ${fmtNum(row.epsActual)}`;
  if (row.epsEstimate !== null) s += ` vs ${fmtNum(row.epsEstimate)} est`;
  if (row.surprisePct !== null) s += ` (${fmtPct(row.surprisePct)})`;
  return s;
}

export function earningsEvents(history: unknown, todayDay: number): ChartEvent[] {
  const out: ChartEvent[] = [];
  for (const row of earningsRows(history)) {
    if (!row.reportDate) continue;
    const upcoming = isUpcoming(row, todayDay);
    if (row.epsActual === null && !upcoming) continue; // past report never filled in
    out.push({ type: "earnings", time: dayToUnix(dateToDay(row.reportDate)), label: "E", detail: earningsDetail(row, upcoming), upcoming });
  }
  return out;
}

const CURRENCY_SIGN: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "C$", AUD: "A$" };

function money(value: number, currency: string | undefined): string {
  // 2–4 decimals: 0.26 → "0.26", 0.1925 → "0.1925", 12 → "12.00"
  const amount = value.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1").replace(/(\.\d\d)0$/, "$1");
  const sign = currency ? CURRENCY_SIGN[currency.toUpperCase()] : "$";
  return sign ? `${sign}${amount}` : `${amount} ${currency}`;
}

/** /div/SYMBOL rows → dividend markers on the ex-date. */
export function dividendEvents(raw: unknown, todayDay: number): ChartEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartEvent[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.date !== "string") continue;
    const day = dateToDay(r.date);
    const value = numOrNull(r.value) ?? numOrNull(r.unadjustedValue);
    if (!Number.isFinite(day) || value === null) continue;
    const currency = typeof r.currency === "string" && r.currency ? r.currency : undefined;
    let detail = `Dividend ${money(value, currency)} ex-date`;
    const unadj = numOrNull(r.unadjustedValue);
    if (unadj !== null && Math.abs(unadj - value) > 1e-6) detail += ` (${money(unadj, currency)} as paid)`;
    if (typeof r.paymentDate === "string" && r.paymentDate) detail += ` · paid ${r.paymentDate}`;
    out.push({ type: "dividend", time: dayToUnix(day), label: "D", detail, upcoming: day > todayDay });
  }
  return out;
}

/** "4.000000/1.000000" → "4:1"; "1.000000/10.000000" → "1:10". */
export function splitRatio(s: string): string | null {
  const m = /^\s*([\d.]+)\s*[/:]\s*([\d.]+)\s*$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!(a > 0) || !(b > 0)) return null;
  const f = (x: number) => String(Number(x.toFixed(4)));
  return `${f(a)}:${f(b)}`;
}

export function splitEvents(raw: unknown, todayDay: number): ChartEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartEvent[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.date !== "string" || typeof r.split !== "string") continue;
    const day = dateToDay(r.date);
    const ratio = splitRatio(r.split);
    if (!Number.isFinite(day) || !ratio) continue;
    const [a, b] = ratio.split(":").map(Number);
    out.push({
      type: "split",
      time: dayToUnix(day),
      label: "S",
      detail: `${a < b ? "Reverse split" : "Split"} ${ratio}`,
      upcoming: day > todayDay,
    });
  }
  return out;
}

/**
 * Merge, sort ascending, and keep events in [from, to]. Upcoming earnings are kept even when after `to`
 * so the chart can show the next report at its right edge.
 */
export function selectEvents(events: ChartEvent[], from: number, to: number): ChartEvent[] {
  const order: Record<ChartEvent["type"], number> = { split: 0, dividend: 1, earnings: 2 };
  return events
    .filter((e) => e.time >= from && (e.time <= to || (e.upcoming && e.type === "earnings")))
    .sort((a, b) => a.time - b.time || order[a.type] - order[b.type]);
}
