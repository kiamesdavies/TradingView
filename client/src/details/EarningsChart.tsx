// TradingView-style earnings chart: EPS dots (hollow estimate, filled actual) or revenue bars, y axis on the right.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { EarningsPoint, RevenuePoint } from "@eodview/shared";
import { columnAt, epsChartGeometry, revenueChartGeometry, surprisePct, type Column } from "./earningsGeometry";
import { formatCompact, formatDate, formatPctValue, quarterLabel } from "./format";

const HEIGHT = 150;
const DOT_R = 4.5;
const TIP_W = 168;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const fmtEps = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(2).replace(/^-/, "−"));

interface Props {
  mode: "eps" | "revenue";
  earnings: EarningsPoint[];
  revenue: RevenuePoint[];
  currency?: string;
}

export function EarningsChart({ mode, earnings, revenue, currency }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [mode]);

  const box = { width: Math.max(120, width), height: HEIGHT };
  const eps = mode === "eps" ? epsChartGeometry(earnings, box) : null;
  const rev = mode === "revenue" ? revenueChartGeometry(revenue, box) : null;
  const geo = eps ?? rev;
  const columns: Column[] = geo?.columns ?? [];

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(columnAt(columns, e.clientX - r.left));
  };

  const hoverCol = hover !== null ? columns[hover] : undefined;
  let tip: React.ReactNode = null;
  if (hoverCol && hover !== null) {
    if (mode === "eps") {
      const p = earnings[hover];
      const s = p.upcoming ? null : surprisePct(p);
      tip = (
        <>
          <div className="dtl-tip-title">{quarterLabel(p.period)}{p.upcoming ? " · upcoming" : ""}</div>
          {!p.upcoming && <TipRow label="Actual" value={fmtEps(p.epsActual)} />}
          <TipRow label="Estimate" value={fmtEps(p.epsEstimate)} />
          {!p.upcoming && (
            <TipRow
              label="Surprise"
              value={s === null ? "—" : formatPctValue(s, true)}
              cls={s === null ? "" : s >= 0 ? "up" : "down"}
            />
          )}
          <TipRow label={p.upcoming ? "Expected" : "Reported"} value={p.reportDate ? formatDate(p.reportDate) : "—"} />
        </>
      );
    } else {
      const p = revenue[hover];
      tip = (
        <>
          <div className="dtl-tip-title">{quarterLabel(p.period)}</div>
          <TipRow label="Revenue" value={`${formatCompact(p.revenue)}${currency && p.revenue !== null ? ` ${currency}` : ""}`} />
          <TipRow label="Period end" value={formatDate(p.period)} />
        </>
      );
    }
  }
  const tipLeft = hoverCol ? Math.min(Math.max(hoverCol.cx - TIP_W / 2, 0), Math.max(0, box.width - TIP_W)) : 0;

  return (
    <div ref={ref} className="dtl-chart">
      {width > 0 && !geo && <div className="dtl-chart-empty">No {mode === "eps" ? "EPS" : "revenue"} history available</div>}
      {geo && width > 0 && (
        <svg
          width={box.width}
          height={box.height}
          className="dtl-chart-svg"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={mode === "eps" ? "Earnings per share, actual vs estimate" : "Quarterly revenue"}
        >
          {hoverCol && (
            <rect className="dtl-chart-hover" x={hoverCol.bandLeft} y={geo.plot.top - 4} width={hoverCol.bandWidth} height={geo.plot.bottom - geo.plot.top + 8} rx={3} />
          )}
          {geo.ticks.map((t) => (
            <g key={t.value}>
              <line className="dtl-chart-grid" x1={geo.plot.left} x2={geo.plot.right} y1={t.y} y2={t.y} />
              <text className="dtl-chart-axis" x={box.width - 2} y={t.y} dy="0.32em" textAnchor="end">{t.label}</text>
            </g>
          ))}
          {geo.zeroY !== null && <line className="dtl-chart-zero" x1={geo.plot.left} x2={geo.plot.right} y1={geo.zeroY} y2={geo.zeroY} />}
          {columns.map((c) =>
            c.showLabel ? (
              <text key={c.index} className="dtl-chart-axis" x={c.cx} y={box.height - 4} textAnchor="middle">{c.label}</text>
            ) : null,
          )}
          {eps?.dots.map((col, i) =>
            col.map((d) => (
              <circle
                key={`${i}-${d.kind}`}
                className={`dtl-dot dtl-dot-${d.kind}`}
                cx={d.cx}
                cy={d.cy}
                r={d.kind === "estimate" ? DOT_R + 0.5 : DOT_R}
              />
            )),
          )}
          {rev?.bars.map((b, i) =>
            b ? (
              <rect key={i} className={`dtl-bar${b.negative ? " dtl-bar-neg" : ""}${hover === i ? " hovered" : ""}`} x={b.x} y={b.y} width={b.width} height={b.height} rx={2} />
            ) : null,
          )}
        </svg>
      )}
      {tip && (
        <div className="dtl-tip" style={{ left: tipLeft, width: TIP_W }} role="tooltip">
          {tip}
        </div>
      )}
    </div>
  );
}

function TipRow({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="dtl-tip-row">
      <span>{label}</span>
      <b className={cls}>{value}</b>
    </div>
  );
}
