import { describe, expect, test } from "bun:test";
import type { ScreenerResponse } from "@eodview/shared";
import { buildCsv, collectRows, csvEscape, csvFilename, tickerOf } from "./csv";

describe("csv", () => {
  test("escape", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(1.5)).toBe("1.5");
    expect(csvEscape(Number.NaN)).toBe("");
    expect(csvEscape('Say "hi", ok')).toBe('"Say ""hi"", ok"');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvEscape("-5.2")).toBe("-5.2");
  });

  test("build with No. column and ticker fallback", () => {
    const csv = buildCsv(
      [{ id: "ticker", label: "Ticker" }, { id: "company", label: "Company" }, { id: "market_cap", label: "Market Cap" }],
      [
        { symbol: "AAPL.US", company: "Apple Inc.", market_cap: 3.5e12 },
        { symbol: "BRK-B.US", ticker: "BRK-B", company: "Berkshire, Hathaway", market_cap: null },
      ],
    );
    expect(csv).toBe('No.,Ticker,Company,Market Cap\r\n1,AAPL,Apple Inc.,3500000000000\r\n2,BRK-B,"Berkshire, Hathaway",\r\n');
  });

  test("tickerOf", () => {
    expect(tickerOf({ symbol: "SPY.US" })).toBe("SPY");
    expect(tickerOf({ symbol: "X" })).toBe("X");
  });

  test("filename", () => {
    expect(csvFilename(new Date(2026, 8, 5), "valuation")).toBe("screener-valuation-2026-09-05.csv");
  });
});

describe("collectRows", () => {
  const fake = (total: number) => {
    const calls: [number, number][] = [];
    const fetchPage = async (offset: number, limit: number): Promise<ScreenerResponse> => {
      calls.push([offset, limit]);
      const n = Math.max(0, Math.min(limit, total - offset));
      return { total, asOf: null, rows: Array.from({ length: n }, (_, i) => ({ symbol: `S${offset + i}` })) };
    };
    return { calls, fetchPage };
  };

  test("pages until total", async () => {
    const f = fake(1234);
    const progress: number[] = [];
    const r = await collectRows(f.fetchPage, { onProgress: (d) => progress.push(d) });
    expect(r.rows.length).toBe(1234);
    expect(r.truncated).toBe(false);
    expect(f.calls).toEqual([[0, 500], [500, 500], [1000, 500]]);
    expect(progress).toEqual([500, 1000, 1234]);
    expect(r.rows[1233].symbol).toBe("S1233");
  });

  test("caps at 5000 and reports truncation", async () => {
    const f = fake(12000);
    const r = await collectRows(f.fetchPage);
    expect(r.rows.length).toBe(5000);
    expect(r.total).toBe(12000);
    expect(r.truncated).toBe(true);
    expect(f.calls.length).toBe(10);
  });

  test("custom cap / short page stops", async () => {
    const f = fake(700);
    const r = await collectRows(f.fetchPage, { cap: 600, pageSize: 250 });
    expect(f.calls).toEqual([[0, 250], [250, 250], [500, 100]]);
    expect(r.rows.length).toBe(600);
    const g = fake(0);
    const e = await collectRows(g.fetchPage);
    expect(e.rows).toEqual([]);
    expect(g.calls.length).toBe(1);
  });

  test("abort", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(collectRows(fake(10).fetchPage, { signal: ac.signal })).rejects.toThrow("cancelled");
  });
});
