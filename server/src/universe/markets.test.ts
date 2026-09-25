// Market registry, enabled-set resolution and timezone-aware scheduling.
import { describe, expect, test } from "bun:test";
import {
  calendarFor,
  isMarketSession,
  marketAttemptAt,
  marketExpectedLatest,
  marketNextAttemptAfter,
  marketRecentSessions,
  tzDate,
  wallToUtc,
} from "./calendar";
import { pricesNextRun } from "./jobs";
import {
  DEFAULT_MARKETS, getMarket, hhmm, MARKETS, marketOfSymbol, resolveEnabledMarkets } from "./markets";

describe("registry", () => {
  test("covers the required exchanges with valid zones and unique codes", () => {
    const codes = MARKETS.map((m) => m.code);
    for (const c of ["US", "TO", "V", "LSE", "XETRA", "PA", "AS", "ST", "OL", "CO", "HE", "SW", "MC", "AU", "KO", "KQ", "TW", "TWO", "HK"]) {
      expect(codes).toContain(c);
    }
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes[0]).toBe("US");
    for (const m of MARKETS) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: m.timezone })).not.toThrow();
      expect(hhmm(m.close)).toBeGreaterThan(hhmm(m.open));
      expect(m.minSymbols).toBeGreaterThan(0);
      for (const i of m.indices) expect(i.code.endsWith(".INDX")).toBe(true);
    }
    expect(getMarket("st")?.currency).toBe("SEK");
    expect(getMarket("LSE")?.currency).toBe("GBX");
    expect(getMarket("MI")).toBeUndefined(); // 404 on EODHD, not registered
  });

  test("enabled markets: env wins, then config, then the study defaults", () => {
    expect(resolveEnabledMarkets(undefined, null)).toEqual({ codes: DEFAULT_MARKETS, source: "default", unknown: [] });
    expect(DEFAULT_MARKETS[0]).toBe("US");
    expect(resolveEnabledMarkets("st, us ,LSE", "TO")).toEqual({ codes: ["US", "LSE", "ST"], source: "env", unknown: [] });
    expect(resolveEnabledMarkets("", "TO,ST")).toEqual({ codes: ["TO", "ST"], source: "config", unknown: [] });
    expect(resolveEnabledMarkets("XX,ST", null)).toEqual({ codes: ["ST"], source: "env", unknown: ["XX"] });
    expect(resolveEnabledMarkets("XX", null)).toEqual({ codes: DEFAULT_MARKETS, source: "default", unknown: ["XX"] });
  });

  test("symbol suffix", () => {
    expect(marketOfSymbol("SIVE.ST")).toBe("ST");
    expect(marketOfSymbol("BT.A.LSE")).toBe("LSE");
    expect(marketOfSymbol("AAPL")).toBeNull();
  });
});

describe("timezone-aware scheduling", () => {
  const st = calendarFor(getMarket("ST")!);
  const au = calendarFor(getMarket("AU")!);
  const hk = calendarFor(getMarket("HK")!);

  test("wall clock ↔ UTC across DST", () => {
    expect(wallToUtc("2026-09-25", 20, 0, "Europe/Stockholm")).toBe(Date.UTC(2026, 8, 25, 18, 0)); // CEST
    expect(wallToUtc("2026-12-01", 20, 0, "Europe/Stockholm")).toBe(Date.UTC(2026, 11, 1, 19, 0)); // CET
    expect(wallToUtc("2026-09-25", 0, 18 * 60 + 40, "Australia/Sydney")).toBe(Date.UTC(2026, 8, 25, 8, 40)); // AEST
    expect(tzDate(Date.UTC(2026, 8, 25, 23, 0), "Europe/Stockholm")).toBe("2026-09-26");
    expect(tzDate(Date.UTC(2026, 8, 25, 23, 0), "America/New_York")).toBe("2026-09-25");
  });

  test("price attempt = close + 150 min, local time", () => {
    expect(marketAttemptAt(st, "2026-09-25")).toBe(Date.UTC(2026, 8, 25, 18, 0)); // 17:30 + 2:30 = 20:00 CEST
    expect(marketAttemptAt(au, "2026-09-25")).toBe(Date.UTC(2026, 8, 25, 8, 40)); // 16:10 + 2:30 = 18:40 AEST
    expect(marketAttemptAt(hk, "2026-09-25")).toBe(Date.UTC(2026, 8, 25, 10, 40)); // 16:10 + 2:30 = 18:40 HKT
  });

  test("expected latest session per market at the same instant", () => {
    const t = Date.UTC(2026, 8, 25, 12, 0); // Fri: 14:00 Stockholm, 22:00 Sydney, 08:00 New York
    expect(marketExpectedLatest(st, t)).toBe("2026-09-24");
    expect(marketExpectedLatest(au, t)).toBe("2026-09-25");
    expect(marketExpectedLatest(calendarFor(getMarket("US")!), t)).toBe("2026-09-24");
    // Monday morning in Sydney is still Sunday in Europe: Friday is the latest everywhere
    const mon = Date.UTC(2026, 8, 27, 23, 0);
    expect(marketExpectedLatest(au, mon)).toBe("2026-09-25");
    expect(marketNextAttemptAfter(st, "2026-09-25")).toBe(Date.UTC(2026, 8, 28, 18, 0));
  });

  test("learned/exchange holidays are skipped; NYSE rules only for US", () => {
    const withHol = calendarFor(getMarket("ST")!, new Set(["2026-12-24", "2026-12-25"]));
    expect(isMarketSession(withHol, "2026-12-25")).toBe(false);
    expect(isMarketSession(st, "2026-11-26")).toBe(true); // US Thanksgiving is not a Swedish holiday
    expect(isMarketSession(calendarFor(getMarket("US")!), "2026-11-26")).toBe(false);
    expect(marketRecentSessions(withHol, "2026-12-28", 3)).toEqual(["2026-12-28", "2026-12-23", "2026-12-22"]);
  });

  test("prices job timing per market", () => {
    const m = getMarket("ST")!;
    const none = new Set<string>();
    const t = Date.UTC(2026, 8, 25, 12, 0);
    expect(pricesNextRun(t, "2026-09-24", none, null, m)).toBe(Date.UTC(2026, 8, 25, 18, 0)); // up to date → today 20:00 local
    const late = Date.UTC(2026, 8, 25, 19, 0);
    expect(pricesNextRun(late, "2026-09-24", none, null, m)).toBe(late); // behind → now
    expect(pricesNextRun(late, "2026-09-24", none, Date.UTC(2026, 8, 25, 18, 30), m)).toBe(Date.UTC(2026, 8, 25, 19, 30)); // hourly
  });
});
