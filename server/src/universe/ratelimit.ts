// Request pacing for EODHD (pure-ish, clock and sleep injectable; see ratelimit.test.ts).
// EODHD allows 1000 requests per minute; the pipeline stays well under with a token bucket (default 800/min),
// a concurrency cap (default 8) and retries with exponential back-off on 429 / 5xx / network errors.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/** Token bucket: `ratePerMin` tokens per minute, up to `burst` stored. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly perMs: number;
  constructor(readonly ratePerMin: number, readonly burst: number, private clock: Clock = realClock) {
    this.perMs = ratePerMin / 60_000;
    this.tokens = burst;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perMs);
      this.last = now;
    }
  }

  /** Take one token if available; otherwise ms until one is. */
  tryTake(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.tokens) / this.perMs);
  }

  async take(): Promise<void> {
    for (;;) {
      const wait = this.tryTake();
      if (wait === 0) return;
      await this.clock.sleep(wait);
    }
  }
}

/** Concurrency + rate limiter shared by every EODHD call the pipeline makes. */
export class Limiter {
  private active = 0;
  private waiters: Array<() => void> = [];
  readonly bucket: TokenBucket;
  constructor(readonly o: { ratePerMin: number; concurrency: number; burst?: number; clock?: Clock }) {
    this.bucket = new TokenBucket(o.ratePerMin, o.burst ?? Math.max(1, Math.min(o.concurrency * 2, o.ratePerMin)), o.clock ?? realClock);
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.o.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      await this.bucket.take();
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** Upstream status of an EodhdError-like error (upstreamStatus, else status). */
export function errorStatus(e: unknown): number | undefined {
  const x = e as { upstreamStatus?: number; status?: number } | null;
  const s = x?.upstreamStatus ?? x?.status;
  return typeof s === "number" ? s : undefined;
}

/** 429, 5xx and network/timeouts (EodhdError code "network") are worth retrying. */
export function isRetryable(e: unknown): boolean {
  const x = e as { upstreamStatus?: number; status?: number; code?: string } | null;
  if (x?.code === "network" || x?.code === "rate_limited") return true;
  const up = x?.upstreamStatus;
  if (typeof up === "number") return up === 429 || up >= 500;
  const st = x?.status;
  return typeof st === "number" && (st === 429 || st === 502 || st === 503 || st === 504);
}

/** Exponential back-off with jitter in [0.5, 1): base·2^attempt, capped; 429 waits 4× longer. */
export function backoffMs(attempt: number, o: { baseMs: number; maxMs: number; rateLimited?: boolean; jitter?: number }): number {
  const j = 0.5 + 0.5 * (o.jitter ?? Math.random());
  const raw = o.baseMs * 2 ** attempt * (o.rateLimited ? 4 : 1);
  return Math.round(Math.min(o.maxMs, raw) * j);
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  clock?: Clock;
  retryable?: (e: unknown) => boolean;
  /** Called before each retry (e.g. to record the credit the failed attempt may have cost). */
  onRetry?: (e: unknown, attempt: number, waitMs: number) => void;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? 4, clock = o.clock ?? realClock, retryable = o.retryable ?? isRetryable;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || !retryable(e)) throw e;
      const wait = backoffMs(attempt, { baseMs: o.baseMs ?? 1000, maxMs: o.maxMs ?? 30_000, rateLimited: errorStatus(e) === 429 });
      o.onRetry?.(e, attempt, wait);
      await clock.sleep(wait);
    }
  }
}
