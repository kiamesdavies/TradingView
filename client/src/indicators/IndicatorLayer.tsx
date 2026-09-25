import { useEffect, useRef } from "react";
import {
  HistogramSeries, LineSeries, LineStyle,
  type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type PriceFormat, type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, IndicatorConfig, Timeframe } from "@eodview/shared";
import type { ChartHandle } from "../chart/types";
import { useStore } from "../state/store";
import { computeIndicator, type IndicatorOutput, type SeriesPoint } from "./compute";
import { BandFill } from "./bandFill";
import { INDICATOR_DEFS, indicatorLabel, mainColor, numParam } from "./registry";

/** Height of a freshly created oscillator pane, in px. */
const OSC_PANE_HEIGHT = 120;

interface LineSpec {
  key: string;
  kind: "line" | "histogram";
  color: string;
  width?: 1 | 2 | 3 | 4;
  style?: LineStyle;
  /** Shown on the price-scale label; only the first line of an indicator carries the full label. */
  title: string;
  volume?: boolean;
}

/** Visual layout of an indicator's lines, in creation (z) order. Keys match `computeIndicator` output. */
function lineLayout(cfg: IndicatorConfig): LineSpec[] {
  const def = INDICATOR_DEFS[cfg.type];
  const color = mainColor(cfg);
  const label = indicatorLabel(cfg);
  switch (cfg.type) {
    case "bb":
      return [
        { key: "upper", kind: "line", color, width: 1, title: "" },
        { key: "lower", kind: "line", color, width: 1, title: "" },
        { key: "middle", kind: "line", color: def.colors.middle ?? color, width: 1, title: label },
      ];
    case "macd":
      return [
        { key: "histogram", kind: "histogram", color: def.colors.histUpStrong ?? color, title: "" },
        { key: "macd", kind: "line", color, width: 2, title: label },
        { key: "signal", kind: "line", color: def.colors.signal ?? color, width: 2, title: "" },
      ];
    case "volma":
      return [
        { key: "volume", kind: "histogram", color: def.colors.volUp ?? color, title: "", volume: true },
        { key: "value", kind: "line", color, width: 2, title: label, volume: true },
      ];
    default:
      return [{ key: "value", kind: "line", color, width: 2, title: label }];
  }
}

/** Lines in price units follow the main series' precision; volume and RSI keep their own formats. */
function followsMainFormat(cfg: IndicatorConfig, spec: LineSpec): boolean {
  return !spec.volume && cfg.type !== "rsi";
}

type AnySeries =
  | { kind: "line"; api: ISeriesApi<"Line"> }
  | { kind: "histogram"; api: ISeriesApi<"Histogram"> };

interface DataCursor { len: number; last: number }

function toLw(p: SeriesPoint): { time: UTCTimestamp; value: number; color?: string } {
  return p.color === undefined
    ? { time: p.time as UTCTimestamp, value: p.value }
    : { time: p.time as UTCTimestamp, value: p.value, color: p.color };
}

/** Structural signature: a change here means the line set / pane assignment must be rebuilt. */
function structureKey(cfg: IndicatorConfig): string {
  return cfg.type;
}

/** Everything else that affects rendering (params + color). */
function configKey(cfg: IndicatorConfig): string {
  const params = Object.keys(cfg.params).sort().map((k) => `${k}=${String(cfg.params[k])}`).join("&");
  return `${cfg.type}|${cfg.color ?? ""}|${params}`;
}

/** Owns the series (and pane, for oscillators) of one IndicatorConfig. */
class IndicatorInstance {
  readonly id: string;
  readonly structure: string;
  private cfg: IndicatorConfig;
  private cfgKey: string;
  private readonly series = new Map<string, AnySeries>();
  private readonly cursors = new Map<string, DataCursor>();
  private band: BandFill | null = null;
  private priceLines: { series: ISeriesApi<"Line">; line: IPriceLine }[] = [];

  constructor(private readonly chart: IChartApi, cfg: IndicatorConfig, priceFormat: PriceFormat) {
    this.id = cfg.id;
    this.structure = structureKey(cfg);
    this.cfg = cfg;
    this.cfgKey = configKey(cfg);
    const def = INDICATOR_DEFS[cfg.type];

    let paneIndex = def.overlay ? 0 : chart.panes().length;
    let first = true;
    for (const spec of lineLayout(cfg)) {
      const format: PriceFormat = spec.volume
        ? { type: "volume", precision: 0, minMove: 1 }
        : followsMainFormat(cfg, spec) ? priceFormat : { type: "price", precision: 2, minMove: 0.01 };
      const common = {
        priceFormat: format,
        lastValueVisible: spec.title !== "" || spec.kind === "line",
        priceLineVisible: false,
        title: spec.title,
      };
      let s: AnySeries;
      if (spec.kind === "histogram") {
        s = { kind: "histogram", api: chart.addSeries(HistogramSeries, { ...common, color: spec.color, lastValueVisible: false }, paneIndex) };
      } else {
        s = {
          kind: "line",
          api: chart.addSeries(LineSeries, {
            ...common,
            color: spec.color,
            lineWidth: spec.width ?? 2,
            lineStyle: spec.style ?? LineStyle.Solid,
            crosshairMarkerVisible: !def.overlay || cfg.type !== "bb",
            autoscaleInfoProvider: cfg.type === "rsi" ? this.rsiAutoscale : undefined,
          }, paneIndex),
        };
      }
      this.series.set(spec.key, s);
      if (first && !def.overlay) {
        // Pane indices shift when other panes are removed; always resolve from the series itself.
        const pane = s.api.getPane();
        paneIndex = pane.paneIndex();
        try {
          pane.setHeight(OSC_PANE_HEIGHT);
        } catch {
          /* chart not laid out yet; the default stretch factor still applies */
        }
      }
      first = false;
    }

    if (cfg.type === "bb") {
      const middle = this.series.get("middle");
      if (middle) {
        this.band = new BandFill(mainColor(cfg));
        middle.api.attachPrimitive(this.band);
      }
    }
    this.syncPriceLines();
  }

  /** Adopt the main series' price format on every price-unit line (not volume, not RSI's 0-100 scale). */
  setPriceFormat(format: PriceFormat): void {
    for (const spec of lineLayout(this.cfg)) {
      if (!followsMainFormat(this.cfg, spec)) continue;
      const s = this.series.get(spec.key);
      if (!s) continue;
      try {
        if (s.kind === "line") s.api.applyOptions({ priceFormat: format });
        else s.api.applyOptions({ priceFormat: format });
      } catch {
        /* series removed */
      }
    }
  }

  /** RSI: autoscale but always keep the overbought/oversold bands in view. */
  private readonly rsiAutoscale = (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const res = original();
    const upper = numParam(this.cfg, "upper");
    const lower = numParam(this.cfg, "lower");
    if (!res || !res.priceRange) return { priceRange: { minValue: Math.min(lower, 30), maxValue: Math.max(upper, 70) } };
    return {
      ...res,
      priceRange: {
        minValue: Math.min(res.priceRange.minValue, lower),
        maxValue: Math.max(res.priceRange.maxValue, upper),
      },
    };
  };

  private syncPriceLines(): void {
    for (const { series, line } of this.priceLines) series.removePriceLine(line);
    this.priceLines = [];
    if (this.cfg.type !== "rsi") return;
    const s = this.series.get("value");
    if (!s || s.kind !== "line") return;
    const color = INDICATOR_DEFS.rsi.colors.band ?? "#787b86";
    for (const price of [numParam(this.cfg, "upper"), numParam(this.cfg, "lower")]) {
      const line = s.api.createPriceLine({
        price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "",
      });
      this.priceLines.push({ series: s.api, line });
    }
  }

  /** Apply a changed config of the same type in place (keeps the pane position). Returns true if data must be recomputed. */
  update(cfg: IndicatorConfig): boolean {
    const key = configKey(cfg);
    if (key === this.cfgKey) return false;
    this.cfg = cfg;
    this.cfgKey = key;
    for (const spec of lineLayout(cfg)) {
      const s = this.series.get(spec.key);
      if (!s) continue;
      if (s.kind === "line") s.api.applyOptions({ color: spec.color, title: spec.title });
      else s.api.applyOptions({ color: spec.color, title: spec.title });
    }
    this.band?.setColor(mainColor(cfg));
    this.syncPriceLines();
    this.cursors.clear();
    return true;
  }

  /** Recompute from bars. `incremental` (live tick) updates only the tail points when the shape allows it. */
  setData(bars: readonly Bar[], tf: Timeframe, incremental: boolean): void {
    const out: IndicatorOutput = computeIndicator(this.cfg, bars, tf);
    for (const [key, s] of this.series) {
      const points = out[key] ?? [];
      const prev = incremental ? this.cursors.get(key) : undefined;
      this.cursors.set(key, pushPoints(s, points, prev));
    }
    if (this.band) this.band.setData(out.upper ?? [], out.lower ?? []);
  }

  destroy(): void {
    try {
      if (this.band) this.series.get("middle")?.api.detachPrimitive(this.band);
      // Removing the last series of an oscillator pane removes the pane (panes are not preserved).
      for (const s of this.series.values()) this.chart.removeSeries(s.api);
    } catch {
      /* chart already disposed */
    }
    this.series.clear();
    this.priceLines = [];
    this.band = null;
  }
}

function pushPoints(s: AnySeries, points: readonly SeriesPoint[], prev: DataCursor | undefined): DataCursor {
  const n = points.length;
  const cursor: DataCursor = { len: n, last: n > 0 ? points[n - 1]!.time : Number.NaN };
  const upd = (p: SeriesPoint): void => {
    if (s.kind === "line") s.api.update(toLw(p)); else s.api.update(toLw(p));
  };
  if (prev && n > 0) {
    if (n === prev.len && points[n - 1]!.time === prev.last) {
      upd(points[n - 1]!);
      return cursor;
    }
    if (n === prev.len + 1 && n >= 2 && points[n - 2]!.time === prev.last) {
      upd(points[n - 2]!);
      upd(points[n - 1]!);
      return cursor;
    }
  }
  const data = points.map(toLw);
  if (s.kind === "line") s.api.setData(data); else s.api.setData(data);
  return cursor;
}

/**
 * Renders `layout.indicators` onto the chart exposed by `handle`: overlays on pane 0, one pane per oscillator.
 * Instances are diffed by config id so unchanged indicators keep their series.
 */
export function IndicatorLayer(props: { handle: ChartHandle | null }): null {
  const { handle } = props;
  const indicators = useStore((s) => s.layout.indicators);
  const tf = useStore((s) => s.layout.tf);
  const tfRef = useRef<Timeframe>(tf);
  tfRef.current = tf;
  const instances = useRef(new Map<string, IndicatorInstance>());
  const chartRef = useRef<IChartApi | null>(null);

  // Reconcile instances with the configured indicators.
  useEffect(() => {
    if (!handle) return;
    const map = instances.current;
    if (chartRef.current !== handle.chart) {
      for (const inst of map.values()) inst.destroy();
      map.clear();
      chartRef.current = handle.chart;
    }
    // Keep the price pane alive even if the main series is briefly removed (chart type switch).
    try {
      handle.chart.panes()[0]?.setPreserveEmptyPane(true);
    } catch {
      /* ignore */
    }

    const wanted = new Map(indicators.filter((c) => c.visible && c.type in INDICATOR_DEFS).map((c) => [c.id, c]));
    for (const [id, inst] of map) {
      const cfg = wanted.get(id);
      if (!cfg || structureKey(cfg) !== inst.structure) {
        inst.destroy();
        map.delete(id);
      }
    }

    const bars = handle.getBars();
    const priceFormat = handle.mainSeries.options().priceFormat;
    for (const cfg of wanted.values()) {
      const existing = map.get(cfg.id);
      if (existing) {
        if (existing.update(cfg)) existing.setData(bars, tfRef.current, false);
        continue;
      }
      const inst = new IndicatorInstance(handle.chart, cfg, priceFormat);
      inst.setData(bars, tfRef.current, false);
      map.set(cfg.id, inst);
    }
  }, [handle, indicators]);

  // Recompute on data changes. Re-subscribes when the handle is re-issued (e.g. chart type switch).
  useEffect(() => {
    if (!handle) return;
    // A new handle may carry bars loaded while no subscription existed.
    const bars = handle.getBars();
    for (const inst of instances.current.values()) inst.setData(bars, tfRef.current, false);
    // The main series' precision is only known once bars load (and changes with the symbol): follow it.
    const current = handle.mainSeries.options().priceFormat;
    for (const inst of instances.current.values()) inst.setPriceFormat(current);
    const offFormat = handle.onPriceFormatChanged((format) => {
      for (const inst of instances.current.values()) inst.setPriceFormat(format);
    });
    const offBars = handle.onBarsChanged((next, kind) => {
      for (const inst of instances.current.values()) inst.setData(next, tfRef.current, kind === "update");
    });
    return () => {
      offFormat();
      offBars();
    };
  }, [handle]);

  // Tear everything down on unmount.
  useEffect(() => () => {
    for (const inst of instances.current.values()) inst.destroy();
    instances.current.clear();
    chartRef.current = null;
  }, []);

  return null;
}
