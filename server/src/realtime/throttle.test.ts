import { expect, test } from "bun:test";
import type { Tick } from "@eodview/shared";
import { TickThrottle, type Timers } from "./throttle";

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (h) => { pending.delete(h as number); },
  };
  function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      pending.delete(next[0]);
      next[1].fn();
    }
    now = target;
  }
  return { timers, advance, pendingCount: () => pending.size };
}

const tick = (symbol: string, price: number, volume: number, time: number): Tick => ({ symbol, price, volume, time });

test("first tick passes immediately, burst is coalesced", () => {
  const { timers, advance } = fakeTimers();
  const out: Tick[] = [];
  const t = new TickThrottle(100, (x) => out.push(x), timers);
  t.push(tick("A.US", 1, 10, 1));
  expect(out).toHaveLength(1);
  advance(10); t.push(tick("A.US", 2, 5, 2));
  advance(10); t.push(tick("A.US", 3, 7, 3));
  expect(out).toHaveLength(1);
  advance(80);
  expect(out).toEqual([tick("A.US", 1, 10, 1), { ...tick("A.US", 3, 12, 3), open: 2, high: 3, low: 2 }]);
  // quiet period → next tick immediate again
  advance(500); t.push(tick("A.US", 4, 1, 4));
  expect(out).toHaveLength(3);
});

test("symbols are independent and rate is bounded", () => {
  const { timers, advance } = fakeTimers();
  const out: Tick[] = [];
  const t = new TickThrottle(100, (x) => out.push(x), timers);
  for (let i = 0; i < 1000; i++) {
    t.push(tick("A.US", i, 1, i));
    t.push(tick("B.US", i, 1, i));
    advance(1);
  }
  advance(200);
  const a = out.filter((x) => x.symbol === "A.US");
  expect(a.length).toBeLessThanOrEqual(11);
  expect(a.reduce((s, x) => s + x.volume, 0)).toBe(1000);
  expect(a[a.length - 1].price).toBe(999);
  expect(out.filter((x) => x.symbol === "B.US").length).toBe(a.length);
});

test("forget drops pending tick", () => {
  const { timers, advance, pendingCount } = fakeTimers();
  const out: Tick[] = [];
  const t = new TickThrottle(100, (x) => out.push(x), timers);
  t.push(tick("A.US", 1, 1, 1));
  t.push(tick("A.US", 2, 1, 2));
  t.forget("A.US");
  expect(pendingCount()).toBe(0);
  advance(1000);
  expect(out).toHaveLength(1);
});

test("coalesced tick carries the window's high/low", () => {
  const { timers, advance } = fakeTimers();
  const out: Tick[] = [];
  const t = new TickThrottle(100, (x) => out.push(x), timers);
  t.push(tick("BTC-USD.CC", 100, 1, 1_000));
  advance(10); t.push(tick("BTC-USD.CC", 110, 1, 1_010));
  advance(10); t.push(tick("BTC-USD.CC", 101, 1, 1_020));
  advance(100);
  expect(out.map((x) => x.price)).toEqual([100, 101]);
  expect(out[1]).toEqual({ symbol: "BTC-USD.CC", price: 101, volume: 2, time: 1_020, open: 110, high: 110, low: 101 });
});

test("a tick in a new minute flushes the pending one instead of merging across the boundary", () => {
  const { timers, advance } = fakeTimers();
  const out: Tick[] = [];
  const t = new TickThrottle(100, (x) => out.push(x), timers);
  t.push(tick("A.US", 1, 1, 59_900));
  advance(10); t.push(tick("A.US", 2, 5, 59_950)); // pending, minute 0
  advance(10); t.push(tick("A.US", 3, 7, 60_010)); // minute 1 -> flush pending first
  expect(out).toEqual([tick("A.US", 1, 1, 59_900), tick("A.US", 2, 5, 59_950)]);
  advance(10); t.push(tick("A.US", 4, 1, 60_020));
  advance(200);
  expect(out).toHaveLength(3);
  expect(out[2]).toEqual({ ...tick("A.US", 4, 8, 60_020), open: 3, high: 4, low: 3 });
});
