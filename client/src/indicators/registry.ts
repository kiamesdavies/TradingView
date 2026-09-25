import type { IndicatorConfig, IndicatorType } from "@eodview/shared";
import { PRICE_SOURCES, isPriceSource, type PriceSource } from "@eodview/shared/src/indicators/index";

export type ParamValue = number | string;

export type ParamSpec =
  | { key: string; label: string; kind: "int"; min: number; max: number }
  | { key: string; label: string; kind: "float"; min: number; max: number; step: number }
  | { key: string; label: string; kind: "source" };

export interface IndicatorDef {
  type: IndicatorType;
  /** Display name in the dialog. */
  name: string;
  /** Short label used for series titles, e.g. "SMA". */
  short: string;
  /** true: drawn on the price pane (pane 0); false: gets its own pane. */
  overlay: boolean;
  defaults: Record<string, ParamValue>;
  params: ParamSpec[];
  /** Default colors by role. `main` is the role overridden by IndicatorConfig.color. */
  colors: { main: string } & Record<string, string>;
}

const SOURCE: ParamSpec = { key: "source", label: "Source", kind: "source" };
const period = (max = 500): ParamSpec => ({ key: "period", label: "Length", kind: "int", min: 1, max });

export const INDICATOR_DEFS: Record<IndicatorType, IndicatorDef> = {
  sma: {
    type: "sma", name: "Moving Average (SMA)", short: "SMA", overlay: true,
    defaults: { period: 20, source: "close" }, params: [period(), SOURCE],
    colors: { main: "#2962ff" },
  },
  ema: {
    type: "ema", name: "Exponential Moving Average (EMA)", short: "EMA", overlay: true,
    defaults: { period: 50, source: "close" }, params: [period(), SOURCE],
    colors: { main: "#ff9800" },
  },
  vwap: {
    type: "vwap", name: "VWAP", short: "VWAP", overlay: true,
    defaults: { source: "hlc3" }, params: [SOURCE],
    colors: { main: "#e040fb" },
  },
  bb: {
    type: "bb", name: "Bollinger Bands", short: "BB", overlay: true,
    defaults: { period: 20, stdDev: 2, source: "close" },
    params: [period(), { key: "stdDev", label: "StdDev", kind: "float", min: 0.1, max: 10, step: 0.1 }, SOURCE],
    colors: { main: "#2196f3", middle: "#ff6d00" },
  },
  rsi: {
    type: "rsi", name: "Relative Strength Index (RSI)", short: "RSI", overlay: false,
    defaults: { period: 14, source: "close", upper: 70, lower: 30 },
    params: [
      period(),
      SOURCE,
      { key: "upper", label: "Upper band", kind: "int", min: 1, max: 99 },
      { key: "lower", label: "Lower band", kind: "int", min: 1, max: 99 },
    ],
    colors: { main: "#7e57c2", band: "#787b86" },
  },
  macd: {
    type: "macd", name: "MACD", short: "MACD", overlay: false,
    defaults: { fast: 12, slow: 26, signal: 9, source: "close" },
    params: [
      { key: "fast", label: "Fast length", kind: "int", min: 1, max: 500 },
      { key: "slow", label: "Slow length", kind: "int", min: 1, max: 500 },
      { key: "signal", label: "Signal length", kind: "int", min: 1, max: 500 },
      SOURCE,
    ],
    colors: {
      main: "#2962ff", signal: "#ff6d00",
      histUpStrong: "#26a69a", histUpWeak: "#b2dfdb", histDownStrong: "#ef5350", histDownWeak: "#ffcdd2",
    },
  },
  atr: {
    type: "atr", name: "Average True Range (ATR)", short: "ATR", overlay: false,
    defaults: { period: 14 }, params: [period()],
    colors: { main: "#f23645" },
  },
  volma: {
    type: "volma", name: "Volume + MA", short: "Vol MA", overlay: false,
    defaults: { period: 20 }, params: [period()],
    colors: { main: "#2962ff", volUp: "rgba(38,166,154,0.5)", volDown: "rgba(239,83,80,0.5)" },
  },
};

export const INDICATOR_TYPES = Object.keys(INDICATOR_DEFS) as IndicatorType[];
export { PRICE_SOURCES };

/** Integer/float param from config with default fallback and clamping to the spec's range. */
export function numParam(cfg: IndicatorConfig, key: string): number {
  const def = INDICATOR_DEFS[cfg.type];
  const spec = def.params.find((p) => p.key === key);
  const fallback = Number(def.defaults[key] ?? 0);
  const raw = cfg.params[key];
  let v = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(v)) v = fallback;
  if (spec && spec.kind !== "source") {
    v = Math.min(spec.max, Math.max(spec.min, v));
    if (spec.kind === "int") v = Math.round(v);
  }
  return v;
}

export function sourceParam(cfg: IndicatorConfig): PriceSource {
  const raw = cfg.params.source;
  if (isPriceSource(raw)) return raw;
  const d = INDICATOR_DEFS[cfg.type].defaults.source;
  return isPriceSource(d) ? d : "close";
}

export function mainColor(cfg: IndicatorConfig): string {
  return cfg.color ?? INDICATOR_DEFS[cfg.type].colors.main;
}

/** Legend/series title such as "SMA 20" or "MACD 12 26 9". */
export function indicatorLabel(cfg: IndicatorConfig): string {
  const def = INDICATOR_DEFS[cfg.type];
  const parts: string[] = [];
  for (const p of def.params) {
    if (p.kind === "source") {
      const s = sourceParam(cfg);
      if (s !== def.defaults.source) parts.push(s);
    } else if (!(cfg.type === "rsi" && (p.key === "upper" || p.key === "lower"))) {
      parts.push(String(numParam(cfg, p.key)));
    }
  }
  return [def.short, ...parts].join(" ");
}

let idCounter = 0;
export function newIndicatorId(type: IndicatorType): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${type}-${Date.now().toString(36)}-${rand}${idCounter}`;
}

export function createIndicator(type: IndicatorType): IndicatorConfig {
  const def = INDICATOR_DEFS[type];
  return { id: newIndicatorId(type), type, params: { ...def.defaults }, color: def.colors.main, visible: true };
}
