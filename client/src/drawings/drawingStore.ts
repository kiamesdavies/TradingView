// Drawings state shared by DrawingLayer (chart interaction) and DrawingToolbar.
// Kept separate from the app store because it is owned by the drawings module.
import { create } from "zustand";
import type { Drawing, Symbol } from "@eodview/shared";

export interface DrawingState {
  /** Symbol the current `drawings` belong to (null before the first load). */
  symbol: Symbol | null;
  drawings: Drawing[];
  /** True once the server set for `symbol` has been loaded; edits before that are not saved. */
  loaded: boolean;
  selectedId: string | null;
  /** Incremented on every user edit; the persistence effect saves when it changes. */
  rev: number;

  /** Replace everything after a load (does not trigger a save). */
  reset(symbol: Symbol, drawings: Drawing[], loaded: boolean): void;
  select(id: string | null): void;
  add(d: Drawing): void;
  update(d: Drawing): void;
  remove(id: string): void;
  clear(): void;
  recolor(id: string, color: string): void;
}

export const useDrawingStore = create<DrawingState>((set) => ({
  symbol: null,
  drawings: [],
  loaded: false,
  selectedId: null,
  rev: 0,

  reset: (symbol, drawings, loaded) => set({ symbol, drawings, loaded, selectedId: null }),
  select: (selectedId) => set({ selectedId }),
  add: (d) => set((s) => ({ drawings: [...s.drawings, d], selectedId: d.id, rev: s.rev + 1 })),
  update: (d) => set((s) => ({ drawings: s.drawings.map((x) => (x.id === d.id ? d : x)), rev: s.rev + 1 })),
  remove: (id) =>
    set((s) => ({
      drawings: s.drawings.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      rev: s.rev + 1,
    })),
  clear: () => set((s) => ({ drawings: [], selectedId: null, rev: s.rev + 1 })),
  recolor: (id, color) =>
    set((s) => ({ drawings: s.drawings.map((x) => (x.id === id ? { ...x, color } : x)), rev: s.rev + 1 })),
}));

export function newDrawingId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
