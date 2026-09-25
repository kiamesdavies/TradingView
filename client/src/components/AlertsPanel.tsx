import { useEffect, useState, type FormEvent } from "react";
import type { Alert, AlertCondition } from "@eodview/shared";
import { api } from "../api/http";
import type { ChartHandle } from "../chart/types";
import { useStore } from "../state/store";
import { formatAgo, formatEventTime, formatPrice, parsePrice, priceDecimals } from "./format";
import { TrashIcon } from "./icons";
import { ensureNotificationPermission, useShell } from "./shellStore";
import { refreshAlerts } from "./useBoot";

const CONDITIONS: { value: AlertCondition; label: string; short: string }[] = [
  { value: "cross", label: "Crossing", short: "↕" },
  { value: "cross_up", label: "Crossing up", short: "↑" },
  { value: "cross_down", label: "Crossing down", short: "↓" },
];
const CONDITION_LABEL: Record<AlertCondition, string> = { cross: "crosses", cross_up: "crosses up", cross_down: "crosses down" };

function toastError(title: string, e: unknown) {
  useShell.getState().pushToast({ kind: "error", title, body: e instanceof Error ? e.message : String(e) });
}

function lastPriceFor(symbol: string, handle: ChartHandle | null, chartSymbol: string): number | undefined {
  const q = useStore.getState().quotes[symbol];
  if (q && Number.isFinite(q.price)) return q.price;
  if (handle && symbol === chartSymbol) {
    try {
      const bars = handle.getBars();
      const last = bars[bars.length - 1];
      if (last) return last.close;
    } catch {
      // handle may be stale during chart re-creation
    }
  }
  return undefined;
}

function priceText(price: number | undefined, symbol: string): string {
  if (price === undefined) return "";
  return price.toFixed(priceDecimals(price, symbol));
}

export function AlertsPanel({ handle }: { handle: ChartHandle | null }) {
  const chartSymbol = useStore((s) => s.layout.symbol);
  const alerts = useStore((s) => s.alerts);
  const history = useStore((s) => s.alertHistory);
  const livePrice = useStore((s) => s.quotes[chartSymbol]?.price);

  const [symbol, setSymbol] = useState(chartSymbol);
  const [symbolTouched, setSymbolTouched] = useState(false);
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [condition, setCondition] = useState<AlertCondition>("cross");
  const [repeat, setRepeat] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [, setNow] = useState(0);

  // Symbol follows the chart until the user edits it.
  useEffect(() => {
    if (!symbolTouched) setSymbol(chartSymbol);
  }, [chartSymbol, symbolTouched]);

  // Price follows the last price until the user edits it.
  useEffect(() => {
    if (priceTouched) return;
    setPrice(priceText(lastPriceFor(symbol, handle, chartSymbol), symbol));
  }, [symbol, handle, chartSymbol, livePrice, priceTouched]);

  // Re-render periodically so "x ago" labels stay fresh.
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const resetForm = () => {
    setSymbolTouched(false);
    setPriceTouched(false);
    setNote("");
    setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    ensureNotificationPermission(); // inside the user gesture
    const sym = symbol.trim().toUpperCase();
    const p = parsePrice(price);
    if (!sym) return setFormError("Enter a symbol.");
    if (p === null) return setFormError("Enter a positive price.");
    setBusy(true);
    setFormError(null);
    try {
      await useStore.getState().createAlert({ symbol: sym, price: p, condition, repeat, ...(note.trim() ? { note: note.trim() } : {}) });
      useShell.getState().pushToast({ kind: "success", title: "Alert created", body: `${sym} ${CONDITION_LABEL[condition]} ${formatPrice(p, sym)}` });
      resetForm();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (a: Alert) => {
    const { alerts: cur, setAlerts } = useStore.getState();
    setAlerts(cur.map((x) => (x.id === a.id ? { ...x, active: !a.active } : x)));
    try {
      const saved = await api.put<Alert>(`/alerts/${encodeURIComponent(a.id)}`, { active: !a.active });
      setAlerts(useStore.getState().alerts.map((x) => (x.id === saved.id ? saved : x)));
    } catch (err) {
      setAlerts(useStore.getState().alerts.map((x) => (x.id === a.id ? a : x)));
      toastError("Could not update alert", err);
    }
  };

  const remove = async (a: Alert) => {
    const { alerts: cur, setAlerts } = useStore.getState();
    setAlerts(cur.filter((x) => x.id !== a.id));
    try {
      await api.del<{ ok: true }>(`/alerts/${encodeURIComponent(a.id)}`);
    } catch (err) {
      toastError("Could not delete alert", err);
      refreshAlerts().catch(() => undefined);
    }
  };

  const sorted = [...alerts].sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);

  return (
    <div className="panel alerts-panel">
      <form className="alert-form" onSubmit={submit}>
        <div className="form-row">
          <label className="field grow">
            <span>Symbol</span>
            <input
              className="input input-sm"
              value={symbol}
              spellCheck={false}
              onChange={(e) => {
                setSymbol(e.target.value);
                setSymbolTouched(true);
              }}
            />
          </label>
          <label className="field grow">
            <span>Price</span>
            <input
              className="input input-sm num"
              inputMode="decimal"
              value={price}
              placeholder="0.00"
              onChange={(e) => {
                setPrice(e.target.value);
                setPriceTouched(true);
              }}
            />
          </label>
        </div>
        <div className="form-row">
          <label className="field grow">
            <span>Condition</span>
            <select className="input input-sm" value={condition} onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            <span>Repeat</span>
          </label>
        </div>
        <label className="field">
          <span>Note</span>
          <input className="input input-sm" value={note} maxLength={200} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />
        </label>
        {formError && <div className="error-text">{formError}</div>}
        <div className="form-row end">
          {(symbolTouched || priceTouched) && (
            <button type="button" className="btn btn-ghost" onClick={resetForm}>Reset</button>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create alert"}
          </button>
        </div>
      </form>

      <div className="section-title">Alerts <span className="muted">({alerts.length})</span></div>
      <ul className="alert-list">
        {sorted.length === 0 && <li className="empty small">No alerts. Create one above or right-click the chart.</li>}
        {sorted.map((a) => (
          <li key={a.id} className={`alert-item${a.active ? "" : " inactive"}`}>
            <label className="switch" title={a.active ? "Active — click to pause" : "Paused — click to activate"}>
              <input type="checkbox" checked={a.active} onChange={() => toggle(a)} aria-label="Active" />
              <span className="switch-track" />
            </label>
            <button type="button" className="alert-main" onClick={() => useStore.getState().setSymbol(a.symbol)} title="Show on chart">
              <span className="alert-line">
                <span className="alert-sym">{a.symbol}</span>
                <span className="alert-cond">{CONDITIONS.find((c) => c.value === a.condition)?.short}</span>
                <span className="alert-price">{formatPrice(a.price, a.symbol)}</span>
                {a.repeat && <span className="badge badge-recent">repeat</span>}
              </span>
              <span className="alert-sub">
                {a.note ? <span className="alert-note">{a.note}</span> : null}
                {a.lastTriggeredAt ? <span className="muted">triggered {formatAgo(a.lastTriggeredAt)}</span> : null}
              </span>
            </button>
            <button type="button" className="icon-btn danger" onClick={() => remove(a)} title="Delete alert" aria-label="Delete alert">
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>

      <div className="section-title">History <span className="muted">({history.length})</span></div>
      <ul className="history-list">
        {history.length === 0 && <li className="empty small">Triggered alerts will appear here.</li>}
        {history.map((e) => (
          <li key={e.id} className="history-item" onClick={() => useStore.getState().setSymbol(e.symbol)} title={new Date(e.at * 1000).toLocaleString()}>
            <span className="history-time">{formatEventTime(e.at)}</span>
            <span className="history-sym">{e.symbol}</span>
            <span className="history-desc">
              {CONDITIONS.find((c) => c.value === e.condition)?.short} {formatPrice(e.price, e.symbol)}
              <span className="muted"> @ {formatPrice(e.tickPrice, e.symbol)}</span>
            </span>
            {e.note && <span className="history-note">{e.note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
