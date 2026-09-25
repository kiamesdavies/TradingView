import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { PriceScaleMode, RangePreset } from "@eodview/shared";
import { useStore } from "../state/store";
import { isIntraday } from "./candles";
import {
  PRESET_TIMEFRAME, PRESET_TITLE, RANGE_PRESETS, dateToChartTime, goToTimeframe, isAlwaysOpen, parseDateInput, rangeStart,
  toDateInput,
} from "./ranges";
import {
  COMMON_ZONES, DEFAULT_TIMEZONE, exchangeTimeZone, formatClock, localTimeZone, offsetLabel, resolveTimeZone,
} from "./timezone";
import type { ChartHandle } from "./types";
import "./chart.css";

const DAY = 86_400;

type Popover = "goto" | "tz" | null;

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="2.5" y="3.5" width="13" height="12" rx="1.5" />
      <path d="M2.5 7.5h13M6 2v3M12 2v3" />
      <path d="M8 11h4M10 9v4" strokeLinecap="round" />
    </svg>
  );
}

/** TradingView-style bar under the chart: range presets, go-to-date, clock/time zone, ADJ / % / log / auto. */
export function ChartBottomBar({ handle }: { handle: ChartHandle | null }) {
  const symbol = useStore((s) => s.layout.symbol);
  const tf = useStore((s) => s.layout.tf);
  const tzSetting = useStore((s) => s.layout.timezone) ?? DEFAULT_TIMEZONE;
  const adjusted = useStore((s) => s.layout.adjusted ?? true);
  const logScale = useStore((s) => s.layout.logScale);
  const scaleSetting = useStore((s) => s.layout.priceScaleMode);
  const setLayout = useStore((s) => s.setLayout);
  const scaleMode: PriceScaleMode = scaleSetting ?? (logScale ? "log" : "normal");

  const [active, setActive] = useState<RangePreset | null>(null);
  const [busy, setBusy] = useState(false);
  const [popover, setPopover] = useState<Popover>(null);
  const [autoScale, setAutoScale] = useState(true);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [gotoFrom, setGotoFrom] = useState("");
  const [gotoTo, setGotoTo] = useState("");
  const [gotoError, setGotoError] = useState<string | null>(null);

  const activeRef = useRef<RangePreset | null>(null);
  const tokenRef = useRef(0);
  const busyRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const setBusyBoth = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  };

  const clearActive = useCallback(() => {
    if (activeRef.current === null) return;
    activeRef.current = null;
    tokenRef.current++;
    setActive(null);
    busyRef.current = false;
    setBusy(false);
  }, []);

  // --- range presets ---
  const applyPreset = useCallback(
    async (preset: RangePreset) => {
      if (!handle) return;
      const token = ++tokenRef.current;
      activeRef.current = preset;
      setActive(preset);
      const target = PRESET_TIMEFRAME[preset];
      const store = useStore.getState();
      if (store.layout.tf !== target) store.setTimeframe(target);
      setBusyBoth(true);
      try {
        const ok = await handle.whenLoaded(target);
        if (!ok || token !== tokenRef.current) return;
        const bars = handle.getBars();
        const last = bars[bars.length - 1];
        if (!last) return;
        const sym = handle.getSymbol();
        const from = rangeStart(preset, last.time, { tz: exchangeTimeZone(sym), alwaysOpen: isAlwaysOpen(sym) });
        if (from === null) {
          await handle.ensureHistory(-Infinity, 20);
          if (token !== tokenRef.current) return;
          handle.fitContent();
        } else {
          await handle.ensureHistory(from);
          if (token !== tokenRef.current) return;
          handle.setVisibleTimeRange(from);
        }
      } finally {
        if (token === tokenRef.current) setBusyBoth(false);
      }
    },
    [handle],
  );

  // A timeframe change that doesn't match the active preset (user picked another interval) ends the preset.
  useEffect(() => {
    const a = activeRef.current;
    if (a && PRESET_TIMEFRAME[a] !== tf) clearActive();
  }, [tf, clearActive]);

  // Keep the preset across reloads (symbol change, ADJ toggle): re-apply once the new bars arrive.
  useEffect(() => {
    if (!handle) return;
    return handle.onBarsChanged((bars, kind) => {
      if (kind !== "reset" || bars.length === 0 || busyRef.current) return;
      const a = activeRef.current;
      if (a && PRESET_TIMEFRAME[a] === handle.getTimeframe()) void applyPreset(a);
    });
  }, [handle, applyPreset]);

  // Manual scroll/zoom ends the preset highlight; pointer-up / dblclick may have toggled price autoscale.
  useEffect(() => {
    if (!handle) return;
    const el = handle.chart.chartElement();
    const timeScale = handle.chart.timeScale();
    let down = false;
    const readAuto = () => {
      try {
        setAutoScale(handle.chart.priceScale("right").options().autoScale);
      } catch {
        /* chart removed */
      }
    };
    const onWheel = () => clearActive();
    const onDown = () => {
      down = true;
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      readAuto();
    };
    const onRange = () => {
      if (down) clearActive();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("dblclick", readAuto);
    window.addEventListener("pointerup", onUp);
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    readAuto();
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("dblclick", readAuto);
      window.removeEventListener("pointerup", onUp);
      try {
        timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
      } catch {
        /* chart removed */
      }
    };
  }, [handle, clearActive]);

  // Scale mode changes may re-enable autoscale in lightweight-charts: re-read it.
  useEffect(() => {
    if (!handle) return;
    const id = requestAnimationFrame(() => {
      try {
        setAutoScale(handle.chart.priceScale("right").options().autoScale);
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [handle, scaleMode]);

  // --- clock ---
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // --- popovers: outside click / Esc closes ---
  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopover(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [popover]);

  const openGoto = () => {
    if (popover === "goto") {
      setPopover(null);
      return;
    }
    setGotoError(null);
    if (!gotoFrom) {
      const first = handle?.getBars()[0];
      const base = first ? first.time : now - 365 * DAY;
      setGotoFrom(toDateInput(Math.floor(base / DAY) * DAY));
    }
    setPopover("goto");
  };

  // --- go to date ---
  const goTo = async (e: FormEvent) => {
    e.preventDefault();
    if (!handle) return;
    const fromDate = parseDateInput(gotoFrom);
    const toDate = gotoTo ? parseDateInput(gotoTo) : null;
    if (fromDate === null) {
      setGotoError("Pick a date");
      return;
    }
    if (toDate !== null && toDate < fromDate) {
      setGotoError("End date is before the start date");
      return;
    }
    if (fromDate > now) {
      setGotoError("Date is in the future");
      return;
    }
    setPopover(null);
    clearActive();
    const token = ++tokenRef.current;
    const store = useStore.getState();
    const target = goToTimeframe(store.layout.tf, fromDate, now);
    if (target !== store.layout.tf) store.setTimeframe(target);
    setBusyBoth(true);
    try {
      const ok = await handle.whenLoaded(target);
      if (!ok || token !== tokenRef.current) return;
      const zone = resolveTimeZone(store.layout.timezone, handle.getSymbol());
      const from = dateToChartTime(fromDate, target, zone);
      await handle.ensureHistory(from);
      if (token !== tokenRef.current) return;
      if (toDate !== null) handle.setVisibleTimeRange(from, dateToChartTime(toDate + DAY, target, zone) - 1);
      else handle.scrollToTime(from);
    } finally {
      if (token === tokenRef.current) setBusyBoth(false);
    }
  };

  // --- toggles ---
  const setScale = (mode: PriceScaleMode) => {
    const next = scaleMode === mode ? "normal" : mode;
    setLayout({ priceScaleMode: next, logScale: next === "log" });
  };

  const toggleAuto = () => {
    if (!handle) return;
    const next = !autoScale;
    try {
      handle.chart.priceScale("right").applyOptions({ autoScale: next });
    } catch {
      return;
    }
    setAutoScale(next);
  };

  const zone = resolveTimeZone(tzSetting, symbol);
  const exchangeZone = exchangeTimeZone(symbol);
  const localZone = localTimeZone();
  const intraday = isIntraday(tf);
  const pickZone = (setting: string) => {
    setLayout({ timezone: setting });
    setPopover(null);
  };

  return (
    <div className="ev-rangebar" ref={rootRef} role="toolbar" aria-label="Chart range">
      <div className="ev-rb-group">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`ev-rb-btn${active === p ? " active" : ""}${active === p && busy ? " busy" : ""}`}
            aria-pressed={active === p}
            title={PRESET_TITLE[p]}
            disabled={!handle}
            onClick={() => void applyPreset(p)}
          >
            {p}
          </button>
        ))}
        <span className="ev-rb-sep" />
        <button
          type="button"
          className={`ev-rb-btn ev-rb-icon${popover === "goto" ? " open" : ""}`}
          title="Go to date"
          aria-label="Go to date"
          aria-expanded={popover === "goto"}
          disabled={!handle}
          onClick={openGoto}
        >
          <CalendarIcon />
        </button>
      </div>

      <div className="ev-rb-spacer" />

      <div className="ev-rb-group">
        <button
          type="button"
          className={`ev-rb-btn ev-rb-clock${popover === "tz" ? " open" : ""}`}
          title="Time zone"
          aria-haspopup="menu"
          aria-expanded={popover === "tz"}
          onClick={() => setPopover(popover === "tz" ? null : "tz")}
        >
          {formatClock(now, zone)}
        </button>
        <span className="ev-rb-sep" />
        <button
          type="button"
          className={`ev-rb-btn${adjusted && !intraday ? " active" : ""}`}
          aria-pressed={adjusted && !intraday}
          disabled={intraday}
          title={intraday ? "Adjustment for dividends/splits applies to daily and longer intervals" : "Adjust data for dividends and splits"}
          onClick={() => setLayout({ adjusted: !adjusted })}
        >
          ADJ
        </button>
        <button
          type="button"
          className={`ev-rb-btn${scaleMode === "percent" ? " active" : ""}`}
          aria-pressed={scaleMode === "percent"}
          title="Toggle percentage scale"
          onClick={() => setScale("percent")}
        >
          %
        </button>
        <button
          type="button"
          className={`ev-rb-btn${scaleMode === "log" ? " active" : ""}`}
          aria-pressed={scaleMode === "log"}
          title="Toggle log scale"
          onClick={() => setScale("log")}
        >
          log
        </button>
        <button
          type="button"
          className={`ev-rb-btn${autoScale ? " active" : ""}`}
          aria-pressed={autoScale}
          title="Toggle auto (fits data to screen)"
          disabled={!handle}
          onClick={toggleAuto}
        >
          auto
        </button>
      </div>

      {popover === "goto" && (
        <form className="ev-rb-pop ev-rb-goto" onSubmit={(e) => void goTo(e)}>
          <div className="ev-rb-pop-title">Go to</div>
          <label className="ev-rb-field">
            <span>Date</span>
            <input type="date" value={gotoFrom} max={toDateInput(now)} onChange={(e) => setGotoFrom(e.target.value)} autoFocus />
          </label>
          <label className="ev-rb-field">
            <span>To (optional)</span>
            <input type="date" value={gotoTo} max={toDateInput(now)} onChange={(e) => setGotoTo(e.target.value)} />
          </label>
          {gotoError && <div className="ev-rb-error">{gotoError}</div>}
          <div className="ev-rb-actions">
            {gotoTo && (
              <button type="button" className="ev-rb-link" onClick={() => setGotoTo("")}>
                Clear range
              </button>
            )}
            <button type="submit" className="ev-rb-primary">
              Go to
            </button>
          </div>
        </form>
      )}

      {popover === "tz" && (
        <div className="ev-rb-pop ev-rb-tzmenu" role="menu">
          <ZoneItem label="UTC" detail="" selected={tzSetting === "UTC"} onPick={() => pickZone("UTC")} />
          <ZoneItem
            label="Exchange"
            detail={`${exchangeZone} (${offsetLabel(now, exchangeZone)})`}
            selected={tzSetting === "exchange"}
            onPick={() => pickZone("exchange")}
          />
          <ZoneItem
            label="Local"
            detail={`${localZone} (${offsetLabel(now, localZone)})`}
            selected={tzSetting === "local"}
            onPick={() => pickZone("local")}
          />
          <div className="ev-rb-menu-sep" />
          {COMMON_ZONES.map((z) => (
            <ZoneItem
              key={z.tz}
              label={`(${offsetLabel(now, z.tz)}) ${z.label}`}
              detail=""
              selected={tzSetting === z.tz}
              onPick={() => pickZone(z.tz)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ZoneItem(props: { label: string; detail: string; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.selected}
      className={`ev-rb-menu-item${props.selected ? " selected" : ""}`}
      onClick={props.onPick}
    >
      <span>{props.label}</span>
      {props.detail && <span className="ev-rb-menu-detail">{props.detail}</span>}
    </button>
  );
}
