import { useStore } from "../state/store";
import { useShell } from "./shellStore";

const LABEL = {
  connected: "Live data connected",
  disconnected: "Live data disconnected",
  no_key: "No EODHD API key configured",
  unknown: "Connecting…",
} as const;

export function StatusDot() {
  const upstream = useStore((s) => s.ui.upstream);
  const detail = useShell((s) => s.upstreamDetail);
  const title = detail ? `${LABEL[upstream]} — ${detail}` : LABEL[upstream];
  const onClick = upstream === "no_key" ? () => useShell.getState().openSettings() : undefined;
  return (
    <button
      type="button"
      className={`status-dot status-${upstream}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className="dot" />
    </button>
  );
}
