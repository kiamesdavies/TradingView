import { useEffect } from "react";
import { useStore } from "../state/store";
import { closeAllDialogs, useShell } from "./shellStore";

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Esc closes dialogs; typing a letter/digit anywhere outside an input opens symbol search seeded with it. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === "Escape") {
        if (closeAllDialogs()) e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || !/^[a-z0-9]$/i.test(e.key)) return;
      if (isEditableTarget(e.target)) return;
      const { ui } = useStore.getState();
      if (ui.searchOpen || ui.indicatorsOpen || ui.settingsOpen) return;
      e.preventDefault();
      useShell.getState().openSearch({ seed: e.key.toUpperCase() });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
