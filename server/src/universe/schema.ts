// SQLite schema of the universe pipeline. universe_metrics is created from METRIC_COLUMNS (missing columns added).
// v3: per-market sessions/holidays, full-history stats (universe_long), FX rates, index members; a one-time
// migration moves v2 (US-only) state to the per-market layout.
import type { Database } from "bun:sqlite";
import { METRIC_COLUMNS, METRICS_TABLE } from "./metricsSchema";

/** Filter columns the screener hits most. */
const METRIC_INDEXES = [
  "kind", "market", "exchange", "sector", "industry", "country", "market_cap", "market_cap_usd", "price", "change_pct", "avg_volume",
  "rel_volume", "dollar_volume", "dollar_volume_usd", "pe", "perf_1w", "perf_3m", "rsi14", "earnings_date", "sma50_pct", "sma200_pct",
  "ath_pct", "rs_rank",
];

export const SCHEMA_VERSION = "3";

function columns(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}
function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

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
    bulk_avgvol50 REAL,
    market TEXT NOT NULL DEFAULT 'US',
    currency TEXT,
    indices TEXT
  )`);
  // v2 databases: add the v3 columns.
  const symCols = columns(db, "universe_symbols");
  if (!symCols.has("market")) db.exec(`ALTER TABLE universe_symbols ADD COLUMN market TEXT NOT NULL DEFAULT 'US'`);
  if (!symCols.has("currency")) db.exec(`ALTER TABLE universe_symbols ADD COLUMN currency TEXT`);
  if (!symCols.has("indices")) db.exec(`ALTER TABLE universe_symbols ADD COLUMN indices TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_universe_symbols_market ON universe_symbols(market, active)`);

  db.exec(`CREATE TABLE IF NOT EXISTS universe_bars (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL, adj_close REAL, volume REAL,
    PRIMARY KEY (symbol, date)
  ) WITHOUT ROWID`);
  // Session dates per market. rows = symbols stored from that date's bulk file (NULL: only seen in per-ticker
  // histories). The newest date with rows is the market's latest complete session.
  db.exec(`CREATE TABLE IF NOT EXISTS universe_sessions (
    market TEXT NOT NULL, date TEXT NOT NULL, rows INTEGER, fetched_at INTEGER,
    PRIMARY KEY (market, date)
  ) WITHOUT ROWID`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_market_holidays (
    market TEXT NOT NULL, date TEXT NOT NULL, source TEXT,
    PRIMARY KEY (market, date)
  ) WITHOUT ROWID`);
  // Full-history statistics per symbol (per-ticker backfill). status: ok | nodata | error | stale (re-fetch due).
  db.exec(`CREATE TABLE IF NOT EXISTS universe_long (
    symbol TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    status TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    first_date TEXT, last_date TEXT, rows_total INTEGER, rows_kept INTEGER,
    ath REAL, ath_date TEXT, atl REAL, atl_date TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_universe_long_market ON universe_long(market, status)`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_fx (currency TEXT PRIMARY KEY, rate REAL NOT NULL, fetched_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_index_members (
    index_id TEXT NOT NULL, symbol TEXT NOT NULL, PRIMARY KEY (index_id, symbol)
  ) WITHOUT ROWID`);
  // Derived fundamentals per symbol (JSON of DerivedFundamentals) + fetch time.
  db.exec(`CREATE TABLE IF NOT EXISTS universe_fund (
    symbol TEXT PRIMARY KEY,
    fundamentals_at INTEGER NOT NULL,
    data TEXT,
    error TEXT
  )`);
  // Per-symbol fundamentals failures (5xx, timeouts, plan limits…): the symbol is skipped until retry_at.
  db.exec(`CREATE TABLE IF NOT EXISTS universe_fund_retry (
    symbol TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    retry_at INTEGER NOT NULL,
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
  // Ledger; `job` is the job instance ("prices:ST", "fundamentals:LSE", "fx", ...), so spend is per market.
  db.exec(`CREATE TABLE IF NOT EXISTS universe_credits (
    date TEXT NOT NULL,
    job TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, job)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS universe_dirty (symbol TEXT PRIMARY KEY)`);
  ensureMetricsTable(db);
  migrateV2(db);
}

/** v2 (US-only) → v3 per-market state. Idempotent; runs once per database. */
function migrateV2(db: Database): void {
  if (kvGet(db, "schema_version") === SCHEMA_VERSION) return;
  db.transaction(() => {
    if (tableExists(db, "universe_dates")) {
      db.exec(`INSERT OR IGNORE INTO universe_sessions (market, date, rows, fetched_at) SELECT 'US', date, rows, fetched_at FROM universe_dates`);
      db.exec(`DROP TABLE universe_dates`);
    }
    if (tableExists(db, "universe_holidays")) {
      db.exec(`INSERT OR IGNORE INTO universe_market_holidays (market, date, source) SELECT 'US', date, 'learned' FROM universe_holidays`);
      db.exec(`DROP TABLE universe_holidays`);
    }
    // Market-scoped job rows and state keys gain the ":US" suffix.
    for (const j of ["symbols", "prices", "backfill", "indices"]) {
      db.query(`UPDATE OR IGNORE universe_jobs SET name = ? WHERE name = ?`).run(`${j}:US`, j);
      db.query(`DELETE FROM universe_jobs WHERE name = ?`).run(j);
    }
    for (const k of ["prices_last_attempt", "prices_attempts", "actions_through", "repull_pending"]) {
      const v = kvGet(db, k);
      if (v !== null && kvGet(db, `${k}:US`) === null) kvSet(db, `${k}:US`, v);
      kvSet(db, k, null);
    }
    kvSet(db, "pruned_at", null);
    // Index flags → generic membership list.
    db.exec(`UPDATE universe_symbols SET indices = NULLIF(
      (CASE WHEN in_sp500 = 1 THEN ',SP500' ELSE '' END) || (CASE WHEN in_ndx = 1 THEN ',NDX' ELSE '' END) ||
      (CASE WHEN in_dji = 1 THEN ',DJI' ELSE '' END) || ',', ',') WHERE market = 'US' AND indices IS NULL`);
    kvSet(db, "metrics_full", "1");
    kvSet(db, "schema_version", SCHEMA_VERSION);
  })();
}

export function ensureMetricsTable(db: Database): void {
  const defs = METRIC_COLUMNS.map((c) => (c.col === "symbol" ? `symbol TEXT PRIMARY KEY` : `"${c.col}" ${c.type}`));
  db.exec(`CREATE TABLE IF NOT EXISTS ${METRICS_TABLE} (${defs.join(", ")})`);
  const have = columns(db, METRICS_TABLE);
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
