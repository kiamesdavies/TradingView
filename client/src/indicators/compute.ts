import type { Bar, IndicatorConfig, Timeframe } from "@eodview/shared";
import {
  atr, bollinger, ema, macd, rsi, sma, volumeMa, vwap, type IndicatorPoint,
} from "@eodview/shared/src/indicators/index";
import { INDICATOR_DEFS, numParam, sourceParam } from "./registry";

/** A point ready for a lightweight-charts Line/Histogram series (time still in unix seconds). */
export interface SeriesPoint extends IndicatorPoint {
  color?: string;
}

/** Output lines of one indicator, keyed by line role (see lineLayout() in IndicatorLayer). */
export type IndicatorOutput = Record<string, SeriesPoint[]>;

export const INTRADAY_TFS: ReadonlySet<Timeframe> = new Set(["1m", "5m", "15m", "30m", "1h", "4h"]);

/** Colors MACD histogram bars TradingView-style: sign plus whether the bar grew vs the previous one. */
export function colorHistogram(points: IndicatorPoint[], colors: Record<string, string>): SeriesPoint[] {
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1]!.value : p.value;
    const color = p.value >= 0
      ? (p.value >= prev ? colors.histUpStrong : colors.histUpWeak)
      : (p.value <= prev ? colors.histDownStrong : colors.histDownWeak);
    return color === undefined ? p : { ...p, color };
  });
}

export function computeIndicator(cfg: IndicatorConfig, bars: readonly Bar[], tf: Timeframe): IndicatorOutput {
  const def = INDICATOR_DEFS[cfg.type];
  switch (cfg.type) {
    case "sma":
      return { value: sma(bars, numParam(cfg, "period"), sourceParam(cfg)) };
    case "ema":
      return { value: ema(bars, numParam(cfg, "period"), sourceParam(cfg)) };
    case "vwap":
      // Intraday: session VWAP reset at 00:00 UTC. Daily+: cumulative from the first loaded bar.
      return { value: vwap(bars, INTRADAY_TFS.has(tf) ? "session" : "cumulative", sourceParam(cfg)) };
    case "bb": {
      const r = bollinger(bars, numParam(cfg, "period"), numParam(cfg, "stdDev"), sourceParam(cfg));
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    }
    case "rsi":
      return { value: rsi(bars, numParam(cfg, "period"), sourceParam(cfg)) };
    case "macd": {
      const r = macd(bars, numParam(cfg, "fast"), numParam(cfg, "slow"), numParam(cfg, "signal"), sourceParam(cfg));
      return { histogram: colorHistogram(r.histogram, def.colors), macd: r.macd, signal: r.signal };
    }
    case "atr":
      return { value: atr(bars, numParam(cfg, "period")) };
    case "volma": {
      const volume: SeriesPoint[] = bars.map((b) => ({
        time: b.time,
        value: b.volume,
        color: b.close >= b.open ? def.colors.volUp : def.colors.volDown,
      }));
      return { volume, value: volumeMa(bars, numParam(cfg, "period")) };
    }
  }
}
