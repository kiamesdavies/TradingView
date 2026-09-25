// Data hooks for the details panel: overview (polled) and news (on demand). Responses for an old symbol
// or an older request are dropped via a per-hook sequence number.
import { useCallback, useEffect, useRef, useState } from "react";
import type { NewsItem, Symbol, SymbolOverview } from "@eodview/shared";
import { api, ApiRequestError } from "../api/http";
import { sortNews } from "./format";

export const OVERVIEW_REFRESH_MS = 60_000;

export type LoadErrorKind = "no_key" | "not_found" | "plan" | "other";

export interface LoadError {
  kind: LoadErrorKind;
  message: string;
}

export function classifyError(e: unknown): LoadError {
  if (e instanceof ApiRequestError) {
    if (e.status === 503 && /key/i.test(e.message)) return { kind: "no_key", message: e.message };
    if (e.status === 404) return { kind: "not_found", message: e.message };
    if (e.status === 402) return { kind: "plan", message: e.message };
    return { kind: "other", message: e.message || `Request failed (${e.status})` };
  }
  return { kind: "other", message: e instanceof Error ? e.message : "Request failed" };
}

interface OverviewState {
  symbol: Symbol;
  data: SymbolOverview | null;
  error: LoadError | null;
  loading: boolean;
}

export function useOverview(symbol: Symbol): OverviewState & { reload(): void } {
  const [st, setSt] = useState<OverviewState>({ symbol, data: null, error: null, loading: true });
  const seq = useRef(0);

  const load = useCallback(
    (background: boolean) => {
      const id = ++seq.current;
      if (!background) setSt((s) => ({ symbol, data: s.symbol === symbol ? s.data : null, error: null, loading: true }));
      api
        .get<SymbolOverview>(`/symbols/${encodeURIComponent(symbol)}/overview`)
        .then((data) => {
          if (id !== seq.current) return;
          setSt({ symbol, data: data && typeof data === "object" && data.profile ? data : null, error: null, loading: false });
        })
        .catch((e: unknown) => {
          if (id !== seq.current) return;
          // A failed background refresh keeps the data we have.
          setSt((s) => ({ symbol, data: s.symbol === symbol ? s.data : null, error: classifyError(e), loading: false }));
        });
    },
    [symbol],
  );

  useEffect(() => {
    load(false);
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) load(true);
    }, OVERVIEW_REFRESH_MS);
    return () => {
      clearInterval(timer);
      seq.current++; // drop anything in flight for this symbol
    };
  }, [load]);

  const reload = useCallback(() => load(false), [load]);
  // While the state still belongs to the previous symbol, present it as loading.
  if (st.symbol !== symbol) return { symbol, data: null, error: null, loading: true, reload };
  return { ...st, reload };
}

interface NewsState {
  symbol: Symbol;
  items: NewsItem[] | null;
  error: LoadError | null;
  loading: boolean;
}

export function useNews(symbol: Symbol, enabled: boolean, limit = 30): NewsState & { reload(): void } {
  const [st, setSt] = useState<NewsState>({ symbol, items: null, error: null, loading: false });
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setSt({ symbol, items: null, error: null, loading: true });
    api
      .get<NewsItem[]>(`/symbols/${encodeURIComponent(symbol)}/news?limit=${limit}`)
      .then((items) => {
        if (id !== seq.current) return;
        setSt({ symbol, items: Array.isArray(items) ? sortNews(items) : [], error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (id !== seq.current) return;
        setSt({ symbol, items: null, error: classifyError(e), loading: false });
      });
  }, [symbol, limit]);

  useEffect(() => {
    if (!enabled) return;
    load();
    return () => {
      seq.current++;
    };
  }, [enabled, load]);

  if (st.symbol !== symbol) return { symbol, items: null, error: null, loading: enabled, reload: load };
  return { ...st, reload: load };
}
