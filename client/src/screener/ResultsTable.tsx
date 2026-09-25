import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ScreenerColumnDef } from "@eodview/shared";
import { tickerOf, type Row } from "./csv";
import { cellTone, formatCell, formatValue, rowCurrency } from "./format";
import { openOnChart } from "./hooks";
import { loadSparklines, cachedSparkline } from "./screenerApi";
import { Sparkline } from "./Sparkline";
import type { SortDir } from "./queryState";

interface HoverState {
  symbol: string;
  row: Row;
  x: number;
  y: number;
}

const POP_W = 260;
const POP_H = 150;

function TickerPopup({ hover }: { hover: HoverState }) {
  const [values, setValues] = useState<number[] | undefined>(() => cachedSparkline(hover.symbol));
  useEffect(() => {
    let alive = true;
    const c = cachedSparkline(hover.symbol);
    setValues(c);
    if (!c) void loadSparklines([hover.symbol]).then((r) => alive && setValues(r[hover.symbol] ?? []));
    return () => {
      alive = false;
    };
  }, [hover.symbol]);
  const left = Math.max(8, Math.min(hover.x, window.innerWidth - POP_W - 8));
  const top = hover.y + POP_H + 8 > window.innerHeight ? Math.max(8, hover.y - POP_H - 28) : hover.y;
  const { row } = hover;
  const chg = typeof row.change_pct === "number" ? row.change_pct : null;
  return createPortal(
    <div className="scr-hovercard" style={{ left, top, width: POP_W }} role="tooltip">
      <div className="scr-hc-head">
        <b>{tickerOf(row)}</b>
        <span className="scr-hc-name">{typeof row.company === "string" ? row.company : typeof row.name === "string" ? row.name : ""}</span>
      </div>
      {(row.price !== undefined || chg !== null) && (
        <div className="scr-hc-quote">
          {row.price !== undefined && <span>{formatValue(row.price, "money", "price")}</span>}
          {chg !== null && <span className={chg > 0 ? "up" : chg < 0 ? "down" : ""}>{formatValue(chg, "pct")}</span>}
        </div>
      )}
      <Sparkline values={values} className="scr-hc-spark" baseline />
      <div className="scr-hc-foot muted">Last 60 daily closes · click to open chart</div>
    </div>,
    document.body,
  );
}

export function ResultsTable({ columns, rows, offset, sort, onSort, loading, currency }: {
  columns: ScreenerColumnDef[];
  rows: Row[];
  offset: number;
  sort: { column: string; dir: SortDir };
  onSort: (col: ScreenerColumnDef) => void;
  loading: boolean;
  /** v3: non-US / all-markets screens show local money values with their currency code (row.currency, else `fallback`). */
  currency?: { show: boolean; fallback: string | null } | null;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHover(null);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!hover) return;
    const onScroll = () => setHover(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hover]);

  const hasTicker = columns.some((c) => c.id === "ticker");

  return (
    <div className={`scr-table-wrap${loading ? " loading" : ""}`}>
      <table className="scr-table">
        <thead>
          <tr>
            <th className="scr-th num scr-no">No.</th>
            {!hasTicker && <th className="scr-th">Ticker</th>}
            {columns.map((c) => {
              const active = sort.column === c.id;
              return (
                <th
                  key={c.id}
                  className={`scr-th sortable${c.align === "right" ? " num" : ""}${active ? " sorted" : ""}`}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onSort(c)}
                  title={`Sort by ${c.label}`}
                >
                  <span className="scr-th-inner">
                    {c.label}
                    <span className="scr-sort-ind" aria-hidden="true">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const symbol = String(r.symbol ?? "");
            const ticker = tickerOf(r);
            const tickerCell = (
              <span
                className="scr-ticker"
                role="link"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && openOnChart(symbol)}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (timer.current) clearTimeout(timer.current);
                  timer.current = setTimeout(() => setHover({ symbol, row: r, x: rect.left, y: rect.bottom + 4 }), 250);
                }}
                onMouseLeave={clearHover}
              >
                {ticker}
              </span>
            );
            const ctx = currency?.show ? { currency: rowCurrency(r, currency.fallback) } : undefined;
            return (
              <tr key={symbol || i} className="scr-tr" onClick={() => { clearHover(); openOnChart(symbol); }}>
                <td className="num muted scr-no">{offset + i + 1}</td>
                {!hasTicker && <td>{tickerCell}</td>}
                {columns.map((c) => {
                  if (c.id === "ticker") return <td key={c.id}>{tickerCell}</td>;
                  const v = r[c.id];
                  const tone = cellTone(v, c);
                  const text = formatCell(v, c, ctx);
                  return (
                    <td key={c.id} className={`${c.align === "right" ? "num" : "scr-text"}${tone ? ` ${tone}` : ""}`} title={c.format === "text" && text.length > 24 ? text : undefined}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hover && <TickerPopup hover={hover} />}
    </div>
  );
}
