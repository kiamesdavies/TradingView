// The universe scheduler: one loop, one job at a time. Every ~60s (or immediately after a job that has more
// work) it picks the first due job in priority order. Long jobs (backfill, fundamentals) work in slices so the
// daily price update and metric refreshes interleave. Budget exhaustion pauses a job until midnight UTC.
import type { Database } from "bun:sqlite";
import type { UniverseJobStatus, UniverseStatus } from "@eodview/shared";
import { nyParts, nyWallToUtc } from "./calendar";
import { BudgetExhausted, CreditGuard, type AccountUsage } from "./credits";
import {
  fundamentalsQueue,
  JOB_NAMES,
  missingSessions,
  pricesNextRun,
  RUNNERS,
  type Api,
  type JobCtx,
  type JobName,
  type JobResult,
} from "./jobs";
import { initUniverseSchema, kvGet } from "./schema";
import { countActive, hasDirty, holidays, latestDate, markAllDirty, MIN_ROWS_PER_DATE } from "./store";
import { addDays } from "./util";

export interface PipelineDeps {
  db: Database;
  api: Api;
  getUsage(): Promise<AccountUsage>;
  refreshFundamentals(symbol: string): Promise<Record<string, any>>;
  externallyRefreshed?(limit: number): Array<{ symbol: string; data: Record<string, any>; fetchedAt: number }>;
  getKey(): string | null;
  onKeyChange?(cb: (key: string | null) => void): () => void;
  now?: () => number;
  historyDays?: number;
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

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const sec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000));

export class UniversePipeline {
  readonly db: Database;
  readonly credits: CreditGuard;
  private deps: PipelineDeps;
  private now: () => number;
  private historyDays: number;
  private tickMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: JobName | null = null;
  private manual: JobName[] = [];
  private started = false;
  private errorStreak = new Map<JobName, number>();
  private log: (msg: string) => void;
  private unsubscribeKey: (() => void) | null = null;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.historyDays = Math.max(1, deps.historyDays ?? 300);
    this.tickMs = deps.tickMs ?? 60_000;
    this.log = deps.log ?? ((m) => console.log(`[universe] ${m}`));
    initUniverseSchema(this.db);
    this.credits = new CreditGuard(this.db, {
      budget: deps.dailyBudget ?? 40000,
      reserve: deps.creditReserve ?? 15000,
      getUsage: deps.getUsage,
      now: this.now,
    });
    const ins = this.db.query("INSERT OR IGNORE INTO universe_jobs (name) VALUES (?)");
    for (const j of JOB_NAMES) ins.run(j);
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

  /** Manual trigger: queue the job and return; it runs in the background as soon as the loop is free. */
  runJob(name: JobName): void {
    if (!JOB_NAMES.includes(name)) throw new Error(`unknown job ${name}`);
    if (name === "metrics") markAllDirty(this.db);
    if (!this.started) {
      // Loop not running (EODVIEW_UNIVERSE=off): run just this job once, in the background.
      void this.execute(name);
      return;
    }
    if (!this.manual.includes(name)) this.manual.push(name);
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
        const job = this.pickJob();
        if (job) {
          const r = await this.execute(job);
          if (r !== "idle") next = 50; // look for more work right away
        }
      }
    } catch (e) {
      this.log(`loop error: ${(e as Error).message}`);
    }
    this.schedule(next);
  }

  private row(name: JobName): JobRow {
    return (
      this.db.query<JobRow, [string]>("SELECT * FROM universe_jobs WHERE name = ?").get(name) ?? {
        name, last_run_at: null, last_success_at: null, last_error: null, progress: null, next_run_at: null, next_mode: null,
      }
    );
  }

  /** Natural next run (ms) from the data itself; null = nothing to do. */
  computedNext(name: JobName): number | null {
    const now = this.now();
    const r = this.row(name);
    const lastOk = r.last_success_at === null ? null : r.last_success_at * 1000;
    if (name !== "symbols" && countActive(this.db) === 0) return null;
    switch (name) {
      case "symbols":
        return lastOk === null ? now : lastOk + 7 * DAY;
      case "prices": {
        const lastAttempt = Number(kvGet(this.db, "prices_last_attempt") ?? 0) || null;
        return pricesNextRun(now, latestDate(this.db), holidays(this.db), lastAttempt);
      }
      case "earnings": {
        if (lastOk === null) return now;
        const today = nyParts(now).date;
        return nyParts(lastOk).date !== today ? now : nyWallToUtc(addDays(today, 1), 0, 10);
      }
      case "indices":
        return lastOk === null ? now : lastOk + 7 * DAY;
      case "news":
        return lastOk === null ? now : lastOk + 2 * HOUR;
      case "metrics":
        return hasDirty(this.db) ? now : null;
      case "backfill": {
        const latest = latestDate(this.db);
        if (!latest) return null;
        return missingSessions(this.db, latest, this.historyDays).length ? now : null;
      }
      case "fundamentals": {
        if (!latestDate(this.db)) return null;
        const pending =
          fundamentalsQueue(this.db, now, nyParts(now).date, 1).length > 0 || (this.deps.externallyRefreshed?.(1).length ?? 0) > 0;
        return pending ? now : now + HOUR;
      }
    }
  }

  /** Effective next run combining the data-driven time with explicit schedules / back-offs. */
  nextRun(name: JobName): number | null {
    const r = this.row(name);
    const stored = r.next_run_at === null ? null : r.next_run_at * 1000;
    if (stored !== null && r.next_mode === "override") return stored;
    const computed = this.computedNext(name);
    if (stored !== null && r.next_mode === "notBefore") return computed === null ? null : Math.max(computed, stored);
    return computed;
  }

  /** Run due jobs back to back until nothing is due (tests / one-shot use). Returns the jobs run. */
  async runPending(maxSlices = 100): Promise<JobName[]> {
    const ran: JobName[] = [];
    for (let i = 0; i < maxSlices; i++) {
      if (!this.deps.getKey()) break;
      const job = this.pickJob();
      if (!job) break;
      ran.push(job);
      if ((await this.execute(job)) !== "ok") break;
    }
    return ran;
  }

  private pickJob(): JobName | null {
    if (this.manual.length) return this.manual.shift()!;
    for (const name of JOB_NAMES) {
      const at = this.nextRun(name);
      // Read the clock after nextRun(): "due now" is computed from a later now() call, so comparing with a
      // timestamp taken before it made every data-driven job look a few ms in the future and never run.
      if (at !== null && at <= this.now()) return name;
    }
    return null;
  }

  private setRow(name: JobName, patch: Partial<Omit<JobRow, "name">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db
      .query(`UPDATE universe_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE name = ?`)
      .run(...(keys.map((k) => patch[k] ?? null) as (string | number | null)[]), name);
  }

  /** Job context bound to this pipeline (also used by one-off scripts). */
  context(name: JobName): JobCtx {
    return {
      db: this.db,
      api: this.deps.api,
      credits: this.credits,
      refreshFundamentals: this.deps.refreshFundamentals,
      externallyRefreshed: this.deps.externallyRefreshed,
      now: this.now,
      historyDays: this.historyDays,
      progress: (text) => this.setRow(name, { progress: text }),
      yieldNow: () => Bun.sleep(0),
      job: name,
    };
  }

  /** Run one slice of a job. Returns "idle" when nothing was done. */
  async execute(name: JobName): Promise<"ok" | "paused" | "error" | "idle"> {
    if (this.running) return "idle";
    this.running = name;
    const started = this.now();
    this.setRow(name, { last_run_at: sec(started), progress: "starting" });
    const ctx = this.context(name);
    try {
      const res: JobResult = await RUNNERS[name](ctx);
      this.errorStreak.delete(name);
      this.setRow(name, {
        last_success_at: sec(this.now()),
        last_error: null,
        progress: res.note ?? null,
        next_run_at: res.nextRunAt === undefined || res.nextRunAt === null ? null : sec(res.nextRunAt),
        next_mode: res.nextRunAt === undefined || res.nextRunAt === null ? null : "override",
      });
      if (res.note) this.log(`${name}: ${res.note} (${((this.now() - started) / 1000).toFixed(1)}s)`);
      return "ok";
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        const at = new Date(e.resumesAt).toISOString().slice(0, 16).replace("T", " ");
        const prev = this.row(name).progress;
        this.setRow(name, {
          progress: `budget exhausted, resumes ${at} UTC${prev && !prev.startsWith("budget") ? ` (${prev})` : ""}`,
          last_error: null,
          next_run_at: sec(e.resumesAt),
          next_mode: "notBefore",
        });
        this.log(`${name}: paused — ${e.message}`);
        return "paused";
      }
      const streak = (this.errorStreak.get(name) ?? 0) + 1;
      this.errorStreak.set(name, streak);
      const backoff = Math.min(HOUR, 5 * 60_000 * 2 ** (streak - 1));
      this.setRow(name, {
        last_error: (e as Error)?.message ?? String(e),
        next_run_at: sec(this.now() + backoff),
        next_mode: "notBefore",
      });
      this.log(`${name} failed: ${(e as Error)?.message ?? e}`);
      return "error";
    } finally {
      this.running = null;
    }
  }

  status(): UniverseStatus {
    const hasKey = !!this.deps.getKey();
    const db = this.db;
    const one = (sql: string) => db.query<{ n: number | null }, []>(sql).get()?.n ?? 0;
    const jobs: UniverseJobStatus[] = JOB_NAMES.map((name) => {
      const r = this.row(name);
      let state: UniverseJobStatus["state"] = "idle";
      if (!hasKey) state = "disabled";
      else if (this.running === name) state = "running";
      else if (r.last_error) state = "error";
      let nextRunAt: number | null = null;
      try {
        nextRunAt = hasKey ? sec(this.nextRun(name)) : null;
      } catch {
        nextRunAt = null;
      }
      return {
        name,
        state,
        lastRunAt: r.last_run_at,
        lastError: r.last_error,
        progress: !hasKey ? "no EODHD API key configured" : r.progress,
        nextRunAt,
      };
    });
    return {
      symbols: countActive(db),
      withPrices: one("SELECT COUNT(*) AS n FROM universe_metrics WHERE price IS NOT NULL"),
      withFundamentals: one(
        "SELECT COUNT(*) AS n FROM universe_fund f JOIN universe_symbols s ON s.symbol = f.symbol WHERE s.active = 1 AND f.data IS NOT NULL",
      ),
      lastPriceDate: latestDate(db),
      historyDays: db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM universe_dates WHERE rows >= ?").get(MIN_ROWS_PER_DATE)?.n ?? 0,
      creditsUsedToday: this.credits.usedToday(),
      dailyCreditBudget: this.credits.budget,
      jobs,
    };
  }
}
