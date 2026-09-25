// Pure sparkline geometry + a canvas painter. Geometry is covered by sparkline.test.ts.

export interface SparkGeometry {
  points: [number, number][];
  min: number;
  max: number;
  /** last >= first */
  up: boolean;
  changePct: number | null;
}

/** Map closes onto a w×h box (y grows downward) with `pad` px of vertical padding. Non-finite values are skipped. */
export function sparkGeometry(values: readonly number[], w: number, h: number, pad = 2): SparkGeometry | null {
  const vals = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length < 2 || w <= 0 || h <= 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const innerH = Math.max(0, h - pad * 2);
  const step = w / (vals.length - 1);
  const points = vals.map((v, i): [number, number] => {
    const y = span === 0 ? h / 2 : pad + innerH - ((v - min) / span) * innerH;
    return [i * step, y];
  });
  const first = vals[0];
  const last = vals[vals.length - 1];
  return { points, min, max, up: last >= first, changePct: first !== 0 ? ((last - first) / first) * 100 : null };
}

export interface SparkColors {
  up: string;
  down: string;
  upFill: string;
  downFill: string;
  grid?: string;
}

/** Read theme colours from the CSS variables in styles.css (call again after a theme switch). */
export function themeSparkColors(): SparkColors {
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    up: get("--up", "#089981"),
    down: get("--down", "#f23645"),
    upFill: get("--up-soft", "rgba(8,153,129,0.2)"),
    downFill: get("--down-soft", "rgba(242,54,69,0.2)"),
    grid: get("--border", "#2a2e39"),
  };
}

/** Paint a sparkline into a canvas sized by CSS (handles devicePixelRatio). Returns false when there is nothing to draw. */
export function drawSparkline(canvas: HTMLCanvasElement, values: readonly number[], colors: SparkColors, opts: { baseline?: boolean } = {}): boolean {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const g = sparkGeometry(values, w, h, 3);
  if (!g) return false;
  const line = g.up ? colors.up : colors.down;
  const fill = g.up ? colors.upFill : colors.downFill;

  if (opts.baseline && colors.grid) {
    const y0 = g.points[0][1];
    ctx.strokeStyle = colors.grid;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  g.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  g.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  return true;
}
