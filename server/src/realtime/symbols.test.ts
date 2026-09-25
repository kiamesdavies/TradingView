import { describe, expect, test } from "bun:test";
import { fromUpstream, isStreamable, parseUpstreamMessage, toUpstream } from "./symbols";

describe("symbol mapping", () => {
  test("maps streamable exchanges", () => {
    expect(toUpstream("AAPL.US")).toEqual({ feed: "us", code: "AAPL" });
    expect(toUpstream("EURUSD.FOREX")).toEqual({ feed: "forex", code: "EURUSD" });
    expect(toUpstream("BTC-USD.CC")).toEqual({ feed: "crypto", code: "BTC-USD" });
    expect(toUpstream("brk-b.us")).toEqual({ feed: "us", code: "BRK-B" });
    expect(toUpstream("BRK.B.US")).toEqual({ feed: "us", code: "BRK.B" });
  });
  test("non-streamable exchanges and junk", () => {
    expect(toUpstream("GSPC.INDX")).toBeNull();
    expect(toUpstream("VOD.LSE")).toBeNull();
    expect(toUpstream("AAPL")).toBeNull();
    expect(toUpstream(".US")).toBeNull();
    expect(toUpstream("AAPL.")).toBeNull();
    expect(isStreamable("SPY.US")).toBe(true);
    expect(isStreamable("0700.HK")).toBe(false);
  });
  test("round trip", () => {
    for (const s of ["AAPL.US", "EURUSD.FOREX", "BTC-USD.CC"]) {
      const r = toUpstream(s)!;
      expect(fromUpstream(r.feed, r.code)).toBe(s);
    }
    expect(fromUpstream("crypto", "eth-usd")).toBe("ETH-USD.CC");
  });
});

describe("upstream message parsing", () => {
  test("auth + errors", () => {
    expect(parseUpstreamMessage("us", '{"status_code":200,"message":"Authorized"}')).toEqual({ kind: "authorized" });
    expect(parseUpstreamMessage("crypto", '{"status":403,"message":"Server error"}')).toEqual({ kind: "error", status: 403, message: "Server error" });
    expect(parseUpstreamMessage("us", "not json").kind).toBe("ignored");
    expect(parseUpstreamMessage("us", "[1,2]").kind).toBe("ignored");
  });
  test("us trade", () => {
    const e = parseUpstreamMessage("us", '{"s":"AAPL","p":335.95,"c":[],"v":12,"dp":false,"ms":"open","t":1790329995797}');
    expect(e).toEqual({ kind: "tick", tick: { symbol: "AAPL.US", price: 335.95, volume: 12, time: 1790329995797 } });
  });
  test("crypto with numeric strings", () => {
    const e = parseUpstreamMessage("crypto", '{"s":"BTC-USD","p":"84588","q":"0.002","dc":"0.2196","dd":"185.7","t":1790330111002}');
    expect(e).toEqual({ kind: "tick", tick: { symbol: "BTC-USD.CC", price: 84588, volume: 0.002, time: 1790330111002 } });
  });
  test("forex mid price, zero volume", () => {
    const e = parseUpstreamMessage("forex", '{"s":"EURUSD","a":1.2,"b":1.1,"dc":"0.06","dd":"0.0007","ppms":true,"t":1790330110001}');
    expect(e.kind).toBe("tick");
    if (e.kind !== "tick") return;
    expect(e.tick.symbol).toBe("EURUSD.FOREX");
    expect(e.tick.price).toBeCloseTo(1.15, 10);
    expect(e.tick.volume).toBe(0);
  });
  test("rejects ticks without a usable price", () => {
    expect(parseUpstreamMessage("us", '{"s":"AAPL","p":0,"v":1,"t":1}').kind).toBe("ignored");
    expect(parseUpstreamMessage("crypto", '{"s":"BTC-USD","p":"abc","t":1}').kind).toBe("ignored");
    expect(parseUpstreamMessage("us", '{"p":1,"v":1,"t":1}').kind).toBe("ignored");
  });
  test("missing volume/time are defaulted", () => {
    const e = parseUpstreamMessage("us", '{"s":"MSFT","p":400}');
    expect(e.kind).toBe("tick");
    if (e.kind === "tick") {
      expect(e.tick.volume).toBe(0);
      expect(e.tick.time).toBeGreaterThan(1_700_000_000_000);
    }
  });
});
