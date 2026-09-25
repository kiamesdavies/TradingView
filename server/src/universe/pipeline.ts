// The universe scheduler: one loop, one job slice at a time. Every ~60s (or immediately after a slice that has
// more work) it picks the first due job instance in priority order. Market-scoped jobs run as one instance per
// enabled market ("prices:ST"), each on its own market's calendar (prices ~2.5 h after that market's close).
// Long jobs (backfill, fundamentals) work in slices so daily price updates and metric refreshes interleave.
// Budget exhaustion pauses an instance until midnight UTC.
import type { Database } from "bun:sqlite";
import type { MarketInfo, UniverseJobStatus, UniverseStatus } from "@eodview/shared";
import { BudgetExhausted, CreditGuard, type AccountUsage } from "./credits";
import {
  backfillPlan,
  DEFAULT_LOW_PRIORITY_RESERVE,
  fundamentalsQueue,
  fxMissing,
  JOB_NAMES,
  MARKET_JOBS,
  pricesNextRun,
  RUNNERS,
  type Api,
  type JobCtx,
  type JobName,
  type JobResult,
} from "./jobs";
import { getMarket, MARKETS, type MarketDef } from "./markets";
import { Limiter, type RetryOptions } from "./ratelimit";
import { initUniverseSchema, kvGet } from "./schema";
import { countActive, hasDirty, holidays, latestDate, latestDateAny, markAllDirty, sessionCount } from "./store";
import { utcDate } from "./util";

export interface PipelineDeps {
  db: Database;
  api: Api;
  getUsage(): Promise<AccountUsage>;
  refreshFundamentals(symbol: string): Promise<Record<string, any>>;
  externallyRefreshed?(limit: number): Array<{ symbol: string; data: Record<string, any>; fetchedAt: number }>;
  getKey(): string | null;
  onKeyChange?(cb: (key: string | null) => void): () => void;
  /** Enabled market codes (re-read every loop so a settings change applies without a restart). Default ["US"]. */
  markets?: () => string[];
  now?: () => number;
  historyYears?: number;
  backfillMaxSymbols?: number | null;
  fundamentalsMaxPerRun?: number;
  /** Credits backfill/fundamentals leave unused for the daily jobs (default 3000). */
  lowPriorityReserve?: number;
  bulkActionMarkets?: string[];
  ratePerMin?: number;
  concurrency?: number;
  retry?: RetryOptions;
  dailyBudget?: number;
  creditReserve?: number;
  tickMs?: number;
  log?: (msg: string) => void;
}

interface JobRow {
  name: string;
  last_run_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  progress: string | null;
  next_run_at: number | null;
  next_mode: "override" | "notBefore" | null;
}

/** One schedulable unit: a global job or a market-scoped job for one market. */
export interface JobInstance { key: string; job: JobName; market: MarketDef | null }

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const sec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000));

/** Instances in priority order for the enabled markets. */
export function jobInstances(markets: MarketDef[]): JobInstance[] {
  const out: JobInstance[] = [];
  for (const job of JOB_NAMES) {
    if (MARKET_JOBS.has(job)) for (const m of markets) out.push({ key: `${job}:${m.code}`, job, market: m });
    else out.push({ key: job, job, market: null });
  }
  return out;
}

/** "prices" → every enabled instance of the job; "prices:ST" → that one. Unknown → []. */
export function resolveJobName(name: string, markets: MarketDef[]): JobInstance[] {
  const [job, mk] = name.split(":") as [string, string | undefined];
  if (!(JOB_NAMES as string[]).includes(job)) return [];
  const all = jobInstances(markets).filter((i) => i.job === job);
  if (mk === undefined) return all;
  return all.filter((i) => i.market?.code === mk.toUpperCase());
}

export class UniversePipeline {
  readonly db: Database;
  readonly credits: CreditGuard;
  readonly limiter: Limiter;
  private deps: PipelineDeps;
  private now: () => number;
  private tickMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: string | null = null;
  private manual: string[] = [];
  private started = false;
  private errorStreak = new Map<string, number>();
  private log: (msg: string) => void;
  private unsubscribeKey: (() => void) | null = null;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? 60_000;
    this.log = deps.log ?? ((m) => console.log(`[universe] ${m}`));
    initUniverseSchema(this.db);
    this.credits = new CreditGuard(this.db, {
      budget: deps.dailyBudget ?? 40000,
      reserve: deps.creditReserve ?? 15000,
      getUsage: deps.getUsage,
      now: this.now,
    });
    this.limiter = new Limiter({ ratePerMin: deps.ratePerMin ?? 800, concurrency: deps.concurrency ?? 8 });
  }

  /** Enabled markets (registry order). */
  markets(): MarketDef[] {
    const codes = this.deps.markets?.() ?? ["US"];
    const out = MARKETS.filter((m) => codes.includes(m.code));
    return out.length ? out : [MARKETS[0]!];
  }

  /** Markets whose splits/dividends come from EODHD's bulk lists (EODVIEW_ACTIONS_BULK_MARKETS, default US). */
  bulkActionMarkets(): ReadonlySet<string> {
    return new Set(this.deps.bulkActionMarkets ?? ["US"]);
  }

  instances(): JobInstance[] {
    return jobInstances(this.markets());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeKey =
      this.deps.onKeyChange?.((key) => {
        if (!key) return;
        // New key: forget error back-offs so work resumes right away.
        this.errorStreak.clear();
        this.db.exec("UPDATE universe_jobs SET next_run_at = NULL, next_mode = NULL WHERE next_mode = 'notBefore' AND last_error IS NOT NULL");
        this.kick();
      }) ?? null;
    this.schedule(1000);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribeKey?.();
  }

  /** Manual trigger ("prices" = all enabled markets, or "prices:ST"): queued; runs in the background. */
  runJob(name: string): void {
    const inst = resolveJobName(name, this.markets());
    if (!inst.length) throw new Error(`unknown job ${name}`);
    if (inst.some((i) => i.job === "metrics")) markAllDirty(this.db);
    if (!this.started) {
      // Loop not running (EODVIEW_UNIVERSE=off): run the instances once, in the background.
      void (async () => {
        for (const i of inst) await this.execute(i.key);
      })();
      return;
    }
    for (const i of inst) if (!this.manual.includes(i.key)) this.manual.push(i.key);
    this.kick();
  }

  private kick(): void {
    if (!this.started || this.running) return;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop(): Promise<void> {
    this.timer = null;
    if (this.running) return;
    let next = this.tickMs;
    try {
      if (this.deps.getKey()) {
        const key = this.pickJob();
        if (key) {
          const r = await this.execute(key);
          if (r !== "idle") next = 50; // look for more work right away
        }
      }
    } catch (e) {
      this.log(`loop error: ${(e as Error).message}`);
    }
    this.schedule(next);
  }

  private row(key: string): JobRow {
    return (
      this.db.query<JobRow, [string]>("SELECT * FROM universe_jobs WHERE name = ?").get(key) ?? {
        name: key, last_run_at: null, last_success_at: null, last_error: null, progress: null, next_run_at: null, next_mode: null,
      }
    );
  }

  private instance(key: string): JobInstance | null {
    const [job, mk] = key.split(":") as [JobName, string | undefined];
    if (!(JOB_NAMES as string[]).includes(job)) return null;
    if (MARKET_JOBS.has(job)) {
      const m = mk ? getMarket(mk) : undefined;
      return m ? { key, job, market: m } : null;
    }
    return { key, job, market: null };
  }

  /** Natural next run (ms) from the data itself; null = nothing to do. */
  computedNext(key: string): number | null {
    const inst = this.instance(key);
    if (!inst) return null;
    const now = this.now();
    const r = this.row(key);
    const lastOk = r.last_success_at === null ? null : r.last_success_at * 1000;
    const m = inst.market;
    const markets = this.markets();
    if (inst.job === "symbols") return lastOk === null ? now : lastOk + 7 * DAY;
    if (m ? countActive(this.db, m.code) === 0 : countActive(this.db) === 0) return null;
    switch (inst.job) {
      case "prices": {
        const lastAttempt = Number(kvGet(this.db, `prices_last_attempt:${m!.code}`) ?? 0) || null;
        return pricesNextRun(now, latestDate(this.db, m!.code), holidays(this.db, m!.code), lastAttempt, m!);
      }
      case "fx":
        if (fxMissing(this.db, markets)) return lastOk !== null && now - lastOk < HOUR ? lastOk + HOUR : now;
        return lastOk === null ? now : lastOk + 20 * HOUR;
      case "earnings": {
        if (lastOk === null) return now;
        const today = utcDate(now);
        return utcDate(lastOk) !== today ? now : Date.parse(`${today}T00:10:00Z`) + DAY;
      }
      case "indices":
        if (!m!.indices.length) return null;
        return lastOk === null ? now : lastOk + 7 * DAY;
      case "news":
        return lastOk === null ? now : lastOk + 2 * HOUR;
      case "metrics":
        return hasDirty(this.db) ? now : null;
      case "backfill":
        return backfillPlan(
          { db: this.db, now: this.now, backfillMaxSymbols: this.deps.backfillMaxSymbols ?? null, bulkActionMarkets: this.bulkActionMarkets() },
          m!.code, 1,
        ).todo.length ? now : null;
      case "fundamentals": {
        if (!latestDateAny(this.db, markets.map((x) => x.code))) return null;
        const pending =
          fundamentalsQueue(this.db, now, utcDate(now), 1, markets.map((x) => x.code)).length > 0 || (this.deps.externallyRefreshed?.(1).length ?? 0) > 0;
        return pending ? now : now + HOUR;
      }
      default:
        return null;
    }
  }

  /** Effective next run combining the data-driven time with explicit schedules / back-offs. */
  nextRun(key: string): number | null {
    const r = this.row(key);
    const stored = r.next_run_at === null ? null : r.next_run_at * 1000;
    if (stored !== null && r.next_mode === "override") return stored;
    const computed = this.computedNext(key);
    if (stored !== null && r.next_mode === "notBefore") return computed === null ? null : Math.max(computed, stored);
    return computed;
  }

  /** Run due jobs back to back until nothing is due (tests / one-shot use). Returns the instances run. */
  async runPending(maxSlices = 100): Promise<string[]> {
    const ran: string[] = [];
    for (let i = 0; i < maxSlices; i++) {
      if (!this.deps.getKey()) break;
      const key = this.pickJob();
      if (!key) break;
      ran.push(key);
      if ((await this.execute(key)) !== "ok") break;
    }
    return ran;
  }

  private pickJob(): string | null {
    if (this.manual.length) return this.manual.shift()!;
    for (const inst of this.instances()) {
      const at = this.nextRun(inst.key);
      // Read the clock after nextRun(): "due now" is computed from a later now() call, so comparing with a
      // timestamp taken before it made every data-driven job look a few ms in the future and never run.
      if (at !== null && at <= this.now()) return inst.key;
    }
    return null;
  }

  private setRow(key: string, patch: Partial<Omit<JobRow, "name">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.query("INSERT OR IGNORE INTO universe_jobs (name) VALUES (?)").run(key);
    this.db
      .query(`UPDATE universe_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE name = ?`)
      .run(...(keys.map((k) => patch[k] ?? null) as (string | number | null)[]), key);
  }

  /** Job context bound to this pipeline (also used by one-off scripts). `key` is "prices:ST", "fx", ... */
  context(key: string): JobCtx {
    const inst = this.instance(key);
    if (!inst) throw new Error(`unknown job instance ${key}`);
    return {
      db: this.db,
      api: this.deps.api,
      credits: this.credits,
      refreshFundamentals: this.deps.refreshFundamentals,
      externallyRefreshed: this.deps.externallyRefreshed,
      now: this.now,
      markets: this.markets(),
      market: inst.market,
      historyYears: this.deps.historyYears ?? 5,
      backfillMaxSymbols: this.deps.backfillMaxSymbols ?? null,
      fundamentalsMaxPerRun: this.deps.fundamentalsMaxPerRun ?? 500,
      lowPriorityReserve: this.deps.lowPriorityReserve ?? DEFAULT_LOW_PRIORITY_RESERVE,
      bulkActionMarkets: this.bulkActionMarkets(),
      limiter: this.limiter,
      retry: this.deps.retry,
      progress: (text) => this.setRow(key, { progress: text }),
      yieldNow: () => Bun.sleep(0),
      job: inst.job,
      jobKey: key,
    };
  }

  /** Run one slice of a job instance. Returns "idle" when nothing was done. */
  async execute(key: string): Promise<"ok" | "paused" | "error" | "idle"> {
    if (this.running) return "idle";
    const inst = this.instance(key);
    if (!inst) return "idle";
    this.running = key;
    const started = this.now();
    this.setRow(key, { last_run_at: sec(started), progress: "starting" });
    try {
      const res: JobResult = await RUNNERS[inst.job](this.context(key));
      this.errorStreak.delete(key);
      this.setRow(key, {
        last_success_at: sec(this.now()),
        last_error: null,
        progress: res.note ?? null,
        next_run_at: res.nextRunAt === undefined || res.nextRunAt === null ? null : sec(res.nextRunAt),
        next_mode: res.nextRunAt === undefined || res.nextRunAt === null ? null : "override",
      });
      if (res.note) this.log(`${key}: ${res.note} (${((this.now() - started) / 1000).toFixed(1)}s)`);
      return "ok";
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        const at = new Date(e.resumesAt).toISOString().slice(0, 16).replace("T", " ");
        const prev = this.row(key).progress;
        this.setRow(key, {
          progress: `budget exhausted, resumes ${at} UTC${prev && !prev.startsWith("budget") ? ` (${prev})` : ""}`,
          last_error: null,
          next_run_at: sec(e.resumesAt),
          next_mode: "notBefore",
        });
        this.log(`${key}: paused — ${e.message}`);
        return "paused";
      }
      const streak = (this.errorStreak.get(key) ?? 0) + 1;
      this.errorStreak.set(key, streak);
      const backoff = Math.min(HOUR, 5 * 60_000 * 2 ** (streak - 1));
      this.setRow(key, {
        last_error: (e as Error)?.message ?? String(e),
        next_run_at: sec(this.now() + backoff),
        next_mode: "notBefore",
      });
      this.log(`${key} failed: ${(e as Error)?.message ?? e}`);
      return "error";
    } finally {
      this.running = null;
    }
  }

  /** Per-market summary for every registry market (enabled flag from the current setting). */
  listMarkets(): MarketInfo[] {
    const db = this.db;
    const enabled = new Set(this.markets().map((m) => m.code));
    const group = (sql: string) => new Map(db.query<{ market: string; n: number }, []>(sql).all().map((r) => [r.market, r.n]));
    const symbols = group("SELECT market, COUNT(*) AS n FROM universe_symbols WHERE active = 1 GROUP BY market");
    const withPrices = group("SELECT market, COUNT(*) AS n FROM universe_metrics WHERE price IS NOT NULL GROUP BY market");
    const withFund = group(
      "SELECT s.market, COUNT(*) AS n FROM universe_fund f JOIN universe_symbols s ON s.symbol = f.symbol WHERE s.active = 1 AND f.data IS NOT NULL GROUP BY s.market",
    );
    return MARKETS.map((m) => ({
      code: m.code,
      name: m.name,
      country: m.country,
      currency: m.currency,
      timezone: m.timezone,
      enabled: enabled.has(m.code),
      symbols: symbols.get(m.code) ?? 0,
      withPrices: withPrices.get(m.code) ?? 0,
      withFundamentals: withFund.get(m.code) ?? 0,
      lastPriceDate: latestDate(db, m.code),
    }));
  }

  status(): UniverseStatus & { markets: Array<MarketInfo & { historyDays: number; histories: number; creditsToday: number }> } {
    const hasKey = !!this.deps.getKey();
    const db = this.db;
    const markets = this.markets();
    const codes = markets.map((m) => m.code);
    const jobs: UniverseJobStatus[] = this.instances().map((inst) => {
      const r = this.row(inst.key);
      let state: UniverseJobStatus["state"] = "idle";
      if (!hasKey) state = "disabled";
      else if (this.running === inst.key) state = "running";
      else if (r.last_error) state = "error";
      let nextRunAt: number | null = null;
      try {
        nextRunAt = hasKey ? sec(this.nextRun(inst.key)) : null;
      } catch {
        nextRunAt = null;
      }
      return {
        name: inst.key,
        state,
        lastRunAt: r.last_run_at,
        lastError: r.last_error,
        progress: !hasKey ? "no EODHD API key configured" : r.progress,
        nextRunAt,
      };
    });
    const byMarket = this.credits.byMarketToday();
    const histories = new Map(
      db.query<{ market: string; n: number }, []>("SELECT market, COUNT(*) AS n FROM universe_long WHERE status IN ('ok', 'stale') GROUP BY market").all().map((r) => [r.market, r.n]),
    );
    const info = this.listMarkets().filter((m) => m.enabled);
    const perMarket = info.map((m) => ({
      ...m,
      historyDays: sessionCount(db, m.code),
      histories: histories.get(m.code) ?? 0,
      creditsToday: byMarket[m.code] ?? 0,
    }));
    return {
      symbols: info.reduce((s, m) => s + m.symbols, 0),
      withPrices: info.reduce((s, m) => s + m.withPrices, 0),
      withFundamentals: info.reduce((s, m) => s + m.withFundamentals, 0),
      lastPriceDate: latestDateAny(db, codes),
      historyDays: perMarket.reduce((s, m) => Math.max(s, m.historyDays), 0),
      creditsUsedToday: this.credits.usedToday(),
      dailyCreditBudget: this.credits.budget,
      jobs,
      markets: perMarket,
    };
  }
}
