import { useEffect, useRef, type RefObject } from "react";
import { useStore } from "../state/store";

/**
 * While `active`, Esc calls `onEsc` before the app's global Esc handler (capture phase + preventDefault, which the
 * global handler respects), and a mousedown outside `ref` calls `onOutside` (defaults to onEsc).
 */
export function usePopoverDismiss(active: boolean, ref: RefObject<HTMLElement | null>, onEsc: () => void, onOutside?: () => void): void {
  const cb = useRef({ onEsc, onOutside });
  cb.current = { onEsc, onOutside };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current.onEsc();
    };
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el || !(e.target instanceof Node) || el.contains(e.target)) return;
      // the popover's own toggle button handles its click itself
      if (e.target instanceof Element && e.target.closest("[data-scr-toggle]")) return;
      (cb.current.onOutside ?? cb.current.onEsc)();
    };
    window.addEventListener("keydown", onKey, true);
    // defer so the click that opened the popover doesn't close it
    const t = setTimeout(() => window.addEventListener("mousedown", onDown, true), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [active, ref]);
}

/** Open a symbol on the chart page. */
export function openOnChart(symbol: string): void {
  if (!symbol) return;
  const s = useStore.getState();
  s.setSymbol(symbol);
  s.setUi({ page: "chart" });
}
