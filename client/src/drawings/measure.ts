// Measure tool (TradingView's ruler): price change, % change, bar count and elapsed time between two points.
import type { DrawingPoint, UnixSeconds } from "@eodview/shared";
import { timeToLogical } from "./geometry";

export interface Measurement {
  priceChange: number;
  pctChange: number | null;   // null when the start price is 0
  bars: number;               // signed: negative when measured right-to-left
  seconds: number;            // signed elapsed time
  up: boolean;
}

export function measure(a: DrawingPoint, b: DrawingPoint, times: readonly UnixSeconds[]): Measurement {
  const priceChange = b.price - a.price;
  const pctChange = a.price !== 0 ? (priceChange / Math.abs(a.price)) * 100 : null;
  const la = timeToLogical(a.time, times);
  const lb = timeToLogical(b.time, times);
  const bars = la !== null && lb !== null ? Math.round(lb - la) : 0;
  return { priceChange, pctChange, bars, seconds: b.time - a.time, up: priceChange >= 0 };
}

/** "3d 4h", "2h 15m", "45m", "1y 2mo", "12d" — the two largest units, like TradingView. */
export function formatDuration(seconds: number): string {
  let s = Math.abs(Math.round(seconds));
  const sign = seconds < 0 ? "-" : "";
  if (s < 60) return `${sign}${s}s`;
  const units: [string, number][] = [["y", 365 * 86400], ["mo", 30 * 86400], ["d", 86400], ["h", 3600], ["m", 60]];
  const parts: string[] = [];
  for (const [label, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      s -= n * size;
      parts.push(`${n}${label}`);
      if (parts.length === 2) break;
    } else if (parts.length) {
      break; // keep adjacent units only ("1y 2mo", not "1y 3h")
    }
  }
  return sign + parts.join(" ");
}

function signed(n: number, text: string): string {
  return n > 0 ? `+${text}` : n < 0 ? `−${text.replace(/^-/, "")}` : text;
}

/** Two label lines: "+12.34 (+5.67%)" and "23 bars, 33d". */
export function measureLabel(m: Measurement, formatPrice: (p: number) => string): [string, string] {
  const price = signed(m.priceChange, formatPrice(Math.abs(m.priceChange)));
  const pct = m.pctChange === null ? "" : ` (${signed(m.pctChange, `${Math.abs(m.pctChange).toFixed(2)}%`)})`;
  const bars = Math.abs(m.bars);
  return [`${price}${pct}`, `${bars} bar${bars === 1 ? "" : "s"}, ${formatDuration(m.seconds)}`];
}
