// Per-symbol drawings persistence (whole set replaced on save) and validation.
import type { Database } from "bun:sqlite";
import type { Drawing, DrawingPoint, DrawingType, Symbol } from "@eodview/shared";
import { bad, requireEnum, requireFinite, requireObject, requireString } from "./validate";

export const DRAWING_TYPES: readonly DrawingType[] = ["trendline", "hline", "hray", "rect", "fib"];
const POINTS: Record<DrawingType, number> = { trendline: 2, hline: 1, hray: 1, rect: 2, fib: 2 };
const MAX_DRAWINGS = 1000;

function validatePoint(v: unknown, f: string): DrawingPoint {
  const o = requireObject(v, f);
  return { time: requireFinite(o.time, `${f}.time`, { min: 0 }), price: requireFinite(o.price, `${f}.price`) };
}

export function validateDrawing(v: unknown, i: number): Drawing {
  const f = `drawings[${i}]`;
  const o = requireObject(v, f);
  const type = requireEnum(o.type, `${f}.type`, DRAWING_TYPES);
  if (!Array.isArray(o.points)) bad(`${f}.points must be an array`);
  if (o.points.length !== POINTS[type]) bad(`${f}.points must have ${POINTS[type]} point(s) for ${type}`);
  return {
    id: requireString(o.id, `${f}.id`, { min: 1, max: 64 }),
    type,
    points: o.points.map((p, j) => validatePoint(p, `${f}.points[${j}]`)),
    color: requireString(o.color, `${f}.color`, { min: 1, max: 64 }),
    lineWidth: requireFinite(o.lineWidth, `${f}.lineWidth`, { min: 0.5, max: 20 }),
  };
}

export function validateDrawings(v: unknown): Drawing[] {
  if (!Array.isArray(v)) bad("body must be an array of drawings");
  if (v.length > MAX_DRAWINGS) bad(`at most ${MAX_DRAWINGS} drawings per symbol`);
  const out = v.map(validateDrawing);
  if (new Set(out.map((d) => d.id)).size !== out.length) bad("drawing ids must be unique");
  return out;
}

export function createDrawingStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS drawings (
    symbol TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const qGet = db.query<{ json: string }, [string]>("SELECT json FROM drawings WHERE symbol = ?");
  const qPut = db.query<null, [string, string, number]>(
    "INSERT INTO drawings (symbol, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
  );
  const qDelete = db.query<null, [string]>("DELETE FROM drawings WHERE symbol = ?");

  return {
    get(symbol: Symbol): Drawing[] {
      const r = qGet.get(symbol);
      if (!r) return [];
      try {
        const parsed: unknown = JSON.parse(r.json);
        return Array.isArray(parsed) ? (parsed as Drawing[]) : [];
      } catch {
        return [];
      }
    },
    /** Replace the whole set for a symbol. Validates (HttpError 400). */
    put(symbol: Symbol, body: unknown): Drawing[] {
      const drawings = validateDrawings(body);
      if (drawings.length === 0) qDelete.run(symbol);
      else qPut.run(symbol, JSON.stringify(drawings), Math.floor(Date.now() / 1000));
      return drawings;
    },
  };
}
export type DrawingStore = ReturnType<typeof createDrawingStore>;
