import { useEffect, useRef } from "react";
import type { ChartHandle } from "../chart/types";
import { useStore } from "../state/store";
import { DrawingController } from "./controller";
import { useDrawingPersistence } from "./persistence";

/**
 * Renders the current symbol's drawings on the chart (one series primitive on handle.mainSeries)
 * and handles creation, selection, dragging and deletion. Renders no DOM of its own.
 */
export function DrawingLayer(props: { handle: ChartHandle | null }) {
  const { handle } = props;
  const symbol = useStore((s) => s.layout.symbol);
  const theme = useStore((s) => s.layout.theme);
  const controller = useRef<DrawingController | null>(null);

  useDrawingPersistence(symbol);

  useEffect(() => {
    if (!handle) return;
    const c = new DrawingController(handle);
    c.setTheme(useStore.getState().layout.theme);
    controller.current = c;
    return () => {
      c.dispose();
      if (controller.current === c) controller.current = null;
    };
  }, [handle]);

  useEffect(() => {
    controller.current?.setTheme(theme);
  }, [theme]);

  return null;
}
