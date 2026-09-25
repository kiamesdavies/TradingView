import { describe, expect, test } from "bun:test";
import { classifyExtended, regularTradeTime } from "./extended";
import { lastSessionDay, nyClock } from "./time";

// 2026-09-24 is a Thursday; New York is on EDT (UTC-4).
const et = (iso: string) => Date.parse(`${iso}-04:00`);
const base = { ethPrice: 335.76, regularPrice: 335.92 };

describe("classifyExtended", () => {
  test("pre-market: trade before 09:30 today while the session has not opened", () => {
    const r = classifyExtended({ ...base, ethPrice: 337, ethTimeMs: et("2026-09-24T08:15:00") }, et("2026-09-24T08:20:00"));
    expect(r).toEqual({ session: "pre", price: 337, change: 1.08, changePct: 0.3215, time: et("2026-09-24T08:15:00") / 1000 });
  });

  test("pre-market line disappears once the regular session opens", () => {
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-24T08:15:00") }, et("2026-09-24T10:00:00"))).toBeNull();
  });

  test("post-market (real us-quote-delayed sample: 16:29 ET trade)", () => {
    const eth = 1790281742333; // 2026-09-24T20:29:02Z
    const r = classifyExtended({ ...base, ethTimeMs: eth }, et("2026-09-24T20:00:00"));
    expect(r?.session).toBe("post");
    expect(r?.change).toBe(-0.16);
    expect(r?.changePct).toBe(-0.0476);
    // still shown overnight and before the next open, gone after it
    expect(classifyExtended({ ...base, ethTimeMs: eth }, et("2026-09-25T07:00:00"))?.session).toBe("post");
    expect(classifyExtended({ ...base, ethTimeMs: eth }, et("2026-09-25T09:31:00"))).toBeNull();
  });

  test("regular-hours trade → no extended line", () => {
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-24T11:00:00") }, et("2026-09-24T11:01:00"))).toBeNull();
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-24T15:59:00") }, et("2026-09-24T17:00:00"))).toBeNull();
  });

  test("weekend: Friday's after-hours stays until Monday's open; weekend-stamped trades ignored", () => {
    const fri = et("2026-09-25T18:00:00");
    expect(classifyExtended({ ...base, ethTimeMs: fri }, et("2026-09-27T12:00:00"))?.session).toBe("post"); // Sunday
    expect(classifyExtended({ ...base, ethTimeMs: fri }, et("2026-09-28T08:00:00"))?.session).toBe("post"); // Monday pre-open
    expect(classifyExtended({ ...base, ethTimeMs: fri }, et("2026-09-28T09:45:00"))).toBeNull();
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-26T10:00:00") }, et("2026-09-26T11:00:00"))).toBeNull();
    // Monday pre-market seen on Monday morning
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-28T07:00:00") }, et("2026-09-28T07:05:00"))?.session).toBe("pre");
  });

  test("stale or older-than-regular trades, missing data", () => {
    // Wednesday after-hours seen on Thursday evening → stale
    expect(classifyExtended({ ...base, ethTimeMs: et("2026-09-23T17:00:00") }, et("2026-09-24T20:00:00"))).toBeNull();
    const eth = et("2026-09-24T16:30:00");
    expect(classifyExtended({ ...base, ethTimeMs: eth, regularTime: eth / 1000 + 1 }, et("2026-09-24T17:00:00"))).toBeNull();
    expect(classifyExtended({ ...base, ethPrice: null, ethTimeMs: eth }, et("2026-09-24T17:00:00"))).toBeNull();
    expect(classifyExtended({ ...base, regularPrice: null, ethTimeMs: eth }, et("2026-09-24T17:00:00"))).toBeNull();
  });

  test("winter time (EST, UTC-5)", () => {
    const est = (iso: string) => Date.parse(`${iso}-05:00`);
    expect(classifyExtended({ ...base, ethTimeMs: est("2026-12-02T09:00:00") }, est("2026-12-02T09:10:00"))?.session).toBe("pre");
    expect(classifyExtended({ ...base, ethTimeMs: est("2026-12-02T09:45:00") }, est("2026-12-02T09:50:00"))).toBeNull();
  });
});

describe("time helpers", () => {
  test("regularTradeTime keeps only regular-hours quote times", () => {
    expect(regularTradeTime(et("2026-09-24T12:00:00") / 1000)).toBe(et("2026-09-24T12:00:00") / 1000);
    expect(regularTradeTime(et("2026-09-24T16:29:00") / 1000)).toBeNull();
    expect(regularTradeTime(null)).toBeNull();
  });

  test("lastSessionDay", () => {
    const thu = nyClock(et("2026-09-24T12:00:00")).day;
    expect(lastSessionDay(nyClock(et("2026-09-24T09:00:00")))).toBe(thu - 1);
    expect(lastSessionDay(nyClock(et("2026-09-24T09:30:00")))).toBe(thu);
    expect(lastSessionDay(nyClock(et("2026-09-27T12:00:00")))).toBe(thu + 1); // Sunday → Friday
    expect(nyClock(et("2026-09-24T23:59:00")).date).toBe("2026-09-24");
  });
});
