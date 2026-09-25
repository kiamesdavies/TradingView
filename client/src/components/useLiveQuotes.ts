import { useEffect } from "react";
import type { Quote, Symbol } from "@eodview/shared";
import { api } from "../api/http";
import { wsClient } from "../api/ws";
import { useStore } from "../state/store";
import { sessionDayStart, sessionTimeZone } from "../chart/candles";

/**
 * Snapshot refresh interval. The ws hub only sends snapshots on subscribe (and polls non-streamable symbols), so
 * without this a long-lived tab would keep yesterday's prevClose/volume for streamable symbols after a day rollover.
 */
const REFRESH_MS = 5 * 60_000;

/** Merge a /api/quotes snapshot into the store without regressing a fresher streamed price. */
export function mergeSnapshot(cur: Quote | undefined, q: Quote): Quote | null {
  if (!cur || cur.time <= q.time) return q;
  const tz = sessionTimeZone(q.symbol);
  // Snapshot from an earlier session than the streamed price (e.g. cached across midnight): nothing to adopt.
  if (sessionDayStart(cur.time, tz) !== sessionDayStart(q.time, tz)) return null;
  // Streamed price is newer: keep it, adopt the snapshot's reference data (prevClose, day volume).
  const prevClose = Number.isFinite(q.prevClose) && q.prevClose !== 0 ? q.prevClose : cur.prevClose;
  const change = cur.price - prevClose;
  const ok = Number.isFinite(prevClose) && prevClose !== 0;
  return {
    ...cur,
    prevClose,
    change: ok ? change : Number.NaN,
    changePct: ok ? (change / prevClose) * 100 : Number.NaN,
    volume: Math.max(cur.volume, q.volume),
  };
}

/**
 * Keep store `quotes` live for these symbols: fetch a snapshot from /api/quotes (again every few minutes),
 * and hold a ws subscription (ticks/quotes are folded into the store by useWsWiring).
 * Re-subscribes only when the symbol set changes.
 */
export function useLiveQuotes(symbols: readonly Symbol[]): void {
  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    const release = wsClient.subscribe(list);
    let cancelled = false;
    const refresh = () => {
      api
        .get<Quote[]>(`/quotes?symbols=${encodeURIComponent(key)}`)
        .then((quotes) => {
          if (cancelled || !Array.isArray(quotes)) return;
          const { setQuote, quotes: current } = useStore.getState();
          for (const q of quotes) {
            if (!q || typeof q.price !== "number") continue;
            const next = mergeSnapshot(current[q.symbol], q);
            if (next) setQuote(next);
          }
        })
        .catch(() => {
          // Quotes are best-effort (no key / network); the ws feed may still fill them in.
        });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      release();
    };
  }, [key]);
}
