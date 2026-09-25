import { expect, test } from "bun:test";
import type { Tick } from "@eodview/shared";
import { backoffDelay, FeedPool, UpstreamConnection, type WsLike } from "./upstream";

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: '{"status_code":200,"message":"Authorized"}' }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: "" }); }
  msg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("backoff doubles from 1s and caps at 30s", () => {
  expect([0, 1, 2, 3, 4, 5, 6, 10].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("connects lazily, subscribes after auth, filters ticks, unsubscribes, closes when empty", async () => {
  FakeWs.all = [];
  const ticks: Tick[] = [];
  const c = new UpstreamConnection("us", {
    getKey: () => "k", onTick: (t) => ticks.push(t), onStateChange: () => {}, wsFactory: (u) => new FakeWs(u),
  });
  expect(FakeWs.all).toHaveLength(0);
  c.add(["AAPL", "MSFT"]);
  expect(FakeWs.all).toHaveLength(1);
  const ws = FakeWs.all[0];
  expect(ws.url).toBe("wss://ws.eodhistoricaldata.com/ws/us?api_token=k");
  expect(c.state).toBe("connecting");
  ws.open();
  expect(c.state).toBe("connected");
  expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ action: "subscribe", symbols: "AAPL,MSFT" }]);

  ws.msg({ s: "AAPL", p: 10, v: 1, t: 5 });
  ws.msg({ s: "TSLA", p: 10, v: 1, t: 5 });
  expect(ticks.map((t) => t.symbol)).toEqual(["AAPL.US"]);

  c.add(["NVDA"]);
  c.remove(["MSFT"]);
  await flush();
  expect(ws.sent.slice(1).map((s) => JSON.parse(s))).toEqual([
    { action: "unsubscribe", symbols: "MSFT" },
    { action: "subscribe", symbols: "NVDA" },
  ]);

  c.remove(["AAPL", "NVDA"]);
  expect(c.state).toBe("idle");
  expect(ws.readyState).toBe(3);
});

test("reconnects with backoff and resubscribes the full set", async () => {
  FakeWs.all = [];
  const c = new UpstreamConnection("crypto", {
    getKey: () => "k", onTick: () => {}, onStateChange: () => {}, wsFactory: (u) => new FakeWs(u),
  });
  c.add(["BTC-USD"]);
  FakeWs.all[0].open();
  FakeWs.all[0].drop();
  expect(c.state).toBe("backoff");
  expect(c.nextRetryAt! - Date.now()).toBeGreaterThan(900);
  c.restart(); // skip the wait
  expect(FakeWs.all).toHaveLength(2);
  FakeWs.all[1].open();
  expect(JSON.parse(FakeWs.all[1].sent[0])).toEqual({ action: "subscribe", symbols: "BTC-USD" });
  c.close();
});

test("no key → no_key state, no socket", () => {
  FakeWs.all = [];
  const c = new UpstreamConnection("forex", {
    getKey: () => null, onTick: () => {}, onStateChange: () => {}, wsFactory: (u) => new FakeWs(u),
  });
  c.add(["EURUSD"]);
  expect(c.state).toBe("no_key");
  expect(FakeWs.all).toHaveLength(0);
  c.close();
});

test("pool shards at the per-connection limit and drops empty connections", () => {
  FakeWs.all = [];
  const pool = new FeedPool("us", { getKey: () => "k", onTick: () => {}, onStateChange: () => {}, wsFactory: (u) => new FakeWs(u) }, 2);
  pool.add("A"); pool.add("B"); pool.add("C"); pool.add("A");
  expect(pool.conns.map((c) => [...c.codes])).toEqual([["A", "B"], ["C"]]);
  pool.remove("C");
  expect(pool.conns).toHaveLength(1);
  pool.remove("A"); pool.remove("B");
  expect(pool.conns).toHaveLength(0);
});
