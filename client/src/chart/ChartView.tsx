import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type HistogramData,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type PriceFormat,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, ChartEvent, ChartType, PriceScaleMode as ScaleModeSetting, Symbol, Theme } from "@eodview/shared";
import { ApiRequestError, api } from "../api/http";
import { wsClient } from "../api/ws";
import { useStore } from "../state/store";
import { findBarIndex, heikinAshiStep, isIntraday, timeAtLogical, toHeikinAshi } from "./candles";
import { buildEventMarkers, eventsSupported, eventTitle, type EventMarker } from "./events";
import { centeredRange, logicalRangeForTimes } from "./ranges";
import { exchangeTimeZone, formatCrosshairTime, formatTickMark, resolveTimeZone } from "./timezone";
import { BarsController } from "./datafeed";
import { formatPrice, pricePrecision } from "./format";
import { ChartLegend, LegendSource } from "./ChartLegend";
import { PALETTES, type ChartPalette } from "./theme";
import type { BarsChangeKind, ChartHandle } from "./types";
import "./chart.css";

/** Start backfilling when fewer than this many bars remain left of the viewport. */
const BACKFILL_THRESHOLD = 10;
/** Bars shown after a fresh load. */
const INITIAL_VISIBLE_BARS = 150;
const RIGHT_OFFSET = 8;

type MainPoint =
  | { time: UTCTimestamp; open: number; high: number; low: number; close: number }
  | { time: UTCTimestamp; value: number };

interface Core {
  chart: IChartApi;
  volume: ISeriesApi<"Histogram">;
}

interface MainSeries {
  api: ISeriesApi<SeriesType>;
  type: ChartType;
}

interface LoadState {
  loading: boolean;
  error: { message: string; detail?: string; needsKey: boolean } | null;
}

interface EventTip {
  x: number;
  y: number;
  items: { key: string; color: string; title: string; detail: string }[];
}

/** How far ahead to ask for events (upcoming earnings). */
const EVENTS_LOOKAHEAD = 90 * 86_400;

const SCALE_MODES: Record<ScaleModeSetting, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
};

interface MenuState {
  x: number;
  y: number;
  price: number;
}

// ---------- pure-ish helpers ----------

const ts = (t: number) => t as UTCTimestamp;

function mainPoint(bar: Bar, type: ChartType): MainPoint {
  if (type === "line" || type === "area") return { time: ts(bar.time), value: bar.close };
  return { time: ts(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close };
}

function volumePoint(bar: Bar, pal: ChartPalette): HistogramData<UTCTimestamp> {
  return { time: ts(bar.time), value: bar.volume, color: bar.close >= bar.open ? pal.upVolume : pal.downVolume };
}

function priceFormat(precision: number) {
  return { type: "price" as const, precision, minMove: 1 / 10 ** precision };
}

function chartOptions(pal: ChartPalette) {
  return {
    layout: {
      background: { type: ColorType.Solid, color: pal.background },
      textColor: pal.text,
      fontSize: 12,
      attributionLogo: false,
      panes: { separatorColor: pal.border, separatorHoverColor: pal.grid },
    },
    grid: {
      vertLines: { color: pal.grid },
      horzLines: { color: pal.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: pal.crosshair, labelBackgroundColor: pal.overlayBorder },
      horzLine: { color: pal.crosshair, labelBackgroundColor: pal.overlayBorder },
    },
    rightPriceScale: { borderColor: pal.border },
    timeScale: { borderColor: pal.border },
  };
}

function createMainSeries(chart: IChartApi, type: ChartType, pal: ChartPalette, precision: number): ISeriesApi<SeriesType> {
  const common = { priceScaleId: "right", priceFormat: priceFormat(precision) };
  let s: ISeriesApi<SeriesType>;
  switch (type) {
    case "candles":
    case "heikin":
      s = chart.addSeries(
        CandlestickSeries,
        {
          ...common,
          upColor: pal.up,
          downColor: pal.down,
          borderUpColor: pal.up,
          borderDownColor: pal.down,
          wickUpColor: pal.up,
          wickDownColor: pal.down,
        },
        0,
      ) as ISeriesApi<SeriesType>;
      break;
    case "bars":
      s = chart.addSeries(BarSeries, { ...common, upColor: pal.up, downColor: pal.down, thinBars: false }, 0) as ISeriesApi<SeriesType>;
      break;
    case "line":
      s = chart.addSeries(LineSeries, { ...common, color: pal.line, lineWidth: 2 }, 0) as ISeriesApi<SeriesType>;
      break;
    case "area":
      s = chart.addSeries(
        AreaSeries,
        { ...common, lineColor: pal.line, topColor: pal.areaTop, bottomColor: pal.areaBottom, lineWidth: 2 },
        0,
      ) as ISeriesApi<SeriesType>;
      break;
  }
  s.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
  return s;
}

async function describeLoadError(e: unknown): Promise<NonNullable<LoadState["error"]>> {
  const message = e instanceof Error ? e.message : String(e);
  const detail = e instanceof ApiRequestError ? e.detail : undefined;
  let needsKey = /api[\s_-]?key|no[\s_-]?key|api_token/i.test(`${message} ${detail ?? ""}`);
  if (e instanceof ApiRequestError && e.status === 401) needsKey = true;
  if (!needsKey) {
    try {
      const health = await api.get<{ ok: boolean; hasKey: boolean }>("/health");
      needsKey = !health.hasKey;
    } catch {
      // server unreachable; keep the original error
    }
  }
  if (needsKey) return { message: "Set your EODHD API key in Settings", detail, needsKey };
  return { message: `Could not load bars: ${message}`, detail, needsKey };
}

// ---------- component ----------

export function ChartView(props: { onReady?: (h: ChartHandle) => void }) {
  const symbol = useStore((s) => s.layout.symbol);
  const tf = useStore((s) => s.layout.tf);
  const chartType = useStore((s) => s.layout.chartType);
  const theme = useStore((s) => s.layout.theme);
  const logScale = useStore((s) => s.layout.logScale);
  const scaleSetting = useStore((s) => s.layout.priceScaleMode);
  const adjusted = useStore((s) => s.layout.adjusted ?? true);
  const tzSetting = useStore((s) => s.layout.timezone);
  const alerts = useStore((s) => s.alerts);
  const createAlert = useStore((s) => s.createAlert);
  const setUi = useStore((s) => s.setUi);
  const settingsOpen = useStore((s) => s.ui.settingsOpen);
  const upstream = useStore((s) => s.ui.upstream);

  const pal = PALETTES[theme];
  const containerRef = useRef<HTMLDivElement>(null);
  const [controller] = useState(() => new BarsController());
  const [legend] = useState(() => new LegendSource());
  const [core, setCore] = useState<Core | null>(null);
  const [main, setMain] = useState<MainSeries | null>(null);
  const [load, setLoad] = useState<LoadState>({ loading: true, error: null });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [precision, setPrecision] = useState(2);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [events, setEvents] = useState<{ symbol: Symbol; list: ChartEvent[] }>({ symbol: "", list: [] });
  const [eventTip, setEventTip] = useState<EventTip | null>(null);

  // Mutable mirrors read from chart callbacks (avoid re-subscribing on every render).
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  const palRef = useRef(pal);
  palRef.current = pal;
  const precisionRef = useRef(precision);
  precisionRef.current = precision;
  const consumers = useRef(new Set<(bars: Bar[], kind: BarsChangeKind) => void>()).current;
  const formatListeners = useRef(new Set<(format: PriceFormat) => void>()).current;
  /** Renders a controller change into the current series; replaced whenever core/main change. */
  const renderRef = useRef<((bars: Bar[], kind: BarsChangeKind) => void) | null>(null);
  /** Recomputes event markers after bars change; set by the markers effect. */
  const markersRef = useRef<((bars: Bar[], kind: BarsChangeKind) => void) | null>(null);
  const markerById = useRef(new Map<string, EventMarker>());
  const markersByTime = useRef(new Map<number, EventMarker[]>());
  const eventsFromRef = useRef<{ symbol: Symbol; from: number } | null>(null);

  // --- chart lifetime ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const p = palRef.current;
    const chart = createChart(el, {
      ...chartOptions(p),
      autoSize: true,
      timeScale: {
        borderColor: p.border,
        rightOffset: RIGHT_OFFSET,
        timeVisible: isIntraday(controller.tf),
        secondsVisible: false,
        minBarSpacing: 0.2,
      },
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false },
      0,
    );
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    setCore({ chart, volume });
    return () => {
      setCore(null);
      setMain(null);
      // Remove after the other unmount cleanups (main series, indicator and drawing layers) have run: they still
      // call into the chart, and doing so on a removed chart schedules a redraw that throws "Object is disposed".
      queueMicrotask(() => chart.remove());
    };
  }, [controller]);

  // --- controller → series + consumers (single subscription; ChartView renders before consumers run) ---
  useEffect(() => {
    return controller.onChange((bars, kind) => {
      renderRef.current?.(bars, kind);
      markersRef.current?.(bars, kind);
      legend.refresh(bars);
      for (const cb of [...consumers]) {
        try {
          cb(bars, kind);
        } catch (e) {
          console.error("[chart] onBarsChanged consumer failed", e);
        }
      }
    });
  }, [controller, legend, consumers]);

  // --- main series (recreated on chart type change) ---
  useEffect(() => {
    if (!core) return;
    const api = createMainSeries(core.chart, chartType, palRef.current, precisionRef.current);
    // A recreated series is appended last, but the right price scale takes its formatter from the lowest-ordered
    // series on it: move the main series in front of any indicator overlays (just after the volume histogram).
    try {
      api.setSeriesOrder(core.volume.seriesOrder() + 1);
    } catch {
      /* ignore */
    }
    setMain({ api, type: chartType });
    return () => {
      renderRef.current = null;
      try {
        core.chart.removeSeries(api);
      } catch {
        // chart already removed
      }
    };
  }, [core, chartType]);

  // --- rendering, handle, chart subscriptions ---
  useEffect(() => {
    if (!core || !main) return;
    const { chart, volume } = core;
    const series = main.api;
    const timeScale = chart.timeScale();
    let ha: Bar[] = [];
    let renderedFirst: number | null = null;

    // lightweight-charts applies setVisibleLogicalRange on its next animation frame, and until then
    // getVisibleLogicalRange() (and range events fired by setData) still report the old viewport. Remember the
    // range we asked for so a backfill/prepend landing in the same frame builds on it instead of the stale one
    // (otherwise a range preset right after a timeframe switch was overwritten and the whole history shown).
    let pendingRange: LogicalRange | null = null;
    let pendingFrame = 0;
    const setRange = (r: LogicalRange) => {
      pendingRange = r;
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingRange = null;
      });
      timeScale.setVisibleLogicalRange(r);
    };
    const currentRange = (): LogicalRange | null => pendingRange ?? timeScale.getVisibleLogicalRange();

    const setAll = (bars: Bar[]) => {
      const p = palRef.current;
      if (main.type === "heikin") {
        ha = toHeikinAshi(bars);
        series.setData(ha.map((b) => mainPoint(b, "heikin")));
      } else {
        series.setData(bars.map((b) => mainPoint(b, main.type)));
      }
      volume.setData(bars.map((b) => volumePoint(b, p)));
      renderedFirst = bars.length ? bars[0]!.time : null;
    };

    const updateLast = (bars: Bar[]) => {
      const n = bars.length;
      const last = bars[n - 1];
      if (!last) return;
      let display = last;
      if (main.type === "heikin") {
        if (ha.length === n) ha[n - 1] = heikinAshiStep(ha[n - 2], last);
        else if (ha.length === n - 1) ha.push(heikinAshiStep(ha[n - 2], last));
        else ha = toHeikinAshi(bars);
        display = ha[n - 1]!;
      }
      try {
        series.update(mainPoint(display, main.type));
        volume.update(volumePoint(last, palRef.current));
      } catch {
        setAll(bars); // out-of-order update: fall back to a full redraw
      }
    };

    const applyPrecision = (bars: Bar[]) => {
      const next = pricePrecision(controller.symbol, bars);
      if (next !== precisionRef.current) {
        precisionRef.current = next;
        setPrecision(next);
      }
      const format = priceFormat(next);
      series.applyOptions({ priceFormat: format });
      for (const cb of [...formatListeners]) {
        try {
          cb(format);
        } catch (e) {
          console.error("[chart] onPriceFormatChanged consumer failed", e);
        }
      }
    };

    const render = (bars: Bar[], kind: BarsChangeKind | "initial") => {
      if (kind === "update") {
        updateLast(bars);
        return;
      }
      if (kind === "reset") {
        const n = bars.length;
        const target = n > INITIAL_VISIBLE_BARS ? ({ from: n - INITIAL_VISIBLE_BARS, to: n - 1 + RIGHT_OFFSET } as LogicalRange) : null;
        // Set before setData: the range event it fires still carries the previous timeframe's viewport.
        pendingRange = target;
        setAll(bars);
        chart.applyOptions({ timeScale: { timeVisible: isIntraday(controller.tf) } });
        if (n) {
          applyPrecision(bars);
          if (target) setRange(target);
          else timeScale.fitContent();
        }
        return;
      }
      if (kind === "prepend") {
        // Keep the viewport on the same bars: shift by however many bars appeared in front of the old first bar.
        const before = currentRange();
        const oldFirst = renderedFirst;
        setAll(bars);
        const shift = oldFirst === null ? 0 : Math.max(0, findBarIndex(bars, oldFirst));
        if (before && shift > 0) setRange({ from: before.from + shift, to: before.to + shift } as LogicalRange);
        return;
      }
      // initial: new series over existing data, viewport untouched
      setAll(bars);
      if (bars.length) applyPrecision(bars);
    };
    renderRef.current = render;
    render(controller.bars, "initial");

    const onRange = (reported: LogicalRange | null) => {
      const range = pendingRange ?? reported;
      if (!range || range.from >= BACKFILL_THRESHOLD) return;
      if (!controller.hasMore || controller.isLoadingOlder) return;
      void controller.loadOlder();
    };
    timeScale.subscribeVisibleLogicalRangeChange(onRange);

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const t = param.point && typeof param.time === "number" ? param.time : null;
      legend.setHover(t, controller.bars);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const handle: ChartHandle = {
      chart,
      mainSeries: series,
      getBars: () => controller.bars,
      onBarsChanged: (cb) => {
        consumers.add(cb);
        return () => {
          consumers.delete(cb);
        };
      },
      onPriceFormatChanged: (cb) => {
        formatListeners.add(cb);
        return () => {
          formatListeners.delete(cb);
        };
      },
      coordinateToPoint: (x, y) => {
        const price = series.coordinateToPrice(y);
        if (price === null || !Number.isFinite(price)) return null;
        const t = timeScale.coordinateToTime(x);
        if (typeof t === "number") return { time: t, price };
        const logical = timeScale.coordinateToLogical(x);
        if (logical === null) return null;
        const time = timeAtLogical(controller.bars, logical, controller.tf);
        return time === null ? null : { time, price };
      },
      getSymbol: () => controller.symbol,
      getTimeframe: () => controller.tf,
      whenLoaded: (tf) => controller.whenLoaded(useStore.getState().layout.symbol, tf),
      ensureHistory: (fromTime, maxPages) => controller.ensureHistory(fromTime, maxPages),
      setVisibleTimeRange: (from, to) => {
        const r = logicalRangeForTimes(controller.bars, from, to);
        if (r) setRange(r as LogicalRange);
      },
      scrollToTime: (time) => {
        const cur = currentRange();
        const width = cur ? cur.to - cur.from : INITIAL_VISIBLE_BARS;
        const r = centeredRange(controller.bars, time, width);
        if (r) setRange(r as LogicalRange);
      },
      fitContent: () => {
        pendingRange = null;
        timeScale.fitContent();
      },
    };
    onReadyRef.current?.(handle);

    return () => {
      cancelAnimationFrame(pendingFrame);
      if (renderRef.current === render) renderRef.current = null;
      timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCrosshair);
    };
  }, [core, main, controller, legend, consumers, formatListeners]);

  // --- theme ---
  useEffect(() => {
    if (!core) return;
    core.chart.applyOptions(chartOptions(pal));
    const bars = controller.bars;
    if (bars.length) core.volume.setData(bars.map((b) => volumePoint(b, pal)));
  }, [core, pal, controller]);

  // --- price scale mode (priceScaleMode supersedes the v1 logScale flag) ---
  const scaleMode: ScaleModeSetting = scaleSetting ?? (logScale ? "log" : "normal");
  useEffect(() => {
    if (!main) return;
    main.api.priceScale().applyOptions({ mode: SCALE_MODES[scaleMode] ?? PriceScaleMode.Normal });
  }, [main, scaleMode]);

  // --- time zone: axis ticks + crosshair label ---
  const tz = resolveTimeZone(tzSetting, symbol);
  const intradayTf = isIntraday(tf);
  useEffect(() => {
    if (!core) return;
    core.chart.applyOptions({
      localization: {
        timeFormatter: (time: Time) => (typeof time === "number" ? formatCrosshairTime(time, tz, intradayTf) : String(time)),
      },
      timeScale: {
        tickMarkFormatter: (time: Time, type: TickMarkType) =>
          typeof time === "number" ? formatTickMark(time, type, tz, intradayTf) : null,
      },
    });
  }, [core, tz, intradayTf]);

  // --- bar loading (the ADJ toggle only matters for daily+) ---
  const adjKey = intradayTf ? true : adjusted;
  useEffect(() => {
    let cancelled = false;
    setLoad({ loading: true, error: null });
    setMenu(null);
    controller.load(symbol, tf, adjKey).then(
      (current) => {
        if (!cancelled && current) setLoad({ loading: false, error: null });
      },
      async (e: unknown) => {
        if (cancelled) return;
        const error = await describeLoadError(e);
        if (!cancelled) setLoad({ loading: false, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller, symbol, tf, adjKey, reloadNonce]);

  // Retry automatically once the user fixes the key (settings dialog closed / upstream came up).
  const errorRef = useRef(load.error);
  errorRef.current = load.error;
  const prevSettingsOpen = useRef(settingsOpen);
  const prevUpstream = useRef(upstream);
  useEffect(() => {
    const closed = prevSettingsOpen.current && !settingsOpen;
    const cameUp = prevUpstream.current !== upstream && upstream === "connected";
    prevSettingsOpen.current = settingsOpen;
    prevUpstream.current = upstream;
    if (errorRef.current && (closed || cameUp)) setReloadNonce((n) => n + 1);
  }, [settingsOpen, upstream]);

  // --- live data ---
  useEffect(() => {
    const release = wsClient.subscribe([symbol]);
    const offTick = wsClient.on("tick", (msg) => {
      controller.applyTick(msg.tick);
    });
    const offQuote = wsClient.on("quote", (msg) => {
      controller.applyQuote(msg.quote);
    });
    // After a socket drop, ticks were missed: re-sync the tail from REST.
    let dropped = false;
    const offConn = wsClient.onConnection((connected) => {
      if (!connected) dropped = true;
      else if (dropped) {
        dropped = false;
        void controller.refreshTail();
      }
    });
    wsClient.connect();
    return () => {
      offTick();
      offQuote();
      offConn();
      release();
    };
  }, [controller, symbol]);

  // --- chart events (earnings / dividends / splits): fetch for the loaded span, widen after backfill ---
  useEffect(() => {
    setEvents({ symbol, list: [] });
    setEventTip(null);
    eventsFromRef.current = null;
    if (!eventsSupported(symbol)) return;
    let cancelled = false;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const maybeFetch = () => {
      const bars = controller.bars;
      if (cancelled || inflight || bars.length === 0 || controller.symbol !== symbol) return;
      const oldest = bars[0]!.time;
      const have = eventsFromRef.current;
      if (have && have.symbol === symbol && have.from <= oldest) return;
      const from = oldest - 31 * 86_400; // cover the whole first week/month bucket
      const to = Math.floor(Date.now() / 1000) + EVENTS_LOOKAHEAD;
      inflight = true;
      api
        .get<ChartEvent[]>(`/symbols/${encodeURIComponent(symbol)}/events?from=${from}&to=${to}`)
        .then(
          (list) => {
            if (cancelled) return;
            eventsFromRef.current = { symbol, from };
            setEvents({ symbol, list: Array.isArray(list) ? list : [] });
          },
          (e: unknown) => {
            if (cancelled) return;
            eventsFromRef.current = { symbol, from }; // don't retry on every bar change
            console.warn("[chart] events unavailable", e);
          },
        )
        .finally(() => {
          inflight = false;
        });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(maybeFetch, 300);
    };
    schedule();
    const off = controller.onChange((bars, kind) => {
      if (kind !== "update" && bars.length > 0) schedule();
    });
    return () => {
      cancelled = true;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [controller, symbol]);

  // --- event markers on the main series (re-created with the series; recomputed after reset/backfill/new bar) ---
  useEffect(() => {
    if (!main) return;
    const plugin: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(main.api, []);
    let lastLen = -1;
    let lastFirst: number | null = null;
    const apply = (bars: Bar[]) => {
      const list = events.symbol === controller.symbol ? events.list : [];
      const ms = buildEventMarkers(list, bars, controller.tf, {
        tz: exchangeTimeZone(controller.symbol),
        now: Math.floor(Date.now() / 1000),
      });
      markerById.current = new Map(ms.map((m) => [m.id, m]));
      const byTime = new Map<number, EventMarker[]>();
      for (const m of ms) byTime.set(m.time, [...(byTime.get(m.time) ?? []), m]);
      markersByTime.current = byTime;
      const out: SeriesMarker<Time>[] = ms.map((m) => ({
        id: m.id,
        time: ts(m.time),
        position: m.position,
        shape: m.shape,
        color: m.color,
        text: m.text,
        size: m.size,
      }));
      try {
        plugin.setMarkers(out);
      } catch (e) {
        console.warn("[chart] could not set event markers", e);
      }
      lastLen = bars.length;
      lastFirst = bars.length ? bars[0]!.time : null;
    };
    apply(controller.bars);
    markersRef.current = (bars, kind) => {
      if (kind === "update" && bars.length === lastLen && (bars[0]?.time ?? null) === lastFirst) return;
      apply(bars);
    };
    return () => {
      markersRef.current = null;
      markerById.current = new Map();
      markersByTime.current = new Map();
      try {
        plugin.detach();
      } catch {
        // series already removed
      }
    };
  }, [main, events, controller]);

  // --- event marker tooltip ---
  useEffect(() => {
    if (!core || !main) return;
    const onMove = (param: MouseEventParams<Time>) => {
      if (!param.point || markerById.current.size === 0) {
        setEventTip((prev) => (prev ? null : prev));
        return;
      }
      let hits: EventMarker[] = [];
      const info = param.hoveredInfo;
      const id = info && info.objectKind === "series-marker" ? info.objectId : param.hoveredObjectId;
      const byId = typeof id === "string" ? markerById.current.get(id) : undefined;
      if (byId) hits = markersByTime.current.get(byId.time) ?? [byId];
      else if (typeof param.time === "number") {
        // Fallback hit test: markers sit below the bar's low.
        const atBar = markersByTime.current.get(param.time);
        const bar = atBar ? controller.bars[findBarIndex(controller.bars, param.time)] : undefined;
        const yLow = bar ? main.api.priceToCoordinate(bar.low) : null;
        if (atBar && yLow !== null && param.point.y > yLow + 2 && param.point.y < yLow + 16 + 22 * atBar.length) hits = atBar;
      }
      if (hits.length === 0) {
        setEventTip((prev) => (prev ? null : prev));
        return;
      }
      const x = param.point.x;
      const y = param.point.y;
      setEventTip({
        x,
        y,
        items: hits.map((m) => ({ key: m.id, color: m.color, title: eventTitle(m.event), detail: m.event.detail })),
      });
    };
    core.chart.subscribeCrosshairMove(onMove);
    return () => {
      core.chart.unsubscribeCrosshairMove(onMove);
      setEventTip(null);
    };
  }, [core, main, controller]);

  // --- alert price lines ---
  useEffect(() => {
    if (!main) return;
    const lines: IPriceLine[] = [];
    for (const a of alerts) {
      if (!a.active || a.symbol !== symbol) continue;
      lines.push(
        main.api.createPriceLine({
          price: a.price,
          color: pal.alertLine,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "⏰",
        }),
      );
    }
    return () => {
      for (const l of lines) {
        try {
          main.api.removePriceLine(l);
        } catch {
          // series already removed
        }
      }
    };
  }, [main, alerts, symbol, pal]);

  // --- context menu ---
  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el || !core || !main) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const paneHeight = core.chart.paneSize(0).height;
      const plotWidth = core.chart.timeScale().width();
      if (y < 0 || y > paneHeight || x < 0 || x > plotWidth) return; // not over the price pane: default menu
      const price = main.api.coordinateToPrice(y);
      if (price === null || !Number.isFinite(price) || price <= 0) return;
      e.preventDefault();
      const menuWidth = 200;
      const menuHeight = 72;
      setMenu({
        x: Math.min(x, rect.width - menuWidth - 4),
        y: Math.min(y, rect.height - menuHeight - 4),
        price: Number(price.toFixed(precisionRef.current)),
      });
    },
    [core, main],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".ev-chart-menu")) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const addAlert = async (price: number) => {
    setMenu(null);
    try {
      await createAlert({ symbol, price, condition: "cross", repeat: false });
      setNotice(`Alert set at ${formatPrice(price, precisionRef.current)}`);
    } catch (e) {
      setNotice(`Could not create alert: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copyPrice = async (price: number) => {
    setMenu(null);
    const text = formatPrice(price, precisionRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${text}`);
    } catch {
      setNotice(`Price: ${text}`);
    }
  };

  const style = useMemo(() => cssVars(pal, theme), [pal, theme]);

  return (
    <div className="ev-chart" style={style} onContextMenu={onContextMenu}>
      <div ref={containerRef} className="ev-chart-canvas" />
      <ChartLegend source={legend} symbol={symbol} tf={tf} precision={precision} palette={pal} />
      {load.loading && (
        <div className="ev-chart-overlay" aria-busy="true">
          <div className="ev-chart-spinner" role="progressbar" aria-label="Loading bars" />
        </div>
      )}
      {load.error && (
        <div className="ev-chart-overlay">
          <div className="ev-chart-error" role="alert">
            <div>{load.error.message}</div>
            {load.error.detail && <div className="ev-chart-error-detail">{load.error.detail}</div>}
            <div className="ev-chart-error-actions">
              {load.error.needsKey && (
                <button type="button" className="ev-chart-btn ev-chart-btn-primary" onClick={() => setUi({ settingsOpen: true })}>
                  Open Settings
                </button>
              )}
              <button type="button" className="ev-chart-btn" onClick={() => setReloadNonce((n) => n + 1)}>
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
      {menu && (
        <div className="ev-chart-menu" role="menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          <button type="button" role="menuitem" className="ev-chart-menu-item" autoFocus onClick={() => void addAlert(menu.price)}>
            {`Add alert at ${formatPrice(menu.price, precision)}`}
          </button>
          <button type="button" role="menuitem" className="ev-chart-menu-item" onClick={() => void copyPrice(menu.price)}>
            Copy price
          </button>
        </div>
      )}
      {eventTip && (
        <div
          className="ev-chart-evtip"
          role="tooltip"
          style={{
            left: Math.max(4, Math.min(eventTip.x + 14, (containerRef.current?.clientWidth ?? 9999) - 274)),
            top: Math.max(4, Math.min(eventTip.y + 14, (containerRef.current?.clientHeight ?? 9999) - 24 - 46 * eventTip.items.length)),
          }}
        >
          {eventTip.items.map((it) => (
            <div key={it.key} className="ev-chart-evtip-item">
              <div className="ev-chart-evtip-title">
                <span className="ev-chart-evtip-dot" style={{ background: it.color }} />
                {it.title}
              </div>
              {it.detail && <div className="ev-chart-evtip-detail">{it.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {notice && <div className="ev-chart-notice">{notice}</div>}
    </div>
  );
}

function cssVars(pal: ChartPalette, theme: Theme): CSSProperties {
  return {
    "--ev-chart-bg": pal.background,
    "--ev-chart-text": pal.text,
    "--ev-chart-muted": pal.muted,
    "--ev-chart-border": pal.overlayBorder,
    "--ev-chart-panel": pal.overlayBg,
    "--ev-chart-accent": pal.line,
    "--ev-chart-hover": theme === "dark" ? "#2a2e39" : "#f0f3fa",
  } as CSSProperties;
}

