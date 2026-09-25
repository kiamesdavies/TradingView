import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ScreenerFilterDef, ScreenerFilterValue } from "@eodview/shared";
import { formatCustomBound, filterValueLabel, parseCustomBound, type CustomUnit } from "./format";
import { usePopoverDismiss } from "./hooks";
import { activeCounts, FILTER_TABS, filtersForTab, isCustom, type ScreenerUniverse } from "./queryState";
import { useScreener } from "./screenerStore";

const CUSTOM = "__custom";
const CUSTOM_ACTIVE = "__custom_active";

const UNIT_HINT: Record<CustomUnit, string> = {
  number: "e.g. 10",
  pct: "% e.g. 5",
  money: "e.g. 2B",
  volume: "e.g. 500K",
  date: "",
};

function CustomPopover({ def, value, onApply, onClose }: {
  def: ScreenerFilterDef;
  value: ScreenerFilterValue | undefined;
  onApply: (v: ScreenerFilterValue | null) => void;
  onClose: () => void;
}) {
  const unit = def.custom?.unit ?? "number";
  const cur = value && isCustom(value) ? value : undefined;
  const [min, setMin] = useState(formatCustomBound(cur?.min, unit));
  const [max, setMax] = useState(formatCustomBound(cur?.max, unit));
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(true, ref, onClose);

  const apply = () => {
    const a = parseCustomBound(min, unit);
    const b = parseCustomBound(max, unit);
    if (a === null || b === null) {
      setErr(unit === "date" ? "Use YYYY-MM-DD" : "Enter a number (K/M/B suffixes allowed)");
      return;
    }
    if ((typeof a === "number" && typeof b === "number" && a > b) || (typeof a === "string" && typeof b === "string" && a > b)) {
      setErr("Min is greater than max");
      return;
    }
    onApply(a === undefined && b === undefined ? null : { id: def.id, ...(a !== undefined ? { min: a } : {}), ...(b !== undefined ? { max: b } : {}) });
    onClose();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };
  const type = unit === "date" ? "date" : "text";

  return (
    <div ref={ref} className="scr-popover scr-custom" role="dialog" aria-label={`${def.label} custom range`} onKeyDown={onKey}>
      <div className="scr-popover-title">{def.label}</div>
      <div className="scr-custom-row">
        <label>
          <span>Min</span>
          <input className="input input-sm" type={type} value={min} placeholder={UNIT_HINT[unit]} autoFocus onChange={(e) => { setMin(e.target.value); setErr(null); }} />
        </label>
        <label>
          <span>Max</span>
          <input className="input input-sm" type={type} value={max} placeholder={UNIT_HINT[unit]} onChange={(e) => { setMax(e.target.value); setErr(null); }} />
        </label>
      </div>
      {err && <div className="error-text">{err}</div>}
      <div className="scr-popover-actions">
        <button type="button" className="btn btn-ghost scr-btn-sm" onClick={() => { onApply(null); onClose(); }}>Clear</button>
        <span className="scr-grow" />
        <button type="button" className="btn scr-btn-sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary scr-btn-sm" onClick={apply}>Apply</button>
      </div>
    </div>
  );
}

function FilterCell({ def, value, universe, customOpen, setCustomOpen }: {
  def: ScreenerFilterDef;
  value: ScreenerFilterValue | undefined;
  universe: ScreenerUniverse;
  customOpen: boolean;
  setCustomOpen: (open: boolean) => void;
}) {
  const setFilter = useScreener((s) => s.setFilter);
  const active = !!value;
  // v3: an active filter the current market can't evaluate is kept (struck through) but not sent
  const ignored = active && !def.available;
  const custom = value && isCustom(value);
  const selValue = !value ? "" : custom ? CUSTOM_ACTIVE : (value as { value: string }).value;
  const mismatch = (def.appliesTo === "stock" && universe === "etfs") || (def.appliesTo === "etf" && universe === "stocks");
  const reason = def.unavailableReason ?? "Not available for this market's data";
  const title = !def.available
    ? ignored
      ? `Ignored: ${reason}`
      : reason
    : mismatch
      ? `Applies to ${def.appliesTo === "etf" ? "ETFs" : "stocks"} only`
      : def.label;

  return (
    <div className={`scr-fcell${active ? " active" : ""}${!def.available ? " disabled" : ""}${ignored ? " ignored" : ""}${mismatch ? " mismatch" : ""}`}>
      <label className="scr-flabel" htmlFor={`scr-f-${def.id}`} title={title}>{def.label}</label>
      <select
        id={`scr-f-${def.id}`}
        className={`scr-select${active ? " active" : ""}`}
        value={selValue}
        title={title}
        disabled={!def.available}
        aria-describedby={!def.available ? `scr-f-${def.id}-why` : undefined}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) setCustomOpen(true);
          else if (v === CUSTOM_ACTIVE) return;
          else setFilter(def.id, v ? { id: def.id, value: v } : null);
        }}
      >
        <option value="">Any</option>
        {def.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {custom && <option value={CUSTOM_ACTIVE}>{filterValueLabel(def, value)}</option>}
        {def.custom && <option value={CUSTOM}>Custom…</option>}
      </select>
      {!def.available && <span id={`scr-f-${def.id}-why`} className="scr-sr-only">{reason}</span>}
      {ignored && (
        <button type="button" className="scr-fclear" aria-label={`Remove ${def.label}`} title={`Remove ${def.label} (ignored for this market)`} onClick={() => setFilter(def.id, null)}>
          ×
        </button>
      )}
      {customOpen && def.available && (
        <CustomPopover def={def} value={value} onApply={(v) => setFilter(def.id, v)} onClose={() => setCustomOpen(false)} />
      )}
    </div>
  );
}

export function FilterPanel() {
  const meta = useScreener((s) => s.meta);
  const filters = useScreener((s) => s.q.filters);
  const tab = useScreener((s) => s.q.tab);
  const universe = useScreener((s) => s.q.universe);
  const setTab = useScreener((s) => s.setTab);
  const [customFor, setCustomFor] = useState<string | null>(null);

  const defs = meta?.filters ?? [];
  const counts = useMemo(() => activeCounts(filters, defs), [filters, defs]);
  const byId = useMemo(() => new Map(filters.map((f) => [f.id, f])), [filters]);
  const shown = filtersForTab(defs, tab);
  const tabs = FILTER_TABS.filter((t) => t.id === "all" || defs.some((d) => d.group === t.id));

  return (
    <section className="scr-filters" aria-label="Filters">
      <div className="scr-ftabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`scr-ftab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {counts[t.id] > 0 && <span className="scr-count">{counts[t.id]}</span>}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="scr-fempty muted">No filters in this group.</div>
      ) : (
        <div className="scr-fgrid">
          {shown.map((def) => (
            <FilterCell
              key={def.id}
              def={def}
              value={byId.get(def.id)}
              universe={universe}
              customOpen={customFor === def.id}
              setCustomOpen={(open) => setCustomFor(open ? def.id : null)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Row of active-filter chips with × to remove. */
export function FilterChips() {
  const meta = useScreener((s) => s.meta);
  const filters = useScreener((s) => s.q.filters);
  const tickers = useScreener((s) => s.q.tickers);
  const removeFilter = useScreener((s) => s.removeFilter);
  const setTickers = useScreener((s) => s.setTickers);
  const reset = useScreener((s) => s.reset);
  const metaReady = useScreener((s) => s.metaMarket === s.q.market);
  const defs = useMemo(() => new Map((meta?.filters ?? []).map((d) => [d.id, d])), [meta]);
  if (filters.length === 0 && !tickers.trim()) return null;
  return (
    <div className="scr-chips" aria-label="Active filters">
      {tickers.trim() && (
        <span className="scr-chip">
          <span className="scr-chip-k">Tickers:</span> {tickers.trim()}
          <button type="button" aria-label="Remove tickers" onClick={() => setTickers("")}>×</button>
        </span>
      )}
      {filters.map((f) => {
        const def = defs.get(f.id);
        const ignored = metaReady && !!def && !def.available;
        const why = ignored ? `Ignored for this market: ${def?.unavailableReason ?? "no data"}` : def?.label ?? f.id;
        return (
          <span key={f.id} className={`scr-chip${ignored ? " ignored" : ""}`} title={why}>
            <span className="scr-chip-k">{def?.label ?? f.id}:</span> {filterValueLabel(def, f)}
            <button type="button" aria-label={`Remove ${def?.label ?? f.id}`} onClick={() => removeFilter(f.id)}>×</button>
          </span>
        );
      })}
      <button type="button" className="scr-link" onClick={reset}>Clear all</button>
    </div>
  );
}
