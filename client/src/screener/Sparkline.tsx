import { useEffect, useRef, useState } from "react";
import type { Symbol } from "@eodview/shared";
import { useStore } from "../state/store";
import { cachedSparkline, loadSparklines } from "./screenerApi";
import { drawSparkline, themeSparkColors } from "./sparkDraw";

/** Canvas sparkline; `values === undefined` shows a loading shimmer, [] shows "No data". */
export function Sparkline({ values, className, baseline }: { values: number[] | undefined; className?: string; baseline?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.layout.theme);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c || !values) return;
    const paint = () => setEmpty(!drawSparkline(c, values, themeSparkColors(), { baseline }));
    // theme variables flip on <html data-theme>; paint after the attribute update
    const raf = requestAnimationFrame(paint);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(paint) : null;
    ro?.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [values, theme, baseline]);

  return (
    <div className={`scr-spark${values ? "" : " loading"} ${className ?? ""}`}>
      <canvas ref={ref} aria-hidden="true" />
      {values && empty && <span className="scr-spark-empty">No data</span>}
    </div>
  );
}

/** Batch-load sparklines for the given symbols; returns what's loaded so far (cached across pages). */
export function useSparklines(symbols: Symbol[]): Record<Symbol, number[] | undefined> {
  const key = symbols.join(",");
  const [data, setData] = useState<Record<Symbol, number[] | undefined>>(() => {
    const init: Record<Symbol, number[] | undefined> = {};
    for (const s of symbols) init[s] = cachedSparkline(s);
    return init;
  });
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(",") : [];
    const init: Record<Symbol, number[] | undefined> = {};
    for (const s of list) init[s] = cachedSparkline(s);
    setData(init);
    if (list.some((s) => init[s] === undefined)) {
      void loadSparklines(list).then((res) => alive && setData(res));
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return data;
}
