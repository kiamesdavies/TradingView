import { describe, expect, test } from "bun:test";
import type { Bar, IndicatorConfig } from "@eodview/shared";
import { colorHistogram, computeIndicator } from "./compute";
import { INDICATOR_DEFS, INDICATOR_TYPES, createIndicator, indicatorLabel, numParam, sourceParam } from "./registry";

const H = 3600;
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5 + i * 0.1;
  return { time: 1_700_000_000 + i * H, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1000 + i };
});

const cfg = (type: IndicatorConfig["type"], params: IndicatorConfig["params"] = {}): IndicatorConfig =>
  ({ id: "x", type, params: { ...INDICATOR_DEFS[type].defaults, ...params }, visible: true });

describe("registry", () => {
  test("createIndicator uses defaults and unique ids", () => {
    const a = createIndicator("sma");
    const b = createIndicator("sma");
    expect(a.params).toEqual({ period: 20, source: "close" });
    expect(a.id).not.toBe(b.id);
    expect(a.visible).toBe(true);
  });
  test("numParam clamps, rounds and falls back", () => {
    expect(numParam(cfg("sma", { period: 0 }), "period")).toBe(1);
    expect(numParam(cfg("sma", { period: 12.6 }), "period")).toBe(13);
    expect(numParam(cfg("sma", { period: "abc" }), "period")).toBe(20);
    expect(numParam(cfg("sma", { period: "30" }), "period")).toBe(30);
  });
  test("sourceParam validates", () => {
    expect(sourceParam(cfg("sma", { source: "bogus" }))).toBe("close");
    expect(sourceParam(cfg("vwap"))).toBe("hlc3");
    expect(sourceParam(cfg("ema", { source: "hl2" }))).toBe("hl2");
  });
  test("labels", () => {
    expect(indicatorLabel(cfg("sma"))).toBe("SMA 20");
    expect(indicatorLabel(cfg("macd"))).toBe("MACD 12 26 9");
    expect(indicatorLabel(cfg("rsi"))).toBe("RSI 14");
    expect(indicatorLabel(cfg("ema", { source: "hl2" }))).toBe("EMA 50 hl2");
  });
});

describe("computeIndicator", () => {
  test("every type produces finite output lines", () => {
    for (const t of INDICATOR_TYPES) {
      const out = computeIndicator(cfg(t), bars, "1h");
      const lines = Object.values(out);
      expect(lines.length).toBeGreaterThan(0);
      for (const pts of lines) {
        expect(pts.length).toBeGreaterThan(0);
        for (const p of pts) expect(Number.isFinite(p.value)).toBe(true);
      }
    }
  });
  test("vwap anchor depends on timeframe", () => {
    // 80 hourly bars span several UTC days -> session VWAP resets, cumulative does not.
    const intraday = computeIndicator(cfg("vwap"), bars, "1h").value!;
    const daily = computeIndicator(cfg("vwap"), bars, "1D").value!;
    expect(intraday.at(-1)!.value).not.toBeCloseTo(daily.at(-1)!.value, 6);
  });
  test("macd histogram colored by sign and slope", () => {
    const c = INDICATOR_DEFS.macd.colors;
    const pts = colorHistogram(
      [{ time: 1, value: 1 }, { time: 2, value: 2 }, { time: 3, value: 1 }, { time: 4, value: -1 }, { time: 5, value: -0.5 }],
      c,
    );
    expect(pts.map((p) => p.color)).toEqual([c.histUpStrong, c.histUpStrong, c.histUpWeak, c.histDownStrong, c.histDownWeak]);
  });
});
