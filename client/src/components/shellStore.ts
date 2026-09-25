// App-shell-only state (not part of the shared store contract): config, toasts, search hand-off, sidebar.
import { create } from "zustand";
import type { ConfigView, Symbol, SymbolInfo } from "@eodview/shared";
import { useStore } from "../state/store";

export type ToastKind = "info" | "success" | "error" | "alert";
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Optional click action (e.g. jump to the alert's symbol). */
  symbol?: Symbol;
}

/** Called instead of `setSymbol` when the search modal was opened for picking (e.g. watchlist "add"). */
export type SymbolPickHandler = (info: SymbolInfo) => void;

interface ShellState {
  config: ConfigView | null;
  /** Shown at the top of Settings when it was auto-opened because no key is configured. */
  settingsNotice: string | null;
  serverConnected: boolean;
  upstreamDetail: string | null;
  sidebarCollapsed: boolean;
  toasts: Toast[];
  searchSeed: string;
  searchPick: SymbolPickHandler | null;
  searchTitle: string | null;

  setConfig(c: ConfigView | null): void;
  openSettings(notice?: string | null): void;
  setServerConnected(v: boolean): void;
  setUpstreamDetail(d: string | null): void;
  toggleSidebar(): void;
  pushToast(t: Omit<Toast, "id">, ttlMs?: number): number;
  dismissToast(id: number): void;
  openSearch(opts?: { seed?: string; onPick?: SymbolPickHandler; title?: string }): void;
  closeSearch(): void;
}

const SIDEBAR_KEY = "eodview.sidebarCollapsed";
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useShell = create<ShellState>((set, get) => ({
  config: null,
  settingsNotice: null,
  serverConnected: false,
  upstreamDetail: null,
  sidebarCollapsed: typeof localStorage !== "undefined" ? readCollapsed() : false,
  toasts: [],
  searchSeed: "",
  searchPick: null,
  searchTitle: null,

  setConfig: (config) => set({ config }),
  openSettings: (notice = null) => {
    set({ settingsNotice: notice });
    useStore.getState().setUi({ settingsOpen: true });
  },
  setServerConnected: (serverConnected) => set({ serverConnected }),
  setUpstreamDetail: (upstreamDetail) => set({ upstreamDetail }),
  toggleSidebar: () => {
    const v = !get().sidebarCollapsed;
    try {
      localStorage.setItem(SIDEBAR_KEY, v ? "1" : "0");
    } catch {
      // storage unavailable; state still toggles for this session
    }
    set({ sidebarCollapsed: v });
  },
  pushToast: (t, ttlMs = t.kind === "alert" ? 12_000 : t.kind === "error" ? 8_000 : 5_000) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-6) }));
    if (ttlMs > 0) toastTimers.set(id, setTimeout(() => get().dismissToast(id), ttlMs));
    return id;
  },
  dismissToast: (id) => {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  openSearch: (opts = {}) => {
    set({ searchSeed: opts.seed ?? "", searchPick: opts.onPick ?? null, searchTitle: opts.title ?? null });
    useStore.getState().setUi({ searchOpen: true });
  },
  closeSearch: () => {
    set({ searchSeed: "", searchPick: null, searchTitle: null });
    useStore.getState().setUi({ searchOpen: false });
  },
}));

/** Close every modal dialog (Esc). Returns true if something was open. */
export function closeAllDialogs(): boolean {
  const { ui, setUi } = useStore.getState();
  const any = ui.searchOpen || ui.indicatorsOpen || ui.settingsOpen;
  if (ui.searchOpen) useShell.getState().closeSearch();
  if (ui.indicatorsOpen || ui.settingsOpen) setUi({ indicatorsOpen: false, settingsOpen: false });
  return any;
}

// ---------- browser notifications ----------

let permissionAsked = false;

/** Ask for Notification permission once (call from a user gesture where possible). */
export function ensureNotificationPermission(): void {
  if (permissionAsked || typeof Notification === "undefined") return;
  permissionAsked = true;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => undefined);
  }
}

export function showBrowserNotification(title: string, body: string, onClick?: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, tag: `eodview-${title}`, silent: false });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    // Some browsers (Android Chrome) only allow notifications via a service worker.
  }
}
