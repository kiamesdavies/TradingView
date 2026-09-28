// Boot sequence + layout persistence: load everything once, then debounce-save the layout on change.
import { useEffect } from "react";
import type { Alert, AlertEvent, Layout, Watchlist } from "@eodview/shared";
import { api } from "../api/http";
import { DEFAULT_LAYOUT, useStore } from "../state/store";
import { loadAdminToken } from "./adminToken";
import { configApi } from "./configApi";
import { normalizeLayout } from "./format";
import { useShell } from "./shellStore";

const SAVE_DEBOUNCE_MS = 800;
const NO_KEY_NOTICE =
  "No EODHD API key is configured, so charts, quotes and live data are unavailable. " +
  "Paste your key below (find it at eodhd.com → Settings), or set EODHD_API_KEY / run `bun run server/src/cli.ts set-key <KEY>` on the server.";

export async function refreshAlerts(): Promise<void> {
  const [alerts, history] = await Promise.all([
    api.get<Alert[]>("/alerts"),
    api.get<AlertEvent[]>("/alerts/history?limit=100"),
  ]);
  const s = useStore.getState();
  s.setAlerts(alerts);
  useStore.setState({ alertHistory: history });
}

async function boot(signal: { cancelled: boolean }): Promise<void> {
  const st = useStore.getState();
  const shell = useShell.getState();

  const [layoutRes, watchlistsRes, alertsRes, historyRes, configRes] = await Promise.allSettled([
    api.get<Layout | null>("/layout"),
    api.get<Watchlist[]>("/watchlists"),
    api.get<Alert[]>("/alerts"),
    api.get<AlertEvent[]>("/alerts/history?limit=100"),
    configApi.get(loadAdminToken() ?? undefined),
  ]);
  if (signal.cancelled) return;

  const layout = normalizeLayout(layoutRes.status === "fulfilled" ? layoutRes.value : null, DEFAULT_LAYOUT);
  const watchlists = watchlistsRes.status === "fulfilled" ? watchlistsRes.value : [];
  if (!layout.activeWatchlistId || !watchlists.some((w) => w.id === layout.activeWatchlistId)) {
    if (watchlists[0]) layout.activeWatchlistId = watchlists[0].id;
    else delete layout.activeWatchlistId;
  }
  useStore.setState({ layout, layoutLoaded: true });
  st.setWatchlists(watchlists);
  if (alertsRes.status === "fulfilled") st.setAlerts(alertsRes.value);
  if (historyRes.status === "fulfilled") useStore.setState({ alertHistory: historyRes.value });

  const failed = [layoutRes, watchlistsRes, alertsRes, historyRes].filter((r) => r.status === "rejected");
  if (failed.length) {
    const reason = (failed[0] as PromiseRejectedResult).reason as Error;
    shell.pushToast({ kind: "error", title: "Could not reach the EODView server", body: reason?.message });
  }

  if (configRes.status === "fulfilled") {
    shell.setConfig(configRes.value);
    if (!configRes.value.hasKey) shell.openSettings(NO_KEY_NOTICE);
  } else {
    // 403 (non-localhost without admin token) is expected; fall back to /api/health for hasKey.
    try {
      const health = await api.get<{ ok: boolean; hasKey: boolean }>("/health");
      if (!signal.cancelled && !health.hasKey) shell.openSettings(NO_KEY_NOTICE);
    } catch {
      // server unreachable; already toasted above
    }
  }
}

function saveLayoutNow(layout: Layout, keepalive = false): Promise<unknown> {
  if (keepalive) {
    return fetch("/api/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(layout),
      keepalive: true,
    }).catch(() => undefined);
  }
  return api.put<Layout>("/layout", layout);
}

/** Mount once at the app root. */
export function useBoot(): void {
  useEffect(() => {
    const signal = { cancelled: false };
    boot(signal).catch((e: unknown) => {
      console.error("[boot]", e);
      if (!signal.cancelled) useStore.setState({ layoutLoaded: true });
    });
    return () => {
      signal.cancelled = true;
    };
  }, []);

  // Debounced PUT /api/layout after the initial load.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Layout | null = null;
    let lastErrorAt = 0;

    const flush = () => {
      timer = null;
      const layout = pending;
      pending = null;
      if (!layout) return;
      saveLayoutNow(layout).catch((e: Error) => {
        // Avoid a toast storm while the server is down.
        if (Date.now() - lastErrorAt > 60_000) {
          lastErrorAt = Date.now();
          useShell.getState().pushToast({ kind: "error", title: "Layout not saved", body: e.message });
        }
      });
    };

    const unsub = useStore.subscribe((s, prev) => {
      if (!s.layoutLoaded || !prev.layoutLoaded || s.layout === prev.layout) return;
      pending = s.layout;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    });

    const onHide = () => {
      if (!pending) return;
      if (timer) clearTimeout(timer);
      timer = null;
      const layout = pending;
      pending = null;
      void saveLayoutNow(layout, true);
    };
    window.addEventListener("pagehide", onHide);

    return () => {
      unsub();
      window.removeEventListener("pagehide", onHide);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Theme -> <html data-theme>
  const theme = useStore((s) => s.layout.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);
}
