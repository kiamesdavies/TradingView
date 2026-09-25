import type { ChartType } from "@eodview/shared";
import { useStore } from "../state/store";
import { CHART_TYPES } from "./format";

export function ChartTypeMenu() {
  const chartType = useStore((s) => s.layout.chartType);
  const setChartType = useStore((s) => s.setChartType);
  return (
    <label className="select-wrap" title="Chart type">
      <select
        className="tb-select"
        value={chartType}
        onChange={(e) => setChartType(e.target.value as ChartType)}
        aria-label="Chart type"
      >
        {CHART_TYPES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
