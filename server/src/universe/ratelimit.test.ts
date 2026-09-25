import { describe, expect, test } from "bun:test";
import { backoffMs, isRetryable, Limiter, TokenBucket, withRetry, type Clock } from "./ratelimit";

/** Virtual clock: sleep advances time instantly. */
function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; },
  };
  return c;
}

describe("token bucket", () => {
  test("burst, then ratePerMin", async () => {
    const clock = fakeClock();
    const b = new TokenBucket(800, 8, clock);
    for (let i = 0; i < 8; i++) expect(b.tryTake()).toBe(0);
    expect(b.tryTake()).toBe(Math.ceil(60_000 / 800)); // 75 ms per token
    for (let i = 0; i < 800; i++) await b.take();
    // 8 burst + 792 refilled ⇒ just under a minute of virtual time
    expect(clock.t).toBeGreaterThan(59_000);
    expect(clock.t).toBeLessThanOrEqual(60_000);
  });
});

describe("limiter", () => {
  test("never exceeds the concurrency cap", async () => {
    const lim = new Limiter({ ratePerMin: 1e9, concurrency: 3 });
    let active = 0, peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        lim.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(1);
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(lim.inFlight).toBe(0);
  });

  test("releases the slot when the task throws", async () => {
    const lim = new Limiter({ ratePerMin: 1e9, concurrency: 1 });
    await expect(lim.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await lim.run(async () => 42)).toBe(42);
  });
});

describe("retries", () => {
  test("classification", () => {
    expect(isRetryable({ upstreamStatus: 429 })).toBe(true);
    expect(isRetryable({ upstreamStatus: 503 })).toBe(true);
    expect(isRetryable({ status: 504, code: "network" })).toBe(true);
    expect(isRetryable({ upstreamStatus: 404, status: 404 })).toBe(false);
    expect(isRetryable({ upstreamStatus: 402, status: 402 })).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
  });

  test("exponential back-off, longer on 429, capped", () => {
    expect(backoffMs(0, { baseMs: 1000, maxMs: 30000, jitter: 1 })).toBe(1000);
    expect(backoffMs(3, { baseMs: 1000, maxMs: 30000, jitter: 1 })).toBe(8000);
    expect(backoffMs(3, { baseMs: 1000, maxMs: 30000, jitter: 0 })).toBe(4000);
    expect(backoffMs(1, { baseMs: 1000, maxMs: 30000, rateLimited: true, jitter: 1 })).toBe(8000);
    expect(backoffMs(10, { baseMs: 1000, maxMs: 30000, jitter: 1 })).toBe(30000);
  });

  test("retries transient errors, not permanent ones", async () => {
    const clock = fakeClock();
    let n = 0;
    const retried: number[] = [];
    const v = await withRetry(async () => {
      if (++n < 3) throw { upstreamStatus: 503 };
      return "ok";
    }, { clock, onRetry: (_e, a) => retried.push(a) });
    expect(v).toBe("ok");
    expect(retried).toEqual([0, 1]);
    expect(clock.sleeps.length).toBe(2);

    let m = 0;
    await expect(withRetry(async () => { m++; throw { upstreamStatus: 404, message: "nope" }; }, { clock })).rejects.toMatchObject({ upstreamStatus: 404 });
    expect(m).toBe(1);

    let k = 0;
    await expect(withRetry(async () => { k++; throw { upstreamStatus: 429 }; }, { clock, retries: 2 })).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(k).toBe(3);
  });
});
