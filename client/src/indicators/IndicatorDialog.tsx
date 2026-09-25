import { useEffect, useMemo, useRef, useState } from "react";
import type { IndicatorConfig, IndicatorType } from "@eodview/shared";
import { useStore } from "../state/store";
import {
  INDICATOR_DEFS, INDICATOR_TYPES, PRICE_SOURCES, createIndicator, indicatorLabel, mainColor, numParam, sourceParam,
  type ParamSpec,
} from "./registry";
import "./indicators.css";

function NumberParam(props: { spec: Extract<ParamSpec, { kind: "int" | "float" }>; value: number; onCommit: (v: number) => void }) {
  const { spec, value, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const parse = (s: string): number | null => {
    const v = Number(s);
    if (s.trim() === "" || !Number.isFinite(v)) return null;
    if (v < spec.min || v > spec.max) return null;
    if (spec.kind === "int" && !Number.isInteger(v)) return null;
    return v;
  };
  const valid = parse(draft) !== null;

  return (
    <label className="ind-param">
      <span className="ind-param-label">{spec.label}</span>
      <input
        className={`ind-input${valid ? "" : " ind-input-invalid"}`}
        type="number"
        min={spec.min}
        max={spec.max}
        step={spec.kind === "float" ? spec.step : 1}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parse(e.target.value);
          if (v !== null && v !== value) onCommit(v);
        }}
        onBlur={() => { if (!valid) setDraft(String(value)); }}
      />
    </label>
  );
}

function IndicatorRow(props: {
  cfg: IndicatorConfig;
  onChange: (next: IndicatorConfig) => void;
  onRemove: () => void;
}) {
  const { cfg, onChange, onRemove } = props;
  const def = INDICATOR_DEFS[cfg.type];
  const setParam = (key: string, v: number | string): void => onChange({ ...cfg, params: { ...cfg.params, [key]: v } });

  return (
    <li className={`ind-row${cfg.visible ? "" : " ind-row-hidden"}`}>
      <div className="ind-row-head">
        <input
          className="ind-color"
          type="color"
          value={mainColor(cfg)}
          title="Color"
          aria-label="Color"
          onChange={(e) => onChange({ ...cfg, color: e.target.value })}
        />
        <span className="ind-row-title" title={def.name}>{indicatorLabel(cfg)}</span>
        <span className="ind-tag">{def.overlay ? "overlay" : "pane"}</span>
        <button
          type="button"
          className="ind-icon-btn"
          title={cfg.visible ? "Hide" : "Show"}
          aria-pressed={!cfg.visible}
          onClick={() => onChange({ ...cfg, visible: !cfg.visible })}
        >
          {cfg.visible ? (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M3.3 2 2 3.3l3.2 3.2C3.6 7.9 2.5 9.8 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.6 4.8-1.4l3.9 3.9 1.3-1.3L3.3 2ZM12 16.5A4.5 4.5 0 0 1 7.5 12c0-.8.2-1.5.6-2.2l1.5 1.5a2.5 2.5 0 0 0 3.1 3.1l1.5 1.5c-.7.4-1.4.6-2.2.6ZM12 5c5 0 9 4.5 10 7-.5 1.3-1.8 3-3.5 4.4l-2.9-2.9c.3-.7.4-1.4.4-2.1A4.5 4.5 0 0 0 11.5 7L9.2 5.4C10.1 5.1 11 5 12 5Z" />
            </svg>
          )}
        </button>
        <button type="button" className="ind-icon-btn ind-remove" title="Remove" onClick={onRemove}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z" />
          </svg>
        </button>
      </div>
      {def.params.length > 0 && (
        <div className="ind-params">
          {def.params.map((spec) =>
            spec.kind === "source" ? (
              <label key={spec.key} className="ind-param">
                <span className="ind-param-label">{spec.label}</span>
                <select className="ind-input" value={sourceParam(cfg)} onChange={(e) => setParam(spec.key, e.target.value)}>
                  {PRICE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            ) : (
              <NumberParam key={spec.key} spec={spec} value={numParam(cfg, spec.key)} onCommit={(v) => setParam(spec.key, v)} />
            ),
          )}
        </div>
      )}
    </li>
  );
}

export function IndicatorDialog(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const indicators = useStore((s) => s.layout.indicators);
  const setIndicators = useStore((s) => s.setIndicators);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INDICATOR_TYPES.filter((t) => {
      const d = INDICATOR_DEFS[t];
      return q === "" || d.name.toLowerCase().includes(q) || d.short.toLowerCase().includes(q);
    });
  }, [query]);

  if (!open) return null;

  // Read the latest list at action time so rapid edits never overwrite each other.
  const current = (): IndicatorConfig[] => useStore.getState().layout.indicators;
  const add = (type: IndicatorType): void => setIndicators([...current(), createIndicator(type)]);
  const change = (next: IndicatorConfig): void => setIndicators(current().map((c) => (c.id === next.id ? next : c)));
  const remove = (id: string): void => setIndicators(current().filter((c) => c.id !== id));

  return (
    <div className="ind-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ind-dialog" role="dialog" aria-modal="true" aria-labelledby="ind-dialog-title">
        <header className="ind-header">
          <h2 id="ind-dialog-title" className="ind-title">Indicators</h2>
          <button type="button" className="ind-icon-btn ind-close" title="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5Z" />
            </svg>
          </button>
        </header>
        <div className="ind-body">
          <section className="ind-col ind-available">
            <input
              ref={searchRef}
              className="ind-input ind-search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const first = available[0];
                if (e.key === "Enter" && first) add(first);
              }}
            />
            <ul className="ind-list">
              {available.map((t) => {
                const d = INDICATOR_DEFS[t];
                return (
                  <li key={t}>
                    <button type="button" className="ind-add" onClick={() => add(t)} title={`Add ${d.name}`}>
                      <span className="ind-swatch" style={{ background: d.colors.main }} />
                      <span className="ind-add-name">{d.name}</span>
                      <span className="ind-tag">{d.overlay ? "overlay" : "pane"}</span>
                    </button>
                  </li>
                );
              })}
              {available.length === 0 && <li className="ind-empty">No matches</li>}
            </ul>
          </section>
          <section className="ind-col ind-current">
            <div className="ind-section-title">On chart ({indicators.length})</div>
            {indicators.length === 0 ? (
              <div className="ind-empty">No indicators yet. Click one on the left to add it.</div>
            ) : (
              <ul className="ind-list">
                {indicators.map((cfg) =>
                  cfg.type in INDICATOR_DEFS ? (
                    <IndicatorRow key={cfg.id} cfg={cfg} onChange={change} onRemove={() => remove(cfg.id)} />
                  ) : null,
                )}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
