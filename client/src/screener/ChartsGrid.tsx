import { useMemo } from "react";
import { tickerOf, type Row } from "./csv";
import { formatValue } from "./format";
import { openOnChart } from "./hooks";
import { Sparkline, useSparklines } from "./Sparkline";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Charts view: a grid of mini-chart cards for the current page. */
export function ChartsGrid({ rows, loading }: { rows: Row[]; loading: boolean }) {
  const symbols = useMemo(() => rows.map((r) => String(r.symbol ?? "")).filter(Boolean), [rows]);
  const sparks = useSparklines(symbols);
  return (
    <div className={`scr-charts${loading ? " loading" : ""}`}>
      {rows.map((r) => {
        const symbol = String(r.symbol ?? "");
        const chg = num(r.change_pct);
        const name = typeof r.company === "string" ? r.company : typeof r.name === "string" ? r.name : "";
        return (
          <button key={symbol} type="button" className="scr-card" onClick={() => openOnChart(symbol)} title={`Open ${tickerOf(r)} chart`}>
            <div className="scr-card-head">
              <span className="scr-card-ticker">{tickerOf(r)}</span>
              <span className="scr-card-price">{r.price !== undefined ? formatValue(r.price, "money", "price") : ""}</span>
              <span className={`scr-card-chg ${chg === null || chg === 0 ? "" : chg > 0 ? "up" : "down"}`}>
                {chg !== null ? formatValue(chg, "pct") : ""}
              </span>
            </div>
            <div className="scr-card-name" title={name}>{name}</div>
            <Sparkline values={sparks[symbol]} className="scr-card-spark" />
          </button>
        );
      })}
    </div>
  );
}
