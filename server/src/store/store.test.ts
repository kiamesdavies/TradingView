import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { HttpError } from "../http";
import { createLayoutStore } from "./layout";
import { createWatchlistStore, DEFAULT_WATCHLIST } from "./watchlists";
import { createDrawingStore } from "./drawings";
import { normalizeSymbol } from "./validate";
import { validateAlertInput, validateAlertPatch } from "../alerts/input";

function expect400(fn: () => unknown, msg?: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    if (msg) expect((e as HttpError).message).toMatch(msg);
    return;
  }
  throw new Error("expected HttpError 400");
}

describe("symbols", () => {
  test("normalize", () => {
    expect(normalizeSymbol(" aapl.us ")).toBe("AAPL.US");
    expect(normalizeSymbol("BTC-USD.CC")).toBe("BTC-USD.CC");
    expect(normalizeSymbol("BRK.B.US")).toBe("BRK.B.US");
    expect(normalizeSymbol("0700.HK")).toBe("0700.HK");
    expect(normalizeSymbol("AAPL")).toBeNull();
    expect(normalizeSymbol("AA PL.US")).toBeNull();
    expect(normalizeSymbol("<script>.US")).toBeNull();
    expect(normalizeSymbol(42)).toBeNull();
  });
});

describe("layout", () => {
  const valid = {
    symbol: "aapl.us", tf: "1D", chartType: "candles", theme: "dark", logScale: false,
    indicators: [{ id: "i1", type: "sma", params: { period: 20, source: "close" }, color: "#fff", visible: true }],
    recentSymbols: ["MSFT.US", "msft.us", "SPY.US"], activeWatchlistId: "w1", junk: 1,
  };
  test("null until saved, then round trip (normalized, unknown keys dropped)", () => {
    const s = createLayoutStore(new Database(":memory:"));
    expect(s.get()).toBeNull();
    const saved = s.put(valid);
    expect(saved.symbol).toBe("AAPL.US");
    expect(saved.recentSymbols).toEqual(["MSFT.US", "SPY.US"]);
    expect("junk" in saved).toBe(false);
    expect(s.get()).toEqual(saved);
    s.put({ ...valid, theme: "light" });
    expect(s.get()!.theme).toBe("light");
  });
  test("validation", () => {
    const s = createLayoutStore(new Database(":memory:"));
    expect400(() => s.put(null), /object/);
    expect400(() => s.put({ ...valid, tf: "2h" }), /tf must be one of/);
    expect400(() => s.put({ ...valid, symbol: "AAPL" }), /symbol/);
    expect400(() => s.put({ ...valid, chartType: "renko" }), /chartType/);
    expect400(() => s.put({ ...valid, indicators: [{ id: "x", type: "foo", params: {} }] }), /type/);
    expect400(() => s.put({ ...valid, indicators: [{ id: "x", type: "sma", params: { p: {} } }] }), /params/);
    expect400(() => s.put({ ...valid, logScale: "yes" }), /logScale/);
  });
});

describe("watchlists", () => {
  test("seeds default list once", () => {
    const db = new Database(":memory:");
    const s = createWatchlistStore(db);
    const lists = s.list();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe("Watchlist");
    expect(lists[0].symbols).toEqual(DEFAULT_WATCHLIST.symbols);
    s.remove(lists[0].id);
    expect(createWatchlistStore(db).list()).toHaveLength(0); // no re-seed after deletion
  });
  test("CRUD", () => {
    const s = createWatchlistStore(new Database(":memory:"));
    const w = s.create({ name: "  Tech  " });
    expect(w).toMatchObject({ name: "Tech", symbols: [] });
    const u = s.update(w.id, { id: w.id, name: "Tech2", symbols: ["nvda.us", "AMD.US", "NVDA.US"] });
    expect(u).toEqual({ id: w.id, name: "Tech2", symbols: ["NVDA.US", "AMD.US"] });
    expect(s.get(w.id)).toEqual(u);
    expect(s.list().map((x) => x.name)).toEqual(["Watchlist", "Tech2"]);
    expect(s.update("nope", { name: "x" })).toBeNull();
    expect(s.remove(w.id)).toBe(true);
    expect(s.remove(w.id)).toBe(false);
  });
  test("validation", () => {
    const s = createWatchlistStore(new Database(":memory:"));
    expect400(() => s.create({ name: "" }), /name/);
    expect400(() => s.create({}), /name/);
    const w = s.create({ name: "x" });
    expect400(() => s.update(w.id, { symbols: ["BAD"] }), /symbols\[0\]/);
    expect400(() => s.update(w.id, { id: "other", name: "y" }), /id/);
  });
});

describe("drawings", () => {
  const d = [
    { id: "d1", type: "trendline", points: [{ time: 1, price: 10 }, { time: 2, price: 11 }], color: "#f00", lineWidth: 2 },
    { id: "d2", type: "hline", points: [{ time: 1, price: 10 }], color: "#0f0", lineWidth: 1 },
  ];
  test("per-symbol replace", () => {
    const s = createDrawingStore(new Database(":memory:"));
    expect(s.get("AAPL.US")).toEqual([]);
    expect(s.put("AAPL.US", d)).toEqual(d as never);
    expect(s.get("AAPL.US")).toEqual(d as never);
    expect(s.get("MSFT.US")).toEqual([]);
    s.put("AAPL.US", [d[1]]);
    expect(s.get("AAPL.US")).toHaveLength(1);
    s.put("AAPL.US", []);
    expect(s.get("AAPL.US")).toEqual([]);
  });
  test("validation", () => {
    const s = createDrawingStore(new Database(":memory:"));
    expect400(() => s.put("AAPL.US", {}), /array/);
    expect400(() => s.put("AAPL.US", [{ ...d[1], points: [] }]), /1 point/);
    expect400(() => s.put("AAPL.US", [{ ...d[0], type: "circle" }]), /type/);
    expect400(() => s.put("AAPL.US", [{ ...d[1], points: [{ time: 1, price: "10" }] }]), /price/);
    expect400(() => s.put("AAPL.US", [d[0], d[0]]), /unique/);
  });
});

describe("alert input", () => {
  test("defaults and normalization", () => {
    expect(validateAlertInput({ symbol: "aapl.us", price: 100 })).toEqual({ symbol: "AAPL.US", price: 100, condition: "cross", repeat: false });
    expect(validateAlertInput({ symbol: "AAPL.US", price: 1, condition: "cross_up", repeat: true, note: " hi " }).note).toBe("hi");
  });
  test("validation", () => {
    expect400(() => validateAlertInput({ symbol: "AAPL.US", price: "100" }), /price/);
    expect400(() => validateAlertInput({ symbol: "AAPL.US", price: -1 }), /price/);
    expect400(() => validateAlertInput({ symbol: "AAPL.US", price: 1, condition: "above" }), /condition/);
    expect400(() => validateAlertInput({ price: 1 }), /symbol/);
    expect400(() => validateAlertPatch({ active: 1 }), /active/);
    expect(validateAlertPatch({ active: false, note: "" })).toEqual({ active: false, note: undefined });
  });
});
