import type { ReactNode } from "react";
import type { DrawingType } from "@eodview/shared";
import { useStore } from "../state/store";
import { useDrawingStore } from "./drawingStore";
import "./drawings.css";

type Tool = DrawingType | "cursor" | "measure";

const svg = (children: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const TOOLS: { tool: Tool; title: string; icon: ReactNode }[] = [
  {
    tool: "cursor", title: "Cursor (Esc)",
    icon: svg(<path d="M6 3.5 L6 17 L9.5 13.6 L12 19 L14.2 18 L11.7 12.7 L16.5 12.4 Z" />),
  },
  {
    tool: "measure", title: "Measure: price change, %, bars and time (or Shift+drag)",
    icon: svg(<>
      <rect x="2.5" y="7.5" width="17" height="7" rx="1" transform="rotate(-45 11 11)" />
      <path d="M7.2 11.8 L8.8 13.4 M9.6 9.4 L11.2 11 M12 7 L13.6 8.6 M14.4 4.6 L16 6.2" transform="translate(-0.6 1.1)" />
    </>),
  },
  {
    tool: "trendline", title: "Trend line",
    icon: svg(<>
      <line x1="5" y1="17" x2="17" y2="5" />
      <circle cx="5" cy="17" r="1.8" fill="currentColor" />
      <circle cx="17" cy="5" r="1.8" fill="currentColor" />
    </>),
  },
  {
    tool: "hline", title: "Horizontal line",
    icon: svg(<>
      <line x1="2" y1="11" x2="20" y2="11" />
      <circle cx="11" cy="11" r="1.8" fill="currentColor" />
    </>),
  },
  {
    tool: "hray", title: "Horizontal ray",
    icon: svg(<>
      <line x1="6" y1="11" x2="20" y2="11" />
      <circle cx="6" cy="11" r="1.8" fill="currentColor" />
      <path d="M17 8.5 L20 11 L17 13.5" />
    </>),
  },
  {
    tool: "rect", title: "Rectangle",
    icon: svg(<rect x="4" y="6" width="14" height="10" rx="0.5" />),
  },
  {
    tool: "fib", title: "Fib retracement: drag from a swing low to a swing high (or high to low) to see pullback levels 23.6%–78.6%",
    icon: svg(<>
      <line x1="3" y1="4" x2="19" y2="4" />
      <line x1="3" y1="9" x2="19" y2="9" />
      <line x1="3" y1="13" x2="19" y2="13" />
      <line x1="3" y1="18" x2="19" y2="18" />
      <line x1="4" y1="18" x2="18" y2="4" strokeDasharray="2 2" opacity="0.7" />
    </>),
  },
];

const trashIcon = svg(<>
  <path d="M4 6 H18" />
  <path d="M8.5 6 V4 H13.5 V6" />
  <path d="M6 6 L7 18.5 H15 L16 6" />
  <line x1="9.5" y1="9" x2="9.5" y2="15.5" />
  <line x1="12.5" y1="9" x2="12.5" y2="15.5" />
</>);

/** Vertical left toolbar: drawing tools, color, clear all. */
export function DrawingToolbar() {
  const activeTool = useStore((s) => s.ui.drawingTool);
  const drawingColor = useStore((s) => s.ui.drawingColor);
  const setUi = useStore((s) => s.setUi);
  const symbol = useStore((s) => s.layout.symbol);
  const selected = useDrawingStore((s) => s.drawings.find((d) => d.id === s.selectedId) ?? null);
  const count = useDrawingStore((s) => s.drawings.length);

  const selectTool = (tool: Tool) => {
    setUi({ drawingTool: tool === activeTool && tool !== "cursor" ? "cursor" : tool });
  };

  const onColor = (color: string) => {
    setUi({ drawingColor: color });
    if (selected) useDrawingStore.getState().recolor(selected.id, color);
  };

  const clearAll = () => {
    if (count === 0) return;
    if (window.confirm(`Remove all ${count} drawing${count === 1 ? "" : "s"} on ${symbol}?`)) {
      useDrawingStore.getState().clear();
      setUi({ drawingTool: "cursor" });
    }
  };

  return (
    <div className="drw-toolbar" role="toolbar" aria-orientation="vertical" aria-label="Drawing tools">
      {TOOLS.map(({ tool, title, icon }) => (
        <button
          key={tool}
          type="button"
          className={`drw-btn${activeTool === tool ? " drw-btn--active" : ""}`}
          title={title}
          aria-label={title}
          aria-pressed={activeTool === tool}
          onClick={() => selectTool(tool)}
        >
          {icon}
        </button>
      ))}
      <div className="drw-sep" />
      <label className="drw-color" title={selected ? "Color of selected drawing" : "Drawing color"}>
        <span className="drw-color__swatch" style={{ background: selected?.color ?? drawingColor }} />
        <input
          type="color"
          value={normalizeHex(selected?.color ?? drawingColor)}
          onChange={(e) => onColor(e.target.value)}
          aria-label="Drawing color"
        />
      </label>
      <div className="drw-spacer" />
      <button
        type="button"
        className="drw-btn drw-btn--danger"
        title={`Remove all drawings on ${symbol}`}
        aria-label="Remove all drawings"
        disabled={count === 0}
        onClick={clearAll}
      >
        {trashIcon}
      </button>
    </div>
  );
}

/** <input type=color> only accepts #rrggbb. */
function normalizeHex(color: string): string {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  return "#2962ff";
}
