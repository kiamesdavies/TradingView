import { describe, expect, test } from "bun:test";
import fundamentals from "./__fixtures__/aapl-fundamentals.json";
import divs from "./__fixtures__/aapl-div.json";
import splits from "./__fixtures__/aapl-splits.json";
import { dividendEvents, earningsEvents, selectEvents, splitEvents, splitRatio } from "./events";
import { dateToDay } from "./time";

const TODAY = dateToDay("2026-09-25");
const t = (d: string) => dateToDay(d) * 86400;

describe("chart events", () => {
  test("earnings from Earnings.History: reported with surprise, upcoming flagged", () => {
    const ev = earningsEvents(fundamentals.Earnings.History, TODAY);
    expect(ev).toHaveLength(12);
    const last = ev.at(-2)!;
    expect(last).toEqual({ type: "earnings", time: t("2026-07-30"), label: "E", detail: "EPS 2.02 vs 1.88 est (+7.4%)", upcoming: false });
    expect(ev.at(-1)).toEqual({
      type: "earnings",
      time: t("2026-10-29"),
      label: "E",
      detail: "Earnings 2026-10-29 (after close) · EPS est 1.98",
      upcoming: true,
    });
  });

  test("past report never filled in is skipped; surprise computed when missing", () => {
    const h = {
      a: { date: "2026-03-31", reportDate: "2026-04-20", epsActual: null, epsEstimate: 1 },
      b: { date: "2025-12-31", reportDate: "2026-01-20", epsActual: 0.5, epsEstimate: 0.31, surprisePercent: null },
    };
    expect(earningsEvents(h, TODAY)).toEqual([
      { type: "earnings", time: t("2026-01-20"), label: "E", detail: "EPS 0.50 vs 0.31 est (+61.3%)", upcoming: false },
    ]);
  });

  test("dividends and splits", () => {
    const d = dividendEvents(divs, TODAY);
    expect(d).toHaveLength(6);
    expect(d.at(-1)).toEqual({ type: "dividend", time: t("2026-08-10"), label: "D", detail: "Dividend $0.27 ex-date · paid 2026-08-13", upcoming: false });
    const adj = dividendEvents([{ date: "2019-08-09", value: 0.1925, unadjustedValue: 0.77, currency: "USD" }], TODAY);
    expect(adj[0].detail).toBe("Dividend $0.1925 ex-date ($0.77 as paid)");
    expect(dividendEvents([{ date: "2026-01-02", value: 12, currency: "SEK" }], TODAY)[0].detail).toBe("Dividend 12.00 SEK ex-date");

    const s = splitEvents(splits, TODAY);
    expect(s.map((x) => x.detail)).toEqual(["Split 2:1", "Split 2:1", "Split 2:1", "Split 7:1", "Split 4:1"]);
    expect(s.at(-1)!.time).toBe(t("2020-08-31"));
    expect(splitRatio("1.000000/10.000000")).toBe("1:10");
    expect(splitEvents([{ date: "2024-01-02", split: "1.000000/10.000000" }], TODAY)[0].detail).toBe("Reverse split 1:10");
    expect(splitRatio("garbage")).toBeNull();
  });

  test("selectEvents filters by range, keeps upcoming earnings past `to`, sorts", () => {
    const all = [
      ...earningsEvents(fundamentals.Earnings.History, TODAY),
      ...dividendEvents(divs, TODAY),
      ...splitEvents(splits, TODAY),
    ];
    const sel = selectEvents(all, t("2026-01-01"), t("2026-09-24"));
    expect(sel.map((e) => `${e.label}${new Date(e.time * 1000).toISOString().slice(0, 10)}`)).toEqual([
      "E2026-01-29",
      "D2026-02-09",
      "E2026-04-30",
      "D2026-05-11",
      "E2026-07-30",
      "D2026-08-10",
      "E2026-10-29",
    ]);
  });
});
