// Screener page state (local zustand store). Query state is persisted to localStorage; data is session-only.
import { create } from "zustand";
import type { ScreenerFilterValue, ScreenerMeta, ScreenerPreset, ScreenerResponse, UniverseStatus } from "@eodview/shared";
import {
  applyPreset, DEFAULT_STATE, pruneUnknownFilters, removeFilter, resetFilters, sanitizeState, setFilter, setMarket, setPage, setPageSize,
  setTickers, setUniverse, setView, toggleSort, type FilterTab, type PageSize, type ScreenerState, type ScreenerUniverse, type SortDir,
} from "./queryState";

const KEY = "eodview.screener.v1";

function load(): ScreenerState {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeState(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeState(null);
  }
}

export interface ScreenerData {
  meta: ScreenerMeta | null;
  /** v3: the market the loaded `meta` was requested for (filter availability is per market). */
  metaMarket: string | null;
  metaError: string | null;
  presets: ScreenerPreset[];
  result: (ScreenerResponse & { offset: number }) | null;
  loading: boolean;
  error: string | null;
  noKey: boolean;
}

interface Actions {
  q: ScreenerState;
  setFilter(id: string, v: ScreenerFilterValue | null): void;
  removeFilter(id: string): void;
  reset(): void;
  setUniverse(u: ScreenerUniverse): void;
  setMarket(m: string): void;
  setTickers(t: string): void;
  setView(v: string): void;
  toggleSort(column: string, firstDir?: SortDir): void;
  setPage(p: number): void;
  setPageSize(n: PageSize): void;
  setTab(t: FilterTab): void;
  toggleFilters(): void;
  applyPreset(p: ScreenerPreset): void;
  setPresetId(id: string | null): void;
  setData(patch: Partial<ScreenerData>): void;
  setUniverseStatus(u: UniverseStatus): void;
}

export type ScreenerStore = ScreenerData & Actions;

export const useScreener = create<ScreenerStore>((set) => {
  const upd = (fn: (q: ScreenerState) => ScreenerState) => set((s) => ({ q: fn(s.q) }));
  return {
    q: typeof localStorage !== "undefined" ? load() : { ...DEFAULT_STATE },
    meta: null,
    metaMarket: null,
    metaError: null,
    presets: [],
    result: null,
    loading: false,
    error: null,
    noKey: false,

    setFilter: (id, v) => upd((q) => setFilter(q, id, v)),
    removeFilter: (id) => upd((q) => removeFilter(q, id)),
    reset: () => upd(resetFilters),
    setUniverse: (u) => upd((q) => setUniverse(q, u)),
    setMarket: (m) => upd((q) => setMarket(q, m)),
    setTickers: (t) => upd((q) => setTickers(q, t)),
    setView: (v) => upd((q) => setView(q, v)),
    toggleSort: (c, d) => upd((q) => toggleSort(q, c, d)),
    setPage: (p) => set((s) => ({ q: setPage(s.q, p, s.result?.total) })),
    setPageSize: (n) => upd((q) => setPageSize(q, n)),
    setTab: (tab) => upd((q) => ({ ...q, tab, filtersOpen: true })),
    toggleFilters: () => upd((q) => ({ ...q, filtersOpen: !q.filtersOpen })),
    applyPreset: (p) => upd((q) => applyPreset(q, p)),
    setPresetId: (presetId) => upd((q) => ({ ...q, presetId })),
    setData: (patch) =>
      set((s) => {
        const next: Partial<ScreenerStore> = { ...patch };
        if (patch.meta) next.q = pruneUnknownFilters(s.q, patch.meta.filters);
        return next;
      }),
    setUniverseStatus: (u) => set((s) => (s.meta ? { meta: { ...s.meta, universe: u } } : {})),
  };
});

// persist query state (not data) on every change
let lastSaved = "";
useScreener.subscribe((s) => {
  const text = JSON.stringify(s.q);
  if (text === lastSaved) return;
  lastSaved = text;
  try {
    localStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable (private mode / quota) — state stays in memory */
  }
});
