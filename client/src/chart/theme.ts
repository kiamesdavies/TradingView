import type { Theme } from "@eodview/shared";

export interface ChartPalette {
  background: string;
  grid: string;
  text: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
  line: string;
  areaTop: string;
  areaBottom: string;
  alertLine: string;
  overlayBg: string;
  overlayBorder: string;
  muted: string;
}

const UP = "#26a69a";
const DOWN = "#ef5350";

export const PALETTES: Record<Theme, ChartPalette> = {
  dark: {
    background: "#131722",
    grid: "#1e222d",
    text: "#d1d4dc",
    border: "#2a2e39",
    crosshair: "#758696",
    up: UP,
    down: DOWN,
    upVolume: "rgba(38, 166, 154, 0.45)",
    downVolume: "rgba(239, 83, 80, 0.45)",
    line: "#2962ff",
    areaTop: "rgba(41, 98, 255, 0.35)",
    areaBottom: "rgba(41, 98, 255, 0.02)",
    alertLine: "#ff9800",
    overlayBg: "#1e222d",
    overlayBorder: "#363a45",
    muted: "#787b86",
  },
  light: {
    background: "#ffffff",
    grid: "#f0f3fa",
    text: "#131722",
    border: "#e0e3eb",
    crosshair: "#9598a1",
    up: UP,
    down: DOWN,
    upVolume: "rgba(38, 166, 154, 0.4)",
    downVolume: "rgba(239, 83, 80, 0.4)",
    line: "#2962ff",
    areaTop: "rgba(41, 98, 255, 0.28)",
    areaBottom: "rgba(41, 98, 255, 0.02)",
    alertLine: "#f57c00",
    overlayBg: "#ffffff",
    overlayBorder: "#e0e3eb",
    muted: "#787b86",
  },
};
