import { useRef, useState } from "react";
import type { ScreenerPreset } from "@eodview/shared";
import { useShell } from "../components/shellStore";
import { usePopoverDismiss } from "./hooks";
import { presetQuery } from "./queryState";
import { errorMessage, screenerApi } from "./screenerApi";
import { useScreener } from "./screenerStore";

type Mode = "saveas" | "rename" | null;

function toast(kind: "success" | "error", title: string, body?: string) {
  useShell.getState().pushToast({ kind, title, body }, kind === "error" ? 6000 : 2500);
}

function NamePopover({ initial, label, onSubmit, onClose }: {
  initial: string;
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  usePopoverDismiss(true, ref, onClose);
  return (
    <form
      ref={ref}
      className="scr-popover scr-name-pop"
      onSubmit={async (e) => {
        e.preventDefault();
        const n = name.trim();
        if (!n) return setErr("Enter a name");
        setBusy(true);
        try {
          await onSubmit(n);
          onClose();
        } catch (ex) {
          setErr(errorMessage(ex));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="scr-popover-title">{label}</div>
      <input className="input input-sm" value={name} autoFocus maxLength={80} placeholder="Preset name" onChange={(e) => { setName(e.target.value); setErr(null); }} />
      {err && <div className="error-text">{err}</div>}
      <div className="scr-popover-actions">
        <span className="scr-grow" />
        <button type="button" className="btn scr-btn-sm" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary scr-btn-sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

export function PresetBar() {
  const presets = useScreener((s) => s.presets);
  const presetId = useScreener((s) => s.q.presetId);
  const setData = useScreener((s) => s.setData);
  const applyPreset = useScreener((s) => s.applyPreset);
  const setPresetId = useScreener((s) => s.setPresetId);
  const [mode, setMode] = useState<Mode>(null);
  const current = presets.find((p) => p.id === presetId) ?? null;

  const upsert = (p: ScreenerPreset) => {
    const list = useScreener.getState().presets;
    setData({ presets: list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p] });
  };

  const saveAs = async (name: string) => {
    const p = await screenerApi.createPreset(name, presetQuery(useScreener.getState().q));
    upsert(p);
    setPresetId(p.id);
    toast("success", `Saved preset “${p.name}”`);
  };
  const rename = async (name: string) => {
    if (!current) return;
    const p = await screenerApi.updatePreset({ ...current, name });
    upsert(p);
  };
  const save = async () => {
    if (!current) return;
    try {
      const p = await screenerApi.updatePreset({ ...current, query: presetQuery(useScreener.getState().q) });
      upsert(p);
      toast("success", `Updated preset “${p.name}”`);
    } catch (e) {
      toast("error", "Couldn't save preset", errorMessage(e));
    }
  };
  const remove = async () => {
    if (!current || !window.confirm(`Delete preset “${current.name}”?`)) return;
    try {
      await screenerApi.deletePreset(current.id);
      setData({ presets: useScreener.getState().presets.filter((p) => p.id !== current.id) });
      setPresetId(null);
    } catch (e) {
      toast("error", "Couldn't delete preset", errorMessage(e));
    }
  };

  return (
    <div className="scr-presets">
      <select
        className="scr-select scr-preset-select"
        value={current ? current.id : ""}
        aria-label="Preset"
        onChange={(e) => {
          const p = presets.find((x) => x.id === e.target.value);
          if (p) applyPreset(p);
          else setPresetId(null);
        }}
      >
        <option value="">{presets.length ? "My presets…" : "No saved presets"}</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <div className="scr-rel">
        {current && (
          <button type="button" className="btn scr-btn-sm" onClick={save} title="Overwrite this preset with the current filters">Save</button>
        )}
        <button type="button" data-scr-toggle className="btn scr-btn-sm" onClick={() => setMode(mode === "saveas" ? null : "saveas")}>Save as…</button>
        {current && (
          <>
            <button type="button" data-scr-toggle className="btn scr-btn-sm" onClick={() => setMode(mode === "rename" ? null : "rename")}>Rename</button>
            <button type="button" className="btn scr-btn-sm scr-danger" onClick={remove}>Delete</button>
          </>
        )}
        {mode === "saveas" && <NamePopover initial="" label="Save current filters as" onSubmit={saveAs} onClose={() => setMode(null)} />}
        {mode === "rename" && current && <NamePopover initial={current.name} label="Rename preset" onSubmit={rename} onClose={() => setMode(null)} />}
      </div>
    </div>
  );
}
