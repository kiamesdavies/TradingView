// Loads drawings for the active symbol and saves edits (debounced PUT of the whole set).
import { useEffect } from "react";
import type { Drawing, Symbol } from "@eodview/shared";
import { api } from "../api/http";
import { useDrawingStore } from "./drawingStore";
import { isValidDrawing } from "./geometry";

export const SAVE_DEBOUNCE_MS = 500;

const path = (symbol: Symbol) => `/drawings?symbol=${encodeURIComponent(symbol)}`;

interface PendingSave { symbol: Symbol; drawings: Drawing[]; timer: ReturnType<typeof setTimeout> }
let pendingSave: PendingSave | null = null;

function send(symbol: Symbol, drawings: Drawing[]): void {
  api.put<Drawing[]>(path(symbol), drawings).catch((err: unknown) => {
    console.warn(`[drawings] save failed for ${symbol}`, err);
  });
}

/** Send any queued save immediately (symbol switch, unmount, page unload). */
export function flushDrawingSave(): void {
  const p = pendingSave;
  if (!p) return;
  pendingSave = null;
  clearTimeout(p.timer);
  send(p.symbol, p.drawings);
}

function scheduleSave(symbol: Symbol, drawings: Drawing[]): void {
  if (pendingSave && pendingSave.symbol !== symbol) flushDrawingSave();
  if (pendingSave) clearTimeout(pendingSave.timer);
  const timer = setTimeout(() => {
    if (pendingSave?.timer === timer) flushDrawingSave();
  }, SAVE_DEBOUNCE_MS);
  pendingSave = { symbol, drawings, timer };
}

/** Keeps useDrawingStore in sync with the server for `symbol`. */
export function useDrawingPersistence(symbol: Symbol): void {
  // save on every user edit (rev bump) once the server set is known
  useEffect(() => {
    const unsub = useDrawingStore.subscribe((s, prev) => {
      if (s.rev === prev.rev || !s.loaded || !s.symbol) return;
      scheduleSave(s.symbol, s.drawings);
    });
    const onUnload = () => flushDrawingSave();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      unsub();
      window.removeEventListener("beforeunload", onUnload);
      flushDrawingSave();
    };
  }, []);

  // load on symbol change; stale responses are ignored
  useEffect(() => {
    let cancelled = false;
    flushDrawingSave();
    const store = useDrawingStore.getState();
    store.reset(symbol, [], false);
    const revAtStart = useDrawingStore.getState().rev;

    api.get<Drawing[] | null>(path(symbol))
      .then((list) => {
        if (cancelled) return;
        const server = (Array.isArray(list) ? list : []).filter(isValidDrawing);
        const s = useDrawingStore.getState();
        // keep anything drawn while the request was in flight
        const local = s.rev !== revAtStart ? s.drawings.filter((d) => !server.some((x) => x.id === d.id)) : [];
        s.reset(symbol, [...server, ...local], true);
        if (local.length > 0) useDrawingStore.setState((st) => ({ rev: st.rev + 1 }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // stay unloaded: saving now could overwrite the server copy with a partial set
        console.warn(`[drawings] load failed for ${symbol}`, err);
      });

    return () => { cancelled = true; };
  }, [symbol]);
}
