import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Quote, ServerMsg, Symbol, Tick } from "@eodview/shared";

// engine.ts imports the shared db module: point it at a throwaway directory before importing.
process.env.EODVIEW_DATA_DIR ??= mkdtempSync(join(tmpdir(), "eodview-alerts-"));
const { createAlertEngine } = await import("./engine");
const { createAlertRepo } = await import("./repo");

function setup() {
  const repo = createAlertRepo(new Database(":memory:"));
  let tickCb: (t: Tick) => void = () => {};
  let quoteCb: (q: Quote) => void = () => {};
  const sent: ServerMsg[] = [];
  const subs: Symbol[][] = [];
  let now = 1_800_000_000_000;
  const engine = createAlertEngine(repo, {
    onTick: (cb) => { tickCb = cb; return () => {}; },
    onQuote: (cb) => { quoteCb = cb; return () => {}; },
    ensureSubscribed: (s) => { subs.push([...s].sort()); },
    broadcast: (m) => { sent.push(m); },
  }, () => now);
  engine.start();
  return {
    repo, engine, sent, subs,
    tick: (symbol: Symbol, price: number) => tickCb({ symbol, price, volume: 1, time: now }),
    quote: (symbol: Symbol, price: number) => quoteCb({ symbol, price, change: 0, changePct: 0, volume: 0, prevClose: price, time: now / 1000 }),
    advance: (ms: number) => { now += ms; },
  };
}

test("one-shot alert fires once, is deactivated, recorded and broadcast", () => {
  const s = setup();
  const a = s.repo.create({ symbol: "AAPL.US", price: 100, condition: "cross_up", repeat: false, note: "breakout" });
  s.engine.refresh();
  expect(s.subs.at(-1)).toEqual(["AAPL.US"]);
  s.tick("AAPL.US", 99);
  s.tick("AAPL.US", 100.5);
  s.tick("AAPL.US", 99);
  s.tick("AAPL.US", 101);
  expect(s.sent).toHaveLength(1);
  const msg = s.sent[0];
  expect(msg.type).toBe("alert");
  if (msg.type === "alert") {
    expect(msg.event).toMatchObject({ alertId: a.id, symbol: "AAPL.US", price: 100, tickPrice: 100.5, condition: "cross_up", note: "breakout" });
  }
  const stored = s.repo.get(a.id)!;
  expect(stored.active).toBe(false);
  expect(stored.lastTriggeredAt).toBeNumber();
  expect(s.repo.history(10)).toHaveLength(1);
  expect(s.subs.at(-1)).toEqual([]);
});

test("repeating alert respects 60s cooldown", () => {
  const s = setup();
  s.repo.create({ symbol: "BTC-USD.CC", price: 50_000, condition: "cross", repeat: true });
  s.engine.refresh();
  s.tick("BTC-USD.CC", 49_990);
  s.tick("BTC-USD.CC", 50_010); // fires
  s.advance(10_000);
  s.tick("BTC-USD.CC", 49_990); // cooldown
  s.advance(55_000);
  s.tick("BTC-USD.CC", 50_010); // fires again
  expect(s.sent).toHaveLength(2);
  expect(s.repo.list()[0].active).toBe(true);
});

test("first observation is a baseline only", () => {
  const s = setup();
  s.repo.create({ symbol: "MSFT.US", price: 400, condition: "cross", repeat: false });
  s.engine.refresh();
  s.tick("MSFT.US", 410);
  expect(s.sent).toHaveLength(0);
});

test("quotes drive non-streamable symbols only", () => {
  const s = setup();
  s.repo.create({ symbol: "GSPC.INDX", price: 6000, condition: "cross_down", repeat: false });
  s.repo.create({ symbol: "SPY.US", price: 600, condition: "cross", repeat: false });
  s.engine.refresh();
  s.quote("GSPC.INDX", 6010);
  s.quote("GSPC.INDX", 5990);
  s.quote("SPY.US", 590);
  s.quote("SPY.US", 610);
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0].type === "alert" && s.sent[0].event.symbol).toBe("GSPC.INDX");
});

test("stale baseline is discarded when a symbol gains its first alert", () => {
  const s = setup();
  s.tick("NVDA.US", 90);
  s.advance(10 * 60_000);
  s.repo.create({ symbol: "NVDA.US", price: 100, condition: "cross", repeat: false });
  s.engine.refresh();
  s.tick("NVDA.US", 110);
  expect(s.sent).toHaveLength(0);
  s.tick("NVDA.US", 95);
  expect(s.sent).toHaveLength(1);
});

test("repo update/delete and history ordering", () => {
  const s = setup();
  const a = s.repo.create({ symbol: "AAPL.US", price: 100, condition: "cross", repeat: false, note: "x" });
  expect(s.repo.update(a.id, { price: 105, note: undefined, active: false })).toMatchObject({ price: 105, active: false });
  expect(s.repo.get(a.id)!.note).toBeUndefined();
  expect(s.repo.update("missing", { price: 1 })).toBeNull();
  s.repo.recordTrigger({ ...a, repeat: true }, 101, 10);
  s.repo.recordTrigger({ ...a, repeat: true }, 102, 20);
  expect(s.repo.history(10).map((e) => e.tickPrice)).toEqual([102, 101]);
  expect(s.repo.history(1)).toHaveLength(1);
  expect(s.repo.remove(a.id)).toBe(true);
  expect(s.repo.remove(a.id)).toBe(false);
  expect(s.repo.history(10)).toHaveLength(2); // history survives deletion
});
