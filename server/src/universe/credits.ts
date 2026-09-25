// API-credit ledger + budget guard. Two limits apply before every costly batch:
//  1. our own ledger for today (UTC) must stay within EODVIEW_DAILY_CREDIT_BUDGET;
//  2. the account's real usage (eodhd.user(), checked at most every 5 minutes) must stay below
//     dailyRateLimit - reserve, because the plan's credits are shared with the user's other tools.
// EODHD resets usage at midnight UTC, so a paused job resumes then.
import type { Database } from "bun:sqlite";
import { nextUtcMidnight } from "./calendar";
import { utcDate } from "./util";

/** Credit cost per EODHD call type (EODHD pricing). */
export const COST = {
  bulk: 100,
  fundamentals: 10,
  indexComponents: 10,
  news: 5,
  calendar: 1,
  symbolList: 1,
  eod: 1,
} as const;

export class BudgetExhausted extends Error {
  constructor(public resumesAt: number, reason: string) {
    super(reason);
    this.name = "BudgetExhausted";
  }
}

export interface AccountUsage { apiRequests?: number; dailyRateLimit?: number }

export interface CreditGuardOptions {
  budget: number;
  /** Credits kept free for the user's other work (account-level check). */
  reserve?: number;
  userCheckIntervalMs?: number;
  getUsage?: () => Promise<AccountUsage>;
  now?: () => number;
}

export class CreditGuard {
  readonly budget: number;
  private reserve: number;
  private interval: number;
  private getUsage?: () => Promise<AccountUsage>;
  private now: () => number;
  private lastCheck = 0;
  private lastUsage: AccountUsage | null = null;
  /** Credits spent since the last account check (so the cached usage is extrapolated, not stale). */
  private sinceCheck = 0;

  constructor(private db: Database, o: CreditGuardOptions) {
    this.budget = o.budget;
    this.reserve = o.reserve ?? 15000;
    this.interval = o.userCheckIntervalMs ?? 5 * 60_000;
    this.getUsage = o.getUsage;
    this.now = o.now ?? Date.now;
  }

  usedToday(): number {
    const row = this.db
      .query<{ n: number | null }, [string]>("SELECT SUM(credits) AS n FROM universe_credits WHERE date = ?")
      .get(utcDate(this.now()));
    return row?.n ?? 0;
  }

  byJobToday(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .query<{ job: string; credits: number }, [string]>("SELECT job, credits FROM universe_credits WHERE date = ?")
      .all(utcDate(this.now()))) out[r.job] = r.credits;
    return out;
  }

  record(job: string, credits: number, calls = 1): void {
    this.db
      .query(
        `INSERT INTO universe_credits (date, job, credits, calls) VALUES (?, ?, ?, ?)
         ON CONFLICT(date, job) DO UPDATE SET credits = credits + excluded.credits, calls = calls + excluded.calls`,
      )
      .run(utcDate(this.now()), job, credits, calls);
    this.sinceCheck += credits;
  }

  /** Throws BudgetExhausted when spending `credits` more would exceed either limit. */
  async ensure(credits: number): Promise<void> {
    const resume = nextUtcMidnight(this.now());
    const used = this.usedToday();
    if (used + credits > this.budget) {
      throw new BudgetExhausted(resume, `daily credit budget reached (${used}/${this.budget})`);
    }
    if (!this.getUsage) return;
    const now = this.now();
    if (!this.lastUsage || now - this.lastCheck >= this.interval || utcDate(now) !== utcDate(this.lastCheck)) {
      try {
        this.lastUsage = await this.getUsage();
        this.lastCheck = now;
        this.sinceCheck = 0;
      } catch {
        // Account check failed (network etc.): rely on our own ledger until the next check.
        this.lastCheck = now;
        this.lastUsage = this.lastUsage ?? {};
      }
    }
    const req = this.lastUsage.apiRequests, limit = this.lastUsage.dailyRateLimit;
    if (typeof req === "number" && typeof limit === "number" && limit > 0) {
      const projected = req + this.sinceCheck + credits;
      if (projected > limit - this.reserve) {
        throw new BudgetExhausted(resume, `account usage near the daily limit (${req + this.sinceCheck}/${limit}, keeping ${this.reserve} free)`);
      }
    }
  }
}
