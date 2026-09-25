import type { Bar, Symbol } from "@eodview/shared";

/** 1234 → "1.23K", 1_200_000 → "1.2M". */
export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const x = v / size;
      const digits = Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
      return `${trimZeros(x.toFixed(digits))}${suffix}`;
    }
  }
  return trimZeros(v.toFixed(abs >= 100 || Number.isInteger(v) ? 0 : 2));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Decimal places for prices of `symbol` given its loaded bars. */
export function pricePrecision(symbol: Symbol, bars: readonly Bar[]): number {
  let ref = 0;
  for (let i = Math.max(0, bars.length - 50); i < bars.length; i++) ref = Math.max(ref, bars[i]!.close);
  if (symbol.toUpperCase().endsWith(".FOREX")) return ref >= 20 ? 3 : 5;
  if (ref === 0) return 2;
  if (ref < 0.01) return 8;
  if (ref < 1) return 6;
  if (ref < 10) return 4;
  return 2;
}

export function formatPrice(p: number, precision: number): string {
  return Number.isFinite(p) ? p.toFixed(precision) : "—";
}

export function formatChangePct(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
