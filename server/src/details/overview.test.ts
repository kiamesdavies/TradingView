import { describe, expect, test } from "bun:test";
import type { Bar, Quote } from "@eodview/shared";
import fundamentals from "./__fixtures__/aapl-fundamentals.json";
import delayedFixture from "./__fixtures__/aapl-us-quote-delayed.json";
import newsFixture from "./__fixtures__/aapl-news.json";
import divFixture from "./__fixtures__/aapl-div.json";
import splitFixture from "./__fixtures__/aapl-splits.json";
import realtimeFixture from "./__fixtures__/aapl-realtime.json";
import { mapRealtime } from "../eodhd/mappers";
import { EodhdError } from "../eodhd/request";
import { averageVolume, buildOverview } from "./overview";
import { createDetailsService, type DetailsDeps } from "./service";
import { parseDetailsSymbol } from "./symbol";
import type { LogoStore } from "./logo";

const AAPL = parseDetailsSymbol("aapl.us");
const NOW = Date.parse("2026-09-24T20:30:00-04:00"); // Thursday evening, after-hours
const QUOTE: Quote = mapRealtime(realtimeFixture)[0];

describe("buildOverview (trimmed real AAPL fundamentals)", () => {
  const ov = buildOverview({
    sym: AAPL,
    kind: "security",
    fundamentals,
    fundamentalsFetchedAt: 1790000000,
    quote: QUOTE,
    extended: null,
    latestNews: null,
    avgVolume30d: 50_000_000,
    nowMs: NOW,
  });

  test("profile", () => {
    expect(ov.profile).toMatchObject({
      symbol: "AAPL.US",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      type: "Common Stock",
      isEtf: false,
      sector: "Technology",
      industry: "Consumer Electronics",
      country: "USA",
      currency: "USD",
      website: "https://www.apple.com",
      logoUrl: "/api/symbols/AAPL.US/logo",
      ipoDate: "1980-12-12",
      employees: 150000,
    });
    expect(ov.profile.description).toStartWith("Apple Inc. designs");
    expect(ov.fundamentalsAsOf).toBe(1790000000);
  });

  test("stats: fixed first four, then the expanded list in order", () => {
    expect(ov.stats.slice(0, 4)).toEqual([
      { key: "next_earnings", label: "Next earnings report", value: 35, format: "days" },
      { key: "volume", label: "Volume", value: QUOTE.volume, format: "volume" },
      { key: "avg_volume_30d", label: "Average volume (30D)", value: 50_000_000, format: "volume" },
      { key: "market_cap", label: "Market capitalization", value: 4902477103104, format: "money" },
    ]);
    const byKey = Object.fromEntries(ov.stats.map((s) => [s.key, s.value]));
    expect(ov.stats.map((s) => s.key)).toEqual([
      "next_earnings", "volume", "avg_volume_30d", "market_cap",
      "pe", "forward_pe", "eps_ttm", "revenue_ttm", "net_margin", "dividend_yield", "beta", "high_52w", "low_52w",
      "shares_outstanding", "float", "short_float", "insiders", "institutions", "employees", "next_earnings_date", "ipo_date",
    ]);
    expect(byKey.pe).toBe(38.6115);
    expect(byKey.net_margin).toBe(27.62);
    expect(byKey.dividend_yield).toBe(0.32);
    expect(byKey.short_float).toBe(0.96);
    expect(byKey.insiders).toBeCloseTo(1.648, 6);
    expect(byKey.next_earnings_date).toBe("2026-10-29");
  });

  test("earnings: last 8 reported + upcoming, ascending", () => {
    expect(ov.earnings).toHaveLength(9);
    expect(ov.earnings[0].period).toBe("2024-09-30");
    expect(ov.earnings[7]).toEqual({
      period: "2026-06-30", reportDate: "2026-07-30", timing: "AfterMarket", epsActual: 2.02, epsEstimate: 1.88, surprisePct: 7.4468, upcoming: false,
    });
    expect(ov.earnings[8]).toEqual({
      period: "2026-09-30", reportDate: "2026-10-29", timing: "AfterMarket", epsActual: null, epsEstimate: 1.98, surprisePct: null, upcoming: true,
    });
    expect(ov.nextEarnings).toEqual({ date: "2026-10-29", timing: "AfterMarket", epsEstimate: 1.98, daysUntil: 35 });
  });

  test("revenue and analyst", () => {
    expect(ov.revenue).toHaveLength(8);
    expect(ov.revenue[0]).toEqual({ period: "2024-09-30", revenue: 94930000000 });
    expect(ov.revenue.at(-1)).toEqual({ period: "2026-06-30", revenue: 109417000000 });
    expect(ov.analyst).toEqual({ rating: 4.0417, targetPrice: 328.2221, strongBuy: 23, buy: 7, hold: 16, sell: 1, strongSell: 1 });
  });

  test("non-stock symbols get a minimal overview", () => {
    const fx = buildOverview({
      sym: parseDetailsSymbol("EURUSD.FOREX"),
      kind: "forex",
      fundamentals: null,
      fundamentalsFetchedAt: null,
      quote: null,
      extended: null,
      latestNews: null,
      avgVolume30d: null,
      fallbackName: "Euro/US Dollar",
      nowMs: NOW,
    });
    expect(fx.profile).toEqual({ symbol: "EURUSD.FOREX", name: "Euro/US Dollar", exchange: "FOREX", type: "Currency", isEtf: false });
    expect(fx.stats.map((s) => s.key)).toEqual(["volume", "avg_volume_30d"]);
    expect(fx).toMatchObject({ earnings: [], revenue: [], analyst: null, nextEarnings: null, fundamentalsAsOf: null });
  });

  test("averageVolume", () => {
    expect(averageVolume([{ volume: 10 }, { volume: 0 }, { volume: 20 }])).toBe(15);
    expect(averageVolume([])).toBeNull();
  });
});

function fakeDeps(over: Partial<DetailsDeps> = {}) {
  const calls: string[] = [];
  let clock = NOW;
  const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({ time: i * 86400, open: 1, high: 1, low: 1, close: 1, volume: i < 10 ? 1 : 100 }));
  const deps: DetailsDeps = {
    async raw(path) {
      calls.push(path);
      if (path === "/us-quote-delayed") return delayedFixture;
      if (path === "/news") return newsFixture;
      if (path.startsWith("/div/")) return divFixture;
      if (path.startsWith("/splits/")) return splitFixture;
      throw new EodhdError(404, "no data", "not_found", 404);
    },
    async realtime(symbols) {
      calls.push(`realtime:${symbols.join(",")}`);
      return [QUOTE];
    },
    async search(q) {
      calls.push(`search:${q}`);
      return [{ symbol: "BTC-USD.CC", code: "BTC-USD", exchange: "CC", name: "Bitcoin", type: "Currency", assetClass: "crypto", streamable: true }];
    },
    async getFundamentals(symbol) {
      calls.push(`fundamentals:${symbol}`);
      return fundamentals;
    },
    getCachedFundamentals: () => ({ data: fundamentals, fetchedAt: 1790000000 }),
    async dailyBars(_s, limit) {
      calls.push("bars");
      return bars.slice(-limit);
    },
    logos: { get: async () => ({ found: false }) } as unknown as LogoStore,
    nowMs: () => clock,
    log: () => {},
    ...over,
  };
  return { deps, calls, advance: (ms: number) => (clock += ms) };
}

describe("details service", () => {
  test("overview assembles fundamentals, quote, post-market extended line, news and 30D avg volume", async () => {
    const { deps, calls } = fakeDeps();
    const svc = createDetailsService(deps);
    const ov = await svc.overview(AAPL);
    expect(ov.quote?.price).toBe(335.92);
    expect(ov.extended).toMatchObject({ session: "post", price: 335.76, change: -0.16 });
    expect(ov.latestNews?.title).toBe("Apple shares near buy point after new iPhone launch");
    expect(ov.stats[2].value).toBe(100);
    expect(ov.nextEarnings?.daysUntil).toBe(35);
    expect(calls.filter((c) => c === "/news")).toHaveLength(1);
  });

  test("assembled parts are cached for 60s while quote/extended refresh", async () => {
    const { deps, calls, advance } = fakeDeps();
    const svc = createDetailsService(deps);
    await svc.overview(AAPL);
    advance(20_000);
    await svc.overview(AAPL);
    expect(calls.filter((c) => c.startsWith("fundamentals"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("realtime"))).toHaveLength(2);
    expect(calls.filter((c) => c === "/us-quote-delayed")).toHaveLength(2);
    advance(45_000);
    await svc.overview(AAPL);
    expect(calls.filter((c) => c.startsWith("fundamentals"))).toHaveLength(2);
    expect(calls.filter((c) => c === "/news")).toHaveLength(1); // news cached 10 min
  });

  test("crypto: no fundamentals / extended calls, name from search", async () => {
    const { deps, calls } = fakeDeps();
    const svc = createDetailsService(deps);
    const ov = await svc.overview(parseDetailsSymbol("BTC-USD.CC"));
    expect(ov.profile.name).toBe("Bitcoin");
    expect(ov.extended).toBeNull();
    expect(calls.some((c) => c.startsWith("fundamentals") || c === "/us-quote-delayed")).toBe(false);
    expect(await svc.events(parseDetailsSymbol("BTC-USD.CC"))).toEqual([]);
  });

  test("slow news does not block the overview; it lands in the cache for the next call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = fakeDeps({ newsWaitMs: 20 });
    const raw = deps.raw;
    deps.raw = async (path, params, what) => {
      if (path === "/news") {
        calls.push(`/news from=${params?.from}`);
        await gate;
      }
      return raw(path, params, what);
    };
    const svc = createDetailsService(deps);
    expect((await svc.overview(AAPL)).latestNews).toBeNull();
    release();
    await Bun.sleep(5);
    expect((await svc.overview(AAPL)).latestNews?.title).toBe("Apple shares near buy point after new iPhone launch");
    expect(calls).toContain("/news from=2026-07-27");
  });

  test("stock without fundamentals (404) still returns an overview", async () => {
    const { deps } = fakeDeps({
      getFundamentals: async () => {
        throw new EodhdError(404, "no data", "not_found", 404);
      },
    });
    const ov = await createDetailsService(deps).overview(parseDetailsSymbol("NEW.US"));
    expect(ov.profile.name).toBe("NEW");
    expect(ov.stats.slice(0, 4).map((s) => s.key)).toEqual(["next_earnings", "volume", "avg_volume_30d", "market_cap"]);
  });

  test("upstream errors other than not-found propagate from fundamentals", async () => {
    const { deps } = fakeDeps({
      getFundamentals: async () => {
        throw new EodhdError(429, "EODHD rate limit reached; try again later", "rate_limited", 429);
      },
    });
    await expect(createDetailsService(deps).overview(AAPL)).rejects.toMatchObject({ status: 429 });
  });

  test("news: limit slicing and 10 min cache", async () => {
    const { deps, calls, advance } = fakeDeps();
    const svc = createDetailsService(deps);
    expect(await svc.news("AAPL.US", 2)).toHaveLength(2);
    expect(await svc.news("AAPL.US", 20)).toHaveLength(3); // upstream had fewer than asked → no refetch
    advance(11 * 60_000);
    await svc.news("AAPL.US", 1);
    expect(calls.filter((c) => c === "/news")).toHaveLength(2);
  });

  test("events: merged, filtered, dividends cached 24h", async () => {
    const { deps, calls } = fakeDeps();
    const svc = createDetailsService(deps);
    const from = Date.UTC(2026, 0, 1) / 1000;
    const ev = await svc.events(AAPL, from, Date.UTC(2026, 8, 24) / 1000);
    expect(ev.map((e) => e.label).join("")).toBe("EDEDEDE");
    expect(ev.at(-1)!.upcoming).toBe(true);
    await svc.events(AAPL);
    expect(calls.filter((c) => c.startsWith("/div/"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("/splits/"))).toHaveLength(1);
  });
});

describe("parseDetailsSymbol", () => {
  test("validates TICKER.EXCHANGE", () => {
    expect(parseDetailsSymbol("brk-b.us")).toEqual({ symbol: "BRK-B.US", code: "BRK-B", exchange: "US" });
    expect(parseDetailsSymbol("^GSPC.INDX").exchange).toBe("INDX");
    for (const bad of ["AAPL", "", "../etc.US", "A/B.US", "AAPL.", ".US"]) expect(() => parseDetailsSymbol(bad)).toThrow();
  });
});
