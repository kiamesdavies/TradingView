// Global /ws wiring: upstream status, quotes, throttled tick -> quote folding, alert events.
import { useEffect } from "react";
import type { AlertEvent, Symbol } from "@eodview/shared";
import { wsClient } from "../api/ws";
import { useStore } from "../state/store";
import { applyTickToQuote, formatPrice } from "./format";
import { ensureNotificationPermission, showBrowserNotification, useShell } from "./shellStore";
import { refreshAlerts } from "./useBoot";

/** Store writes per symbol are coalesced to at most one per this interval (~4/sec). */
const TICK_FLUSH_MS = 250;

const CONDITION_TEXT: Record<AlertEvent["condition"], string> = {
  cross_up: "crossed up through",
  cross_down: "crossed down through",
  cross: "crossed",
};

export function describeAlertEvent(e: AlertEvent): string {
  return `${e.symbol} ${CONDITION_TEXT[e.condition]} ${formatPrice(e.price, e.symbol)} (last ${formatPrice(e.tickPrice, e.symbol)})`;
}

interface PendingTick { price: number; volume: number; time: number }

/** Mount once at the app root. */
export function useWsWiring(): void {
  useEffect(() => {
    const pending = new Map<Symbol, PendingTick>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      if (!pending.size) return;
      const { quotes } = useStore.getState();
      const next = { ...quotes };
      for (const [symbol, p] of pending) next[symbol] = applyTickToQuote(quotes[symbol], symbol, p.price, p.volume, p.time);
      pending.clear();
      useStore.setState({ quotes: next }); // one store write for the whole batch
    };

    const offs = [
      wsClient.onConnection((connected) => {
        useShell.getState().setServerConnected(connected);
        if (!connected) {
          useStore.getState().setUi({ upstream: "disconnected" });
          useShell.getState().setUpstreamDetail("Lost connection to the EODView server; reconnecting…");
        } else {
          useShell.getState().setUpstreamDetail(null);
          // Events may have fired while we were away.
          refreshAlerts().catch(() => undefined);
        }
      }),
      wsClient.on("status", (m) => {
        useStore.getState().setUi({ upstream: m.upstream });
        useShell.getState().setUpstreamDetail(m.detail ?? null);
      }),
      wsClient.on("quote", (m) => {
        pending.delete(m.quote.symbol); // snapshot supersedes buffered ticks
        useStore.getState().setQuote(m.quote);
      }),
      wsClient.on("tick", ({ tick }) => {
        if (!Number.isFinite(tick.price)) return;
        const p = pending.get(tick.symbol);
        if (p) {
          p.price = tick.price;
          p.volume += tick.volume || 0;
          p.time = tick.time;
        } else pending.set(tick.symbol, { price: tick.price, volume: tick.volume || 0, time: tick.time });
        if (!flushTimer) flushTimer = setTimeout(flush, TICK_FLUSH_MS);
      }),
      wsClient.on("alert", ({ event }) => {
        const store = useStore.getState();
        store.pushAlertEvent(event);
        const body = describeAlertEvent(event) + (event.note ? ` — ${event.note}` : "");
        useShell.getState().pushToast({ kind: "alert", title: `Alert: ${event.symbol}`, body, symbol: event.symbol });
        showBrowserNotification(`EODView alert: ${event.symbol}`, body, () => useStore.getState().setSymbol(event.symbol));
        // One-shot alerts deactivate server-side; repeating ones update lastTriggeredAt.
        refreshAlerts().catch(() => undefined);
      }),
    ];

    // Alerts created anywhere (e.g. chart context menu) -> ask for Notification permission once.
    const offAlerts = useStore.subscribe((s, prev) => {
      if (prev.layoutLoaded && s.alerts.length > prev.alerts.length) ensureNotificationPermission();
    });

    wsClient.connect();

    return () => {
      for (const off of offs) off();
      offAlerts();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, []);
}
