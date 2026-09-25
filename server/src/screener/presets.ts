// Saved screener presets (SQLite), seeded with a few useful screens on first run.
import type { Database } from "bun:sqlite";
import type { ScreenerPreset } from "@eodview/shared";
import { HttpError } from "../http";
import { normalizePresetQuery, type NormalizeOpts, type PresetQuery } from "./query";

const MAX_PRESETS = 200;

export const DEFAULT_PRESETS: Array<{ name: string; query: PresetQuery }> = [
  {
    name: "Momentum leaders",
    query: {
      filters: [
        { id: "ta_perf", value: "13w20" },
        { id: "ta_sma50", value: "pa" },
        { id: "ta_sma200", value: "pa" },
        { id: "sh_avgvol", value: "o500" },
      ],
      universe: "stocks", view: "performance", sort: { column: "perf_3m", dir: "desc" },
    },
  },
  {
    name: "Near 52W high",
    query: {
      filters: [{ id: "ta_highlow52w", value: "b0to5h" }, { id: "cap", value: "midover" }],
      universe: "stocks", view: "technical", sort: { column: "high_52w_pct", dir: "desc" },
    },
  },
  {
    name: "Oversold large caps",
    query: {
      filters: [{ id: "ta_rsi", value: "os30" }, { id: "cap", value: "largeover" }],
      universe: "stocks", view: "technical", sort: { column: "rsi14", dir: "asc" },
    },
  },
  {
    name: "Earnings this week",
    query: {
      filters: [{ id: "earningsdate", value: "thisweek" }, { id: "cap", value: "smallover" }],
      universe: "stocks", view: "financial", sort: { column: "earnings_date", dir: "asc" },
    },
  },
  {
    name: "Unusual volume",
    query: {
      filters: [{ id: "sh_relvol", value: "o3" }, { id: "sh_price", value: "o5" }, { id: "sh_avgvol", value: "o200" }],
      universe: "all", view: "overview", sort: { column: "change_pct", dir: "desc" },
    },
  },
];

interface Row { id: string; name: string; query: string }

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

function validateName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 64) bad("name must be a string of 1-64 characters");
  return v.trim();
}

export function createPresetStore(db: Database, opts: NormalizeOpts = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS screener_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS screener_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const qList = db.query<Row, []>("SELECT id, name, query FROM screener_presets ORDER BY position, created_at, rowid");
  const qGet = db.query<Row, [string]>("SELECT id, name, query FROM screener_presets WHERE id = ?");
  const qCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM screener_presets");
  const qMaxPos = db.query<{ p: number | null }, []>("SELECT MAX(position) AS p FROM screener_presets");
  const qInsert = db.query<null, [string, string, string, number, number, number]>(
    "INSERT INTO screener_presets (id, name, query, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const qUpdate = db.query<null, [string, string, number, string]>("UPDATE screener_presets SET name = ?, query = ?, updated_at = ? WHERE id = ?");
  const qDelete = db.query<null, [string]>("DELETE FROM screener_presets WHERE id = ?");
  const qStateGet = db.query<{ value: string }, [string]>("SELECT value FROM screener_state WHERE key = ?");
  const qStateSet = db.query<null, [string, string]>("INSERT OR REPLACE INTO screener_state (key, value) VALUES (?, ?)");

  const nowSec = () => Math.floor(Date.now() / 1000);
  const toPreset = (r: Row): ScreenerPreset | null => {
    try {
      // Stored queries were validated on write; re-validate shape only (dynamic options not checked) and skip corrupt rows.
      return { id: r.id, name: r.name, query: normalizePresetQuery(JSON.parse(r.query)) };
    } catch {
      return null;
    }
  };

  function insert(name: string, query: PresetQuery): ScreenerPreset {
    const id = crypto.randomUUID();
    const pos = (qMaxPos.get()?.p ?? -1) + 1;
    qInsert.run(id, name, JSON.stringify(query), pos, nowSec(), nowSec());
    return { id, name, query };
  }

  db.transaction(() => {
    if (qStateGet.get("presets_seeded")) return;
    if ((qCount.get()?.n ?? 0) === 0) for (const p of DEFAULT_PRESETS) insert(p.name, normalizePresetQuery(p.query));
    qStateSet.run("presets_seeded", "1");
  })();

  const validateQuery = (q: unknown) => normalizePresetQuery(q, opts);

  return {
    list(): ScreenerPreset[] {
      return qList.all().map(toPreset).filter((p): p is ScreenerPreset => p !== null);
    },
    get(id: string): ScreenerPreset | null {
      const r = qGet.get(id);
      return r ? toPreset(r) : null;
    },
    create(body: unknown): ScreenerPreset {
      if (typeof body !== "object" || body === null || Array.isArray(body)) bad("body must be a JSON object");
      const o = body as Record<string, unknown>;
      const name = validateName(o.name);
      const query = validateQuery(o.query);
      if ((qCount.get()?.n ?? 0) >= MAX_PRESETS) bad(`at most ${MAX_PRESETS} presets`);
      return insert(name, query);
    },
    /** null when the preset does not exist. */
    update(id: string, body: unknown): ScreenerPreset | null {
      if (typeof body !== "object" || body === null || Array.isArray(body)) bad("body must be a JSON object");
      const o = body as Record<string, unknown>;
      if (o.id !== undefined && o.id !== id) bad("body id does not match the URL");
      const cur = qGet.get(id);
      if (!cur) return null;
      const name = o.name === undefined ? cur.name : validateName(o.name);
      const query = o.query === undefined ? normalizePresetQuery(JSON.parse(cur.query)) : validateQuery(o.query);
      qUpdate.run(name, JSON.stringify(query), nowSec(), id);
      return { id, name, query };
    },
    remove(id: string): boolean {
      return qDelete.run(id).changes > 0;
    },
  };
}
export type PresetStore = ReturnType<typeof createPresetStore>;
