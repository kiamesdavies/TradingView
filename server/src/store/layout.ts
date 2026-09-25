// Layout persistence (single JSON row) and validation.
import type { Database } from "bun:sqlite";
import { TIMEFRAMES, type ChartType, type IndicatorConfig, type IndicatorType, type Layout, type Theme } from "@eodview/shared";
import {
  bad, isObject, optionalString, requireBoolean, requireEnum, requireObject, requireString, requireSymbol, requireSymbols,
} from "./validate";

export const CHART_TYPES: readonly ChartType[] = ["candles", "bars", "line", "area", "heikin"];
export const THEMES: readonly Theme[] = ["dark", "light"];
export const INDICATOR_TYPES: readonly IndicatorType[] = ["sma", "ema", "vwap", "bb", "rsi", "macd", "atr", "volma"];
const MAX_INDICATORS = 50;
const MAX_PARAMS = 20;
const MAX_RECENT = 50;

function validateIndicator(v: unknown, i: number): IndicatorConfig {
  const f = `indicators[${i}]`;
  const o = requireObject(v, f);
  const params = requireObject(o.params ?? {}, `${f}.params`);
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAMS) bad(`${f}.params has too many keys`);
  const cleanParams: Record<string, number | string> = {};
  for (const k of keys) {
    if (k.length > 32) bad(`${f}.params key too long`);
    const p = params[k];
    if (typeof p === "number" && Number.isFinite(p)) cleanParams[k] = p;
    else if (typeof p === "string" && p.length <= 64) cleanParams[k] = p;
    else bad(`${f}.params.${k} must be a finite number or a short string`);
  }
  const ind: IndicatorConfig = {
    id: requireString(o.id, `${f}.id`, { min: 1, max: 64 }),
    type: requireEnum(o.type, `${f}.type`, INDICATOR_TYPES),
    params: cleanParams,
    visible: o.visible === undefined ? true : requireBoolean(o.visible, `${f}.visible`),
  };
  const color = optionalString(o.color, `${f}.color`, 64);
  if (color) ind.color = color;
  return ind;
}

export function validateLayout(v: unknown): Layout {
  const o = requireObject(v, "layout");
  if (!Array.isArray(o.indicators ?? [])) bad("indicators must be an array");
  const inds = (o.indicators ?? []) as unknown[];
  if (inds.length > MAX_INDICATORS) bad(`at most ${MAX_INDICATORS} indicators`);
  const indicators = inds.map(validateIndicator);
  if (new Set(indicators.map((x) => x.id)).size !== indicators.length) bad("indicator ids must be unique");
  const layout: Layout = {
    symbol: requireSymbol(o.symbol),
    tf: requireEnum(o.tf, "tf", TIMEFRAMES),
    chartType: requireEnum(o.chartType, "chartType", CHART_TYPES),
    theme: requireEnum(o.theme, "theme", THEMES),
    logScale: o.logScale === undefined ? false : requireBoolean(o.logScale, "logScale"),
    indicators,
    recentSymbols: requireSymbols(o.recentSymbols ?? [], "recentSymbols", 500).slice(0, MAX_RECENT),
  };
  const wl = optionalString(o.activeWatchlistId, "activeWatchlistId", 64);
  if (wl) layout.activeWatchlistId = wl;
  return layout;
}

export function createLayoutStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS layout (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const qGet = db.query<{ json: string }, []>("SELECT json FROM layout WHERE id = 1");
  const qPut = db.query<null, [string, number]>(
    "INSERT INTO layout (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
  );
  return {
    get(): Layout | null {
      const r = qGet.get();
      if (!r) return null;
      try {
        const parsed: unknown = JSON.parse(r.json);
        return isObject(parsed) ? (parsed as unknown as Layout) : null;
      } catch {
        return null;
      }
    },
    /** Validates (throws HttpError 400) and stores the layout. */
    put(input: unknown): Layout {
      const layout = validateLayout(input);
      qPut.run(JSON.stringify(layout), Math.floor(Date.now() / 1000));
      return layout;
    },
  };
}
export type LayoutStore = ReturnType<typeof createLayoutStore>;
