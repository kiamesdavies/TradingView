import { describe, expect, test } from "bun:test";
import { WsClient, backoffDelay, type SocketLike } from "./ws";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {}
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.({}); }
  drop() { this.readyState = 3; this.onclose?.({}); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const client = new WsClient({
    url: () => "ws://test/ws",
    createSocket: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    backoffBaseMs: 1, backoffMaxMs: 4, jitter: 0, pingIntervalMs: 60_000,
  });
  return { client, sockets, last: () => sockets[sockets.length - 1] };
}

describe("backoffDelay", () => {
  test("doubles and caps", () => {
    expect(backoffDelay(0, 500, 15000)).toBe(500);
    expect(backoffDelay(3, 500, 15000)).toBe(4000);
    expect(backoffDelay(10, 500, 15000)).toBe(15000);
    expect(backoffDelay(0, 1000, 15000, 0.5, () => 1)).toBe(1500);
  });
});

describe("WsClient", () => {
  test("sends subscribe/unsubscribe only on 0<->1 transitions", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    client.subscribe(["AAPL.US", "MSFT.US"]);
    client.subscribe(["AAPL.US"]);
    client.unsubscribe(["AAPL.US"]);
    client.unsubscribe(["AAPL.US", "MSFT.US"]);
    client.unsubscribe(["AAPL.US"]); // extra release is a no-op
    expect(last().sent).toEqual([
      { type: "subscribe", symbols: ["AAPL.US", "MSFT.US"] },
      { type: "unsubscribe", symbols: ["AAPL.US", "MSFT.US"] },
    ]);
    expect(client.subscribedSymbols()).toEqual([]);
  });

  test("release fn is idempotent and dedupes symbols", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    const release = client.subscribe(["BTC-USD.CC", "BTC-USD.CC"]);
    expect(client.refCount("BTC-USD.CC")).toBe(1);
    release();
    release();
    expect(client.refCount("BTC-USD.CC")).toBe(0);
    expect(last().sent.length).toBe(2);
  });

  test("subscriptions made before open are sent on open, and replayed after reconnect", async () => {
    const { client, sockets, last } = setup();
    client.subscribe(["AAPL.US"]);
    client.connect();
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([{ type: "subscribe", symbols: ["AAPL.US"] }]);

    const states: boolean[] = [];
    client.onConnection((c) => states.push(c));
    last().drop();
    expect(client.connected).toBe(false);
    await Bun.sleep(10);
    expect(sockets.length).toBe(2);
    client.subscribe(["MSFT.US"]); // while closed: not sent, replayed on open
    last().open();
    expect(last().sent).toEqual([{ type: "subscribe", symbols: ["AAPL.US", "MSFT.US"] }]);
    expect(states).toEqual([false, true]);
    client.disconnect();
  });

  test("dispatches typed messages by type and supports off()", () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    const prices: number[] = [];
    const off = client.on("tick", (m) => prices.push(m.tick.price));
    let statuses = 0;
    client.on("status", () => statuses++);
    last().receive({ type: "tick", tick: { symbol: "AAPL.US", price: 1, volume: 0, time: 0 } });
    last().receive({ type: "status", upstream: "connected" });
    off();
    last().receive({ type: "tick", tick: { symbol: "AAPL.US", price: 2, volume: 0, time: 0 } });
    last().onmessage?.({ data: "not json" });
    expect(prices).toEqual([1]);
    expect(statuses).toBe(1);
    client.disconnect();
  });

  test("disconnect stops reconnecting", async () => {
    const { client, sockets, last } = setup();
    client.connect();
    last().open();
    client.disconnect();
    await Bun.sleep(10);
    expect(sockets.length).toBe(1);
    expect(sockets[0].closed).toBe(true);
  });
});
