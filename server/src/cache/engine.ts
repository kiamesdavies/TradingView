// Bar cache: SQLite for daily/weekly/monthly (full history once, then tail refresh), in-memory TTL
// cache of fixed, epoch-aligned windows for intraday, with aggregation for 15m/30m/4h.
// Dependencies are injected so tests can use an in-memory DB and a fake client.
import type { Database } from "bun:sqlite";
import type { Bar, BarsResponse, Timeframe } from "@eodview/shared";
import { INTRADAY_MAX_RANGE_SEC, type EodhdClient } from "../eodhd/factory";
import type { EodPeriod, IntradayInterval } from "../eodhd/mappers";
import { InFlight } from "../eodhd/request";
import { aggregate } from "./aggregate";

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 5000;

type TfSpec =
  | { kind: "daily"; period: EodPeriod }
  | { kind: "intraday"; interval: IntradayInterval; bucketSec?: number };

export const TF_SPEC: Record<Timeframe, TfSpec> = {
  "1m": { kind: "intraday", interval: "1m" },
  "5m": { kind: "intraday", interval: "5m" },
  "15m": { kind: "intraday", interval: "5m", bucketSec: 15 * 60 },
  "30m": { kind: "intraday", interval: "5m", bucketSec: 30 * 60 },
  "1h": { kind: "intraday", interval: "1h" },
  "4h": { kind: "intraday", interval: "1h", bucketSec: 4 * 3600 },
  "1D": { kind: "daily", period: "d" },
  "1W": { kind: "daily", period: "w" },
  "1M": { kind: "daily", period: "m" },
};

const DAY = 86400;

/**
 * Intraday windows. Each is a multiple of a day (so window edges are also 15m/30m/4h bucket edges)
 * and well under EODHD's per-request maximum (1m: 120d, 5m: 600d, 1h: 7200d).
 */
export const WINDOW_SEC: Record<IntradayInterval, number> = {
  "1m": 3 * DAY,
  "5m": 15 * DAY,
  "1h": 120 * DAY,
};
/** Stop walking back after this much consecutive empty history (treated as "no older data"). */
const EMPTY_STOP_SEC = 14 * DAY;
/** Upper bound on upstream windows fetched for one getBars call. */
const MAX_WINDOWS_PER_CALL = 12;
const MEMORY_WINDOWS = 256;
/** Lookback of the one-off "where does the data end" probe used when recent windows are empty. */
const INTRADAY_PROBE_SEC = 120 * DAY;
const LATEST_HINT_TTL_SEC = 3600;
/** After a failed tail refresh, serve stale data for this long before retrying. */
const REFRESH_BACKOFF_SEC = 60;
/** Relative tolerance when checking whether cached adjusted closes still match upstream. */
const ADJ_TOLERANCE = 1e-5;

export interface BarCacheSettings {
  dailyTailTtlSec: number;
  intradayLatestTtlSec: number;
  intradayHistoryTtlSec: number;
}

/** Fetches raw (split/dividend-unadjusted) EOD bars; same signature as `EodhdClient.eod`. */
export type UnadjustedEodFn = (symbol: string, from?: string, to?: string, period?: EodPeriod) => Promise<Bar[]>;

/** Storage key in bars_daily(.tf) for a daily-kind timeframe: adjusted bars keep the plain tf ("1D"), raw ones get ":raw". */
export function dailyKey(tf: Timeframe, adjusted: boolean): string {
  return adjusted ? tf : `${tf}:raw`;
}

export interface BarCacheDeps {
  db: Database;
  client: Pick<EodhdClient, "eod" | "intraday">;
  /** Source for `adjusted = false` daily/weekly/monthly bars. Without it, unadjusted requests fall back to adjusted data. */
  unadjustedEod?: UnadjustedEodFn;
  settings: BarCacheSettings;
  /** Unix seconds. */
  now?: () => number;
  log?: (msg: string) => void;
}

interface BarRow { time: number; open: number; high: number; low: number; close: number; volume: number }
interface MetaRow { fetched_at: number }

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function isoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** First day of the tail to re-download, aligned so w/m periods start on a period boundary. */
export function tailFrom(lastTime: number, period: EodPeriod): number {
  if (period === "d") return lastTime - 7 * DAY;
  if (period === "w") return lastTime - 14 * DAY; // weekly bars are stamped on Mondays
  const d = new Date(lastTime * 1000); // monthly bars are stamped on the 1st
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1) / 1000;
}

export class BarCache {
  private readonly db: Database;
  private readonly client: BarCacheDeps["client"];
  private readonly unadjustedEod: UnadjustedEodFn | undefined;
  private readonly settings: BarCacheSettings;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly refreshes = new InFlight();
  private readonly windows = new InFlight();
  private readonly memory = new Map<string, { bars: Bar[]; expires: number }>();
  private readonly failedAt = new Map<string, number>();
  private readonly latestHints = new Map<string, { time: number | null; expires: number }>();

  constructor(deps: BarCacheDeps) {
    this.db = deps.db;
    this.client = deps.client;
    this.unadjustedEod = deps.unadjustedEod;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = deps.log ?? ((m) => console.warn(`[bars] ${m}`));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bars_daily (
        symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
        PRIMARY KEY (symbol, tf, time)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS bars_daily_meta (
        symbol TEXT NOT NULL, tf TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, tf)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * `adjusted` (default true) only affects 1D/1W/1M: false serves raw as-traded OHLCV, cached separately
   * under `dailyKey(tf, false)` so both variants tail-refresh independently. Intraday ignores it.
   */
  async getBars(symbolIn: string, tf: Timeframe, to?: number, limitIn = DEFAULT_LIMIT, adjusted = true): Promise<BarsResponse> {
    const symbol = normalizeSymbol(symbolIn);
    const spec = TF_SPEC[tf];
    if (!spec) throw Object.assign(new Error(`unsupported timeframe ${tf}`), { status: 400 });
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitIn) || DEFAULT_LIMIT));
    const cutoff = to !== undefined && Number.isFinite(to) ? to : undefined;
    const res =
      spec.kind === "daily"
        ? await this.dailyBars(symbol, dailyKey(tf, adjusted || !this.unadjustedEod), spec.period, cutoff, limit)
        : await this.intradayBars(symbol, spec.interval, spec.bucketSec, cutoff, limit);
    return { symbol, tf, ...res };
  }

  /** Drop everything cached for a symbol (all timeframes). */
  invalidate(symbolIn: string): void {
    const symbol = normalizeSymbol(symbolIn);
    this.db.query("DELETE FROM bars_daily WHERE symbol = ?").run(symbol);
    this.db.query("DELETE FROM bars_daily_meta WHERE symbol = ?").run(symbol);
    for (const k of this.memory.keys()) if (k.startsWith(`${symbol}|`)) this.memory.delete(k);
  }

  // ---------------- daily / weekly / monthly ----------------

  private async dailyBars(symbol: string, tf: string, period: EodPeriod, to: number | undefined, limit: number) {
    const meta = this.db
      .query<MetaRow, [string, string]>("SELECT fetched_at FROM bars_daily_meta WHERE symbol = ? AND tf = ?")
      .get(symbol, tf);
    const last = this.lastTime(symbol, tf);
    const wantsTail = to === undefined || last === null || to > last;
    const stale = !meta || this.now() - meta.fetched_at >= this.settings.dailyTailTtlSec;
    if (!meta || (wantsTail && stale)) {
      const key = `${symbol}|${tf}`;
      const failed = this.failedAt.get(key);
      const backingOff = meta && failed !== undefined && this.now() - failed < REFRESH_BACKOFF_SEC;
      if (!backingOff) {
        try {
          await this.refreshes.run(key, () => this.refreshDaily(symbol, tf, period));
          this.failedAt.delete(key);
        } catch (e) {
          if (!meta) throw e; // nothing cached to fall back to
          this.failedAt.set(key, this.now());
          this.log(`serving cached ${symbol} ${tf}; refresh failed: ${(e as Error).message}`);
        }
      }
    }
    const rows = this.db
      .query<BarRow, [string, string, number, number]>(
        `SELECT time, open, high, low, close, volume FROM bars_daily
         WHERE symbol = ? AND tf = ? AND time < ? ORDER BY time DESC LIMIT ?`,
      )
      .all(symbol, tf, to ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const hasMore = rows.length > limit;
    const bars = rows.slice(0, limit).reverse().map(toBar);
    return { bars, hasMore };
  }

  private lastTime(symbol: string, tf: string): number | null {
    const r = this.db
      .query<{ t: number | null }, [string, string]>("SELECT MAX(time) AS t FROM bars_daily WHERE symbol = ? AND tf = ?")
      .get(symbol, tf);
    return r?.t ?? null;
  }

  /** Upstream fetch for a storage key: raw keys (":raw") use the unadjusted source. */
  private fetchEod(symbol: string, tf: string, from: string | undefined, period: EodPeriod): Promise<Bar[]> {
    if (tf.endsWith(":raw") && this.unadjustedEod) return this.unadjustedEod(symbol, from, undefined, period);
    return this.client.eod(symbol, from, undefined, period);
  }

  private async refreshDaily(symbol: string, tf: string, period: EodPeriod): Promise<void> {
    const last = this.lastTime(symbol, tf);
    if (last === null) return this.replaceDaily(symbol, tf, await this.fetchEod(symbol, tf, undefined, period));

    const from = tailFrom(last, period);
    // The first returned period may be partial (starts at `from`), so it is neither compared nor stored.
    const tail = (await this.fetchEod(symbol, tf, isoDate(from), period)).filter((b) => b.time > from);
    if (this.adjustmentsChanged(symbol, tf, tail, last)) {
      // A split or dividend re-based the adjusted history: re-download everything.
      this.log(`${symbol} ${tf}: adjusted history changed upstream, refetching full history`);
      return this.replaceDaily(symbol, tf, await this.fetchEod(symbol, tf, undefined, period));
    }
    this.db.transaction(() => {
      const ins = this.upsertStmt();
      for (const b of tail) ins.run(symbol, tf, b.time, b.open, b.high, b.low, b.close, b.volume);
      this.touchMeta(symbol, tf);
    })();
  }

  /** True when a cached, completed bar no longer matches upstream (the latest bar may legitimately differ). */
  private adjustmentsChanged(symbol: string, tf: string, tail: Bar[], last: number): boolean {
    const get = this.db.query<{ close: number }, [string, string, number]>(
      "SELECT close FROM bars_daily WHERE symbol = ? AND tf = ? AND time = ?",
    );
    for (const b of tail) {
      if (b.time >= last) continue;
      const cached = get.get(symbol, tf, b.time);
      if (!cached) continue;
      const denom = Math.max(Math.abs(cached.close), 1e-12);
      if (Math.abs(cached.close - b.close) / denom > ADJ_TOLERANCE) return true;
    }
    return false;
  }

  private replaceDaily(symbol: string, tf: string, bars: Bar[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM bars_daily WHERE symbol = ? AND tf = ?").run(symbol, tf);
      const ins = this.upsertStmt();
      for (const b of bars) ins.run(symbol, tf, b.time, b.open, b.high, b.low, b.close, b.volume);
      this.touchMeta(symbol, tf);
    })();
  }

  private upsertStmt() {
    return this.db.query<unknown, [string, string, number, number, number, number, number, number]>(
      `INSERT OR REPLACE INTO bars_daily (symbol, tf, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  private touchMeta(symbol: string, tf: string): void {
    this.db
      .query("INSERT OR REPLACE INTO bars_daily_meta (symbol, tf, fetched_at) VALUES (?, ?, ?)")
      .run(symbol, tf, this.now());
  }

  // ---------------- intraday ----------------

  private async intradayBars(
    symbol: string,
    interval: IntradayInterval,
    bucketSec: number | undefined,
    to: number | undefined,
    limit: number,
  ) {
    const now = this.now();
    const anchor = Math.min(to === undefined ? now : to - 1, now);
    const first = await this.walk(symbol, interval, bucketSec, anchor, to, limit);
    if (first.bars.length || to !== undefined) return first;
    // Nothing recent: EODHD feeds are sometimes stale by weeks (e.g. crypto 1m). Look up the most
    // recent data once and walk back from there instead of reporting "no data".
    const latest = await this.latestIntraday(symbol, interval);
    if (latest === null || latest >= anchor - EMPTY_STOP_SEC) return first;
    return this.walk(symbol, interval, bucketSec, latest, to, limit);
  }

  /** Walk aligned windows backwards from `anchor` until more than `limit` bars (after aggregation) are found. */
  private async walk(
    symbol: string,
    interval: IntradayInterval,
    bucketSec: number | undefined,
    anchor: number,
    to: number | undefined,
    limit: number,
  ): Promise<{ bars: Bar[]; hasMore: boolean }> {
    const span = WINDOW_SEC[interval];
    const end = to === undefined ? Infinity : to;
    let start = Math.floor(anchor / span) * span;
    const emptyStop = Math.max(2, Math.ceil(EMPTY_STOP_SEC / span));

    const chunks: Bar[][] = [];
    let emptyRun = 0;
    let fetched = 0;
    let hasMore: boolean;
    let result: Bar[] = [];
    for (;;) {
      const w = await this.window(symbol, interval, start);
      fetched++;
      emptyRun = w.length ? 0 : emptyRun + 1;
      chunks.unshift(w);
      if (w.length) {
        const native = chunks.flat().filter((b) => b.time < end);
        result = bucketSec ? aggregate(native, bucketSec) : native;
      }
      // Windows start on bucket boundaries, so the oldest aggregated bucket is always complete.
      if (result.length > limit) { hasMore = true; break; }
      if (emptyRun >= emptyStop) { hasMore = false; break; }
      if (fetched >= MAX_WINDOWS_PER_CALL) { hasMore = result.length > 0; break; }
      start -= span;
    }
    return { bars: result.slice(-limit), hasMore };
  }

  /**
   * Timestamp of the newest intraday bar within EODHD's max lookback, or null. The probe response
   * also seeds the window cache for every window it fully covers, so the follow-up walk is free.
   */
  private latestIntraday(symbol: string, interval: IntradayInterval): Promise<number | null> {
    const key = `${symbol}|${interval}`;
    const hint = this.latestHints.get(key);
    const now = this.now();
    if (hint && hint.expires > now) return Promise.resolve(hint.time);
    return this.windows.run(`latest|${key}`, async () => {
      const span = WINDOW_SEC[interval];
      const from = now - Math.min(INTRADAY_PROBE_SEC, INTRADAY_MAX_RANGE_SEC[interval]);
      const bars = await this.client.intraday(symbol, interval, from, now);
      const latest = bars.length ? bars[bars.length - 1].time : null;
      const byWindow = new Map<number, Bar[]>();
      for (let w = Math.ceil(from / span) * span; w + span <= now; w += span) byWindow.set(w, []);
      for (const b of bars) byWindow.get(Math.floor(b.time / span) * span)?.push(b);
      for (const [w, list] of byWindow) this.remember(`${key}|${w}`, list, this.ttlFor(w + span));
      this.latestHints.set(key, { time: latest, expires: now + LATEST_HINT_TTL_SEC });
      return latest;
    });
  }

  private ttlFor(endExclusive: number): number {
    const t = this.now();
    if (endExclusive > t) return this.settings.intradayLatestTtlSec;
    if (endExclusive > t - DAY) return Math.min(600, this.settings.intradayHistoryTtlSec);
    return this.settings.intradayHistoryTtlSec;
  }

  private remember(key: string, bars: Bar[], ttl: number): void {
    this.memory.delete(key);
    this.memory.set(key, { bars, expires: this.now() + ttl });
    while (this.memory.size > MEMORY_WINDOWS) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  /** One aligned window [start, start+span), cached in memory and de-duplicated in flight. */
  private window(symbol: string, interval: IntradayInterval, start: number): Promise<Bar[]> {
    const span = WINDOW_SEC[interval];
    const key = `${symbol}|${interval}|${start}`;
    const hit = this.memory.get(key);
    const now = this.now();
    if (hit && hit.expires > now) {
      this.memory.delete(key); // LRU: move to the back
      this.memory.set(key, hit);
      return Promise.resolve(hit.bars);
    }
    return this.windows.run(key, async () => {
      const endExclusive = start + span;
      const raw = await this.client.intraday(symbol, interval, start, endExclusive - 1);
      const bars = raw.filter((b) => b.time >= start && b.time < endExclusive);
      this.remember(key, bars, this.ttlFor(endExclusive));
      return bars;
    });
  }
}

function toBar(r: BarRow): Bar {
  return { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
}
