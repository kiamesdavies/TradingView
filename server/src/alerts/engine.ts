// Alert engine: evaluates active alerts against streamed ticks (and polled quotes for non-streamable symbols).
import type { Alert, AlertEvent, Quote, ServerMsg, Symbol, Tick, UnixSeconds } from "@eodview/shared";
import { db } from "../db";
import { hub } from "../realtime/hub";
import { isStreamable } from "../realtime/symbols";
import { createAlertRepo, type AlertRepo } from "./repo";
import { shouldTrigger } from "./evaluate";

/** A remembered price older than this is not used as the baseline for a symbol that just gained alerts. */
const BASELINE_MAX_AGE_MS = 120_000;
const HUB_OWNER = "alerts";

export interface HubLike {
  onTick(cb: (t: Tick) => void): () => void;
  onQuote(cb: (q: Quote) => void): () => void;
  ensureSubscribed(symbols: Symbol[], ownerId: string): void;
  broadcast(msg: ServerMsg): void;
}

export function createAlertEngine(repo: AlertRepo, deps: HubLike, clock: () => number = Date.now) {
  let bySymbol = new Map<Symbol, Alert[]>();
  const last = new Map<Symbol, { price: number; at: number }>();
  let unsubs: Array<() => void> = [];

  function refresh(): void {
    const next = new Map<Symbol, Alert[]>();
    for (const a of repo.listActive()) {
      const list = next.get(a.symbol);
      if (list) list.push(a);
      else next.set(a.symbol, [a]);
    }
    const now = clock();
    for (const s of next.keys()) {
      if (bySymbol.has(s)) continue;
      const l = last.get(s);
      if (l && now - l.at > BASELINE_MAX_AGE_MS) last.delete(s);
    }
    bySymbol = next;
    deps.ensureSubscribed([...next.keys()], HUB_OWNER);
  }

  /** Feed one price observation; returns the events fired. */
  function observe(symbol: Symbol, price: number): AlertEvent[] {
    if (!Number.isFinite(price) || price <= 0) return [];
    const nowMs = clock();
    const prev = last.get(symbol)?.price;
    last.set(symbol, { price, at: nowMs });
    const alerts = bySymbol.get(symbol);
    if (!alerts || prev === undefined) return [];
    const nowSec: UnixSeconds = Math.floor(nowMs / 1000);
    const fired: AlertEvent[] = [];
    let deactivated = false;
    for (const a of alerts) {
      if (!shouldTrigger(a, prev, price, nowSec)) continue;
      let ev: AlertEvent;
      try {
        ev = repo.recordTrigger(a, price, nowSec);
      } catch (e) {
        console.error("[alerts] failed to record trigger", e);
        continue;
      }
      a.lastTriggeredAt = nowSec;
      if (!a.repeat) {
        a.active = false;
        deactivated = true;
      }
      fired.push(ev);
      deps.broadcast({ type: "alert", event: ev });
    }
    if (deactivated) {
      const remaining = alerts.filter((a) => a.active);
      if (remaining.length) bySymbol.set(symbol, remaining);
      else bySymbol.delete(symbol);
      deps.ensureSubscribed([...bySymbol.keys()], HUB_OWNER);
    }
    return fired;
  }

  function start(): void {
    if (unsubs.length) return;
    unsubs = [
      deps.onTick((t) => { observe(t.symbol, t.price); }),
      // Quotes can lag the stream; only use them for symbols that have no websocket feed.
      deps.onQuote((q) => { if (!isStreamable(q.symbol)) observe(q.symbol, q.price); }),
    ];
    refresh();
  }

  function stop(): void {
    for (const u of unsubs) u();
    unsubs = [];
  }

  return { refresh, observe, start, stop, repo };
}

export type AlertEngine = ReturnType<typeof createAlertEngine>;

export const alertRepo: AlertRepo = createAlertRepo(db);
export const alertEngine: AlertEngine = createAlertEngine(alertRepo, hub);

export function startAlertEngine(): void {
  alertEngine.start();
}
