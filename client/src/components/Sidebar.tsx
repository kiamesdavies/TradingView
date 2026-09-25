import type { ChartHandle } from "../chart/types";
import { useStore } from "../state/store";
import { AlertsPanel } from "./AlertsPanel";
import { BellIcon, ListIcon } from "./icons";
import { WatchlistPanel } from "./WatchlistPanel";
import { DetailsPanel } from "../details/DetailsPanel";

export function Sidebar({ handle }: { handle: ChartHandle | null }) {
  const tab = useStore((s) => s.ui.sidebarTab);
  const activeAlerts = useStore((s) => s.alerts.filter((a) => a.active).length);
  const setUi = useStore((s) => s.setUi);
  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "watchlist"}
          className={`tab${tab === "watchlist" ? " active" : ""}`}
          onClick={() => setUi({ sidebarTab: "watchlist" })}
        >
          <ListIcon size={16} /> Watchlist
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "alerts"}
          className={`tab${tab === "alerts" ? " active" : ""}`}
          onClick={() => setUi({ sidebarTab: "alerts" })}
        >
          <BellIcon size={16} /> Alerts
          {activeAlerts > 0 && <span className="count-pill">{activeAlerts}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "details"}
          className={`tab${tab === "details" ? " active" : ""}`}
          onClick={() => setUi({ sidebarTab: "details" })}
        >
          Details
        </button>
      </div>
      {/* Both panels stay mounted so watchlist subscriptions and the alert form survive tab switches. */}
      <div className="tab-body" role="tabpanel" hidden={tab !== "watchlist"}>
        <WatchlistPanel />
      </div>
      <div className="tab-body" role="tabpanel" hidden={tab !== "alerts"}>
        <AlertsPanel handle={handle} />
      </div>
      {tab === "details" && (
        <div className="tab-body" role="tabpanel">
          <DetailsPanel />
        </div>
      )}
    </aside>
  );
}
