import { TIMEFRAMES } from "@eodview/shared";
import { useStore } from "../state/store";
import { TF_LABELS } from "./format";

export function TimeframeBar() {
  const tf = useStore((s) => s.layout.tf);
  const setTimeframe = useStore((s) => s.setTimeframe);
  return (
    <div className="tf-bar" role="group" aria-label="Timeframe">
      {TIMEFRAMES.map((t) => (
        <button
          key={t}
          type="button"
          className={`tb-btn tf-btn${t === tf ? " active" : ""}`}
          aria-pressed={t === tf}
          onClick={() => t !== tf && setTimeframe(t)}
        >
          {TF_LABELS[t]}
        </button>
      ))}
    </div>
  );
}
