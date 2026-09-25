import { useEffect } from "react";
import { useStore } from "../state/store";

/** Keeps ui.page in sync with location.hash (#/chart, #/screener) so pages are linkable and Back works. */
export function usePageRoute(): void {
  const page = useStore((s) => s.ui.page);

  useEffect(() => {
    const onHash = () => {
      const next = location.hash.startsWith("#/screener") ? "screener" : "chart";
      if (useStore.getState().ui.page !== next) useStore.getState().setUi({ page: next });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const want = page === "screener" ? "#/screener" : "#/chart";
    if (!location.hash.startsWith(want)) history.pushState(null, "", want);
  }, [page]);
}
