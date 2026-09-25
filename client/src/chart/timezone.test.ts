import { describe, expect, test } from "bun:test";
import { TickMarkType } from "lightweight-charts";
import {
  exchangeTimeZone, formatClock, formatCrosshairTime, formatTickMark, offsetLabel, resolveTimeZone, tzOffsetSeconds,
  zonedDayStart, zonedMidnight,
} from "./timezone";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("exchange zones", () => {
  test("maps exchanges", () => {
    expect(exchangeTimeZone("AAPL.US")).toBe("America/New_York");
    expect(exchangeTimeZone("VOD.LSE")).toBe("Europe/London");
    expect(exchangeTimeZone("SAP.XETRA")).toBe("Europe/Berlin");
    expect(exchangeTimeZone("EURUSD.FOREX")).toBe("UTC");
    expect(exchangeTimeZone("BTC-USD.CC")).toBe("UTC");
    expect(exchangeTimeZone("GSPC.INDX")).toBe("UTC");
    expect(exchangeTimeZone("FOO.UNKNOWN")).toBe("UTC");
  });

  test("resolves settings", () => {
    expect(resolveTimeZone(undefined, "AAPL.US")).toBe("UTC");
    expect(resolveTimeZone("exchange", "AAPL.US")).toBe("America/New_York");
    expect(resolveTimeZone("local", "AAPL.US", "Africa/Lagos")).toBe("Africa/Lagos");
    expect(resolveTimeZone("Asia/Tokyo", "AAPL.US")).toBe("Asia/Tokyo");
    expect(resolveTimeZone("Not/AZone", "AAPL.US")).toBe("UTC");
  });
});

describe("offsets", () => {
  test("DST aware", () => {
    expect(tzOffsetSeconds(at("2026-07-01T12:00:00Z"), "America/New_York")).toBe(-4 * 3600);
    expect(tzOffsetSeconds(at("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-5 * 3600);
    expect(tzOffsetSeconds(at("2026-07-01T12:00:00Z"), "Asia/Kolkata")).toBe(5.5 * 3600);
    expect(tzOffsetSeconds(at("2026-07-01T12:00:00Z"), "UTC")).toBe(0);
  });

  test("labels", () => {
    expect(offsetLabel(at("2026-07-01T12:00:00Z"), "America/New_York")).toBe("UTC-4");
    expect(offsetLabel(at("2026-07-01T12:00:00Z"), "Asia/Kolkata")).toBe("UTC+5:30");
    expect(offsetLabel(at("2026-07-01T12:00:00Z"), "UTC")).toBe("UTC");
  });

  test("zoned midnight and day start", () => {
    expect(zonedMidnight(2026, 9, 25, "America/New_York")).toBe(at("2026-09-25T04:00:00Z"));
    expect(zonedMidnight(2026, 1, 5, "America/New_York")).toBe(at("2026-01-05T05:00:00Z"));
    expect(zonedMidnight(2026, 9, 25, "Asia/Tokyo")).toBe(at("2026-09-24T15:00:00Z"));
    // 01:30 UTC on the 26th is still the 25th in New York
    expect(zonedDayStart(at("2026-09-26T01:30:00Z"), "America/New_York")).toBe(at("2026-09-25T04:00:00Z"));
    expect(zonedDayStart(at("2026-09-26T01:30:00Z"), "UTC")).toBe(at("2026-09-26T00:00:00Z"));
  });
});

describe("formatting", () => {
  test("clock", () => {
    expect(formatClock(at("2026-09-25T12:11:40Z"), "UTC")).toBe("12:11:40 UTC");
    expect(formatClock(at("2026-09-25T12:11:40Z"), "America/New_York")).toBe("08:11:40 (UTC-4)");
  });

  test("intraday ticks follow the zone, daily ticks never shift", () => {
    const t = at("2026-09-25T13:30:00Z");
    expect(formatTickMark(t, TickMarkType.Time, "America/New_York", true)).toBe("09:30");
    expect(formatTickMark(t, TickMarkType.Time, "UTC", true)).toBe("13:30");
    const day = at("2026-09-25T00:00:00Z");
    expect(formatTickMark(day, TickMarkType.DayOfMonth, "America/New_York", false)).toBe("25");
    expect(formatTickMark(day, TickMarkType.DayOfMonth, "America/New_York", true)).toBe("24");
    expect(formatTickMark(day, TickMarkType.Month, "UTC", false)).toBe("Sep");
    expect(formatTickMark(day, TickMarkType.Year, "UTC", false)).toBe("2026");
  });

  test("crosshair label", () => {
    expect(formatCrosshairTime(at("2026-09-25T00:00:00Z"), "Asia/Tokyo", false)).toBe("Fri 25 Sep '26");
    expect(formatCrosshairTime(at("2026-09-25T13:30:00Z"), "America/New_York", true)).toBe("Fri 25 Sep '26  09:30");
  });
});
