import { describe, expect, test } from "bun:test";
import type { Bar, ChartEvent } from "@eodview/shared";
import { buildEventMarkers, daysUntil, eventsSupported } from "./events";

const at = (iso: string) => Date.parse(iso) / 1000;
const day = (d: string) => at(`${d}T00:00:00Z`);
const bar = (time: number): Bar => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
const ev = (type: ChartEvent["type"], d: string, upcoming = false): ChartEvent => ({
  type, time: day(d), label: type[0]!.toUpperCase(), detail: `${type} ${d}`, upcoming,
});

// Mon 2026-09-14 .. Fri 2026-09-25 (weekdays)
const dailyBars = ["14", "15", "16", "17", "18", "21", "22", "23", "24", "25"].map((d) => bar(day(`2026-09-${d}`)));
const now = at("2026-09-25T15:00:00Z");

describe("eventsSupported", () => {
  test("stocks only", () => {
    expect(eventsSupported("AAPL.US")).toBe(true);
    expect(eventsSupported("VOD.LSE")).toBe(true);
    expect(eventsSupported("EURUSD.FOREX")).toBe(false);
    expect(eventsSupported("BTC-USD.CC")).toBe(false);
    expect(eventsSupported("GSPC.INDX")).toBe(false);
  });
});

describe("buildEventMarkers", () => {
  test("daily: exact dates, weekend → next session, out of range dropped", () => {
    const ms = buildEventMarkers(
      [ev("earnings", "2026-09-16"), ev("dividend", "2026-09-19"), ev("split", "2026-08-01")],
      dailyBars, "1D", { now },
    );
    expect(ms.map((m) => [m.text, m.time])).toEqual([
      ["E", day("2026-09-16")],
      ["D", day("2026-09-21")],
    ]);
    expect(ms[0]!.position).toBe("belowBar");
    expect(ms[0]!.color).toBe("#2962ff");
  });

  test("weekly: event maps into its week's bar", () => {
    const weekly = [bar(day("2026-09-07")), bar(day("2026-09-14")), bar(day("2026-09-22"))]; // last week starts Tue (holiday)
    const ms = buildEventMarkers([ev("earnings", "2026-09-17"), ev("dividend", "2026-09-21")], weekly, "1W", { now });
    expect(ms.map((m) => m.time)).toEqual([day("2026-09-14"), day("2026-09-22")]);
  });

  test("upcoming earnings sits on the last bar with a countdown", () => {
    const ms = buildEventMarkers(
      [ev("earnings", "2026-10-29", true), ev("earnings", "2027-01-28", true), ev("dividend", "2026-11-10", true)],
      dailyBars, "1D", { now },
    );
    expect(ms).toHaveLength(1);
    expect(ms[0]!.text).toBe("E in 34d");
    expect(ms[0]!.time).toBe(day("2026-09-25"));
  });

  test("intraday: first bar of the event's session; other sessions dropped", () => {
    const tz = "America/New_York";
    const bars = [
      bar(at("2026-09-24T13:30:00Z")),
      bar(at("2026-09-24T19:55:00Z")),
      bar(at("2026-09-25T08:00:00Z")), // 04:00 NY pre-market
      bar(at("2026-09-25T13:30:00Z")),
    ];
    const ms = buildEventMarkers([ev("earnings", "2026-09-25"), ev("dividend", "2026-09-10")], bars, "5m", { tz, now });
    expect(ms.map((m) => m.time)).toEqual([at("2026-09-25T08:00:00Z")]);
  });

  test("daysUntil", () => {
    expect(daysUntil(day("2026-09-26"), now)).toBe(1);
    expect(daysUntil(day("2026-09-25"), now)).toBe(0);
  });
});
