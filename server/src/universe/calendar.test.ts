import { describe, expect, test } from "bun:test";
import {
  expectedLatestSession,
  isSession,
  nextPriceAttemptAfter,
  nextUtcMidnight,
  nyParts,
  nyseHolidays,
  nyWallToUtc,
  previousSession,
  recentSessions,
} from "./calendar";
import { pricesNextRun } from "./jobs";

describe("NYSE calendar", () => {
  test("2026 holidays", () => {
    const h = nyseHolidays(2026);
    for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) {
      expect(h.has(d)).toBe(true);
    }
    expect(h.size).toBe(10);
  });

  test("observance rules", () => {
    expect(nyseHolidays(2027).has("2027-12-24")).toBe(true); // Christmas on Saturday → Friday
    expect(nyseHolidays(2022).has("2021-12-31")).toBe(false); // Saturday New Year is not observed
    expect(nyseHolidays(2023).has("2023-01-02")).toBe(true); // Sunday New Year → Monday
    expect(nyseHolidays(2025).has("2025-04-18")).toBe(true); // Good Friday
  });

  test("sessions skip weekends and holidays", () => {
    expect(isSession("2026-09-25")).toBe(true);
    expect(isSession("2026-09-26")).toBe(false);
    expect(isSession("2026-09-07")).toBe(false);
    expect(isSession("2026-09-24", new Set(["2026-09-24"]))).toBe(false);
    expect(previousSession("2026-09-08")).toBe("2026-09-04");
    const r = recentSessions("2026-09-24", 5);
    expect(r).toEqual(["2026-09-24", "2026-09-23", "2026-09-22", "2026-09-21", "2026-09-18"]);
    expect(recentSessions("2026-09-24", 300).length).toBe(300);
  });

  test("New York wall clock and DST", () => {
    expect(nyParts(Date.UTC(2026, 8, 25, 22, 30))).toMatchObject({ date: "2026-09-25", hour: 18, minute: 30, weekday: 5 });
    expect(nyWallToUtc("2026-09-25", 18, 30)).toBe(Date.UTC(2026, 8, 25, 22, 30)); // EDT
    expect(nyWallToUtc("2026-12-01", 18, 30)).toBe(Date.UTC(2026, 11, 1, 23, 30)); // EST
    expect(nyWallToUtc("2026-03-09", 18, 30)).toBe(Date.UTC(2026, 2, 9, 22, 30)); // day after spring-forward
  });

  test("expected latest session", () => {
    expect(expectedLatestSession(Date.UTC(2026, 8, 25, 14, 0))).toBe("2026-09-24"); // Fri 10:00 NY
    expect(expectedLatestSession(Date.UTC(2026, 8, 25, 23, 0))).toBe("2026-09-25"); // Fri 19:00 NY
    expect(expectedLatestSession(Date.UTC(2026, 8, 27, 12, 0))).toBe("2026-09-25"); // Sunday
    expect(expectedLatestSession(Date.UTC(2026, 8, 8, 12, 0))).toBe("2026-09-04"); // Tue after Labor Day, morning
  });

  test("next attempt / midnight", () => {
    expect(nextPriceAttemptAfter("2026-09-25")).toBe(Date.UTC(2026, 8, 28, 22, 30)); // Monday 18:30 EDT
    expect(nextUtcMidnight(Date.UTC(2026, 8, 25, 13, 0))).toBe(Date.UTC(2026, 8, 26));
  });
});

describe("prices schedule", () => {
  const none = new Set<string>();
  test("no data yet → now", () => {
    const now = Date.UTC(2026, 8, 25, 14);
    expect(pricesNextRun(now, null, none, null)).toBe(now);
  });
  test("up to date → next session 18:30 NY", () => {
    const now = Date.UTC(2026, 8, 25, 14); // Fri 10:00 NY, have Thursday
    expect(pricesNextRun(now, "2026-09-24", none, null)).toBe(Date.UTC(2026, 8, 25, 22, 30));
  });
  test("behind → now, then hourly after an attempt", () => {
    const now = Date.UTC(2026, 8, 25, 23); // Fri 19:00 NY, have Thursday
    expect(pricesNextRun(now, "2026-09-24", none, null)).toBe(now);
    const attempt = Date.UTC(2026, 8, 25, 22, 40);
    expect(pricesNextRun(now, "2026-09-24", none, attempt)).toBe(attempt + 3600_000);
    // an attempt made before today's 18:30 doesn't count
    expect(pricesNextRun(now, "2026-09-24", none, Date.UTC(2026, 8, 25, 15))).toBe(now);
  });
});
