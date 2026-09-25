// SQLite schema of the universe pipeline. universe_metrics is created from METRIC_COLUMNS (missing columns added).
import type { Database } from "bun:sqlite";
import { METRIC_COLUMNS, METRICS_TABLE } from "./metricsSchema";

/** Filter columns the screener hits most; the table is small (~11k rows) so a few indexes suffice. */
const METRIC_INDEXES = [
  "kind", "exchange", "sector", "industry", "country", "market_cap", "price", "change_pct", "avg_volume",
  "rel_volume", "dollar_volume", "pe", "perf_1w", "rsi14", "earnings_date", "sma50_pct", "sma200_pct",
];

export function initUniverseSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS universe_symbols (
    symbol TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT,
    exchange TEXT,
    kind TEXT NOT NULL,
    isin TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER,
    updated_at INTEGER,
    in_sp500 INTEGER NOT NULL DEFAULT 0,
    in_ndx INTEGER NOT NULL DEFAULT 0,
    in_dji INTEGER NOT NULL DEFAULT 0,
    earnings_date TEXT,
    earnings_timing TEXT,
    last_earnings_date TEXT,
    latest_news_at INTEGER,
    bulk_date TEXT,
    bulk_mcap REAL,
    bulk_beta REAL,
    bulk_hi250 REAL,
    bulk_lo250 REAL,
    bulk_avgvol50 REAL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_bars (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL, adj_close REAL, volume REAL,
    PRIMARY KEY (symbol, date)
  ) WITHOUT ROWID`);
  // Rows stored per session date (drives "date already present" checks and historyDays without scanning bars).
  db.exec(`CREATE TABLE IF NOT EXISTS universe_dates (date TEXT PRIMARY KEY, rows INTEGER NOT NULL, fetched_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_holidays (date TEXT PRIMARY KEY)`);
  // Derived fundamentals per symbol (JSON of DerivedFundamentals) + fetch time.
  db.exec(`CREATE TABLE IF NOT EXISTS universe_fund (
    symbol TEXT PRIMARY KEY,
    fundamentals_at INTEGER NOT NULL,
    data TEXT,
    error TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_jobs (
    name TEXT PRIMARY KEY,
    last_run_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    progress TEXT,
    next_run_at INTEGER,
    next_mode TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_kv (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_credits (
    date TEXT NOT NULL,
    job TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, job)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_dirty (symbol TEXT PRIMARY KEY)`);
  ensureMetricsTable(db);
}

export function ensureMetricsTable(db: Database): void {
  const defs = METRIC_COLUMNS.map((c) => (c.col === "symbol" ? `symbol TEXT PRIMARY KEY` : `"${c.col}" ${c.type}`));
  db.exec(`CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (${defs.join(", ")})`);
  const have = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${METRICS_TABLE})`).all().map((r) => r.name));
  for (const c of METRIC_COLUMNS) {
    if (!have.has(c.col)) db.exec(`ALTER TABLE ${METRICS_TABLE} ADD COLUMN "${c.col}" ${c.type}`);
  }
  for (const col of METRIC_INDEXES) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${METRICS_TABLE}_${col} ON ${METRICS_TABLE}("${col}")`);
  }
}

// ---------- tiny key/value state ----------
export function kvGet(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM universe_kv WHERE key = ?").get(key)?.value ?? null;
}
export function kvSet(db: Database, key: string, value: string | null): void {
  if (value === null) db.query("DELETE FROM universe_kv WHERE key = ?").run(key);
  else db.query("INSERT INTO universe_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
