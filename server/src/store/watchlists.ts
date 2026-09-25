// Watchlists persistence (seeded with a default list on first run) and validation.
import type { Database } from "bun:sqlite";
import type { Symbol, Watchlist } from "@eodview/shared";
import { bad, requireObject, requireString, requireSymbols } from "./validate";

export const DEFAULT_WATCHLIST: { name: string; symbols: Symbol[] } = {
  name: "Watchlist",
  symbols: ["AAPL.US", "MSFT.US", "NVDA.US", "SPY.US", "BTC-USD.CC", "EURUSD.FOREX"],
};
const MAX_SYMBOLS = 500;
const MAX_LISTS = 100;

interface Row { id: string; name: string; symbols: string }

function toWatchlist(r: Row): Watchlist {
  let symbols: Symbol[] = [];
  try {
    const parsed: unknown = JSON.parse(r.symbols);
    if (Array.isArray(parsed)) symbols = parsed.filter((s): s is string => typeof s === "string");
  } catch { /* corrupt row → empty list */ }
  return { id: r.id, name: r.name, symbols };
}

export function validateWatchlistName(v: unknown): string {
  return requireString(v, "name", { min: 1, max: 64 });
}

export function createWatchlistStore(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbols TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const qList = db.query<Row, []>("SELECT id, name, symbols FROM watchlists ORDER BY position, created_at, rowid");
  const qGet = db.query<Row, [string]>("SELECT id, name, symbols FROM watchlists WHERE id = ?");
  const qCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM watchlists");
  const qMaxPos = db.query<{ p: number | null }, []>("SELECT MAX(position) AS p FROM watchlists");
  const qInsert = db.query<null, [string, string, string, number, number]>(
    "INSERT INTO watchlists (id, name, symbols, position, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const qUpdate = db.query<null, [string, string, string]>("UPDATE watchlists SET name = ?, symbols = ? WHERE id = ?");
  const qDelete = db.query<null, [string]>("DELETE FROM watchlists WHERE id = ?");
  const qMetaGet = db.query<{ value: string }, [string]>("SELECT value FROM store_meta WHERE key = ?");
  const qMetaSet = db.query<null, [string, string]>("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)");

  function insert(name: string, symbols: Symbol[]): Watchlist {
    const id = crypto.randomUUID();
    const pos = (qMaxPos.get()?.p ?? -1) + 1;
    qInsert.run(id, name, JSON.stringify(symbols), pos, Math.floor(Date.now() / 1000));
    return { id, name, symbols };
  }

  // Seed once per database (deleting every list later does not resurrect the default).
  db.transaction(() => {
    if (qMetaGet.get("watchlists_seeded")) return;
    if ((qCount.get()?.n ?? 0) === 0) insert(DEFAULT_WATCHLIST.name, [...DEFAULT_WATCHLIST.symbols]);
    qMetaSet.run("watchlists_seeded", "1");
  })();

  return {
    list(): Watchlist[] {
      return qList.all().map(toWatchlist);
    },
    get(id: string): Watchlist | null {
      const r = qGet.get(id);
      return r ? toWatchlist(r) : null;
    },
    create(body: unknown): Watchlist {
      const o = requireObject(body);
      const name = validateWatchlistName(o.name);
      const symbols = o.symbols === undefined ? [] : requireSymbols(o.symbols, "symbols", MAX_SYMBOLS);
      if ((qCount.get()?.n ?? 0) >= MAX_LISTS) bad(`at most ${MAX_LISTS} watchlists`);
      return insert(name, symbols);
    },
    /** Returns null when the list does not exist. Validates (HttpError 400). */
    update(id: string, body: unknown): Watchlist | null {
      const o = requireObject(body);
      if (o.id !== undefined && o.id !== id) bad("body id does not match the URL");
      const cur = this.get(id);
      if (!cur) return null;
      const name = o.name === undefined ? cur.name : validateWatchlistName(o.name);
      const symbols = o.symbols === undefined ? cur.symbols : requireSymbols(o.symbols, "symbols", MAX_SYMBOLS);
      qUpdate.run(name, JSON.stringify(symbols), id);
      return { id, name, symbols };
    },
    remove(id: string): boolean {
      return qDelete.run(id).changes > 0;
    },
  };
}
export type WatchlistStore = ReturnType<typeof createWatchlistStore>;
