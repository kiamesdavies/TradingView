// Daily credit cap for EODHD calls triggered by agent requests (REST /api/v1 and MCP): symbol overview
// (fundamentals), news, remote search, uncached bars… Every upstream request made while serving an agent request is
// recorded in the universe credit ledger (universe_credits, job "agent", so it also counts toward the pipeline's
// EODVIEW_DAILY_CREDIT_BUDGET) and refused with 429 once EODVIEW_AGENT_CREDIT_BUDGET (default 5000) is spent for
// the UTC day. EODHD resets usage at midnight UTC.
import type { Database } from "bun:sqlite";
import { callMeter, eodhdCallCost, type CallMeter } from "../eodhd/meter";
import type { QueryValue } from "../eodhd/request";
import { AgentError } from "./errors";

export const AGENT_LEDGER_JOB = "agent";
export const DEFAULT_AGENT_CREDIT_BUDGET = 5000;

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface AgentCreditOpts {
  /** Credits per UTC day; 0 = agents may not trigger any paid EODHD call. */
  budget: number;
  nowMs?: () => number;
}

export function createAgentCredits(db: Database, opts: AgentCreditOpts) {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const budget = Math.max(0, Math.floor(opts.budget));
  db.exec(`CREATE TABLE IF NOT EXISTS universe_credits (
    date TEXT NOT NULL, job TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, job)
  )`);
  const usedQ = db.query<{ credits: number }, [string, string]>("SELECT credits FROM universe_credits WHERE date = ? AND job = ?");
  const addQ = db.query(
    `INSERT INTO universe_credits (date, job, credits, calls) VALUES (?, ?, ?, 1)
     ON CONFLICT(date, job) DO UPDATE SET credits = credits + excluded.credits, calls = calls + 1`,
  );

  function usedToday(): number {
    return usedQ.get(utcDate(nowMs()), AGENT_LEDGER_JOB)?.credits ?? 0;
  }

  const meter: CallMeter = {
    charge(path: string, params: Record<string, QueryValue>): void {
      const cost = eodhdCallCost(path, params);
      if (cost <= 0) return;
      const t = nowMs();
      const used = usedToday();
      if (used + cost > budget) {
        const d = new Date(t);
        const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        throw new AgentError(
          429, "agent credit budget exhausted",
          `agent requests used ${used} of ${budget} EODHD credits today (EODVIEW_AGENT_CREDIT_BUDGET); resets at midnight UTC. Local data (screen, filters, markets, local search) still works.`,
          { "retry-after": String(Math.max(1, Math.ceil((midnight - t) / 1000))) },
        );
      }
      addQ.run(utcDate(t), AGENT_LEDGER_JOB, cost);
    },
  };

  return {
    budget,
    usedToday,
    /** Run `fn` (and everything it awaits) with EODHD calls charged to the agent budget. */
    run<T>(fn: () => T): T {
      return callMeter.run(meter, fn);
    },
  };
}
export type AgentCredits = ReturnType<typeof createAgentCredits>;
