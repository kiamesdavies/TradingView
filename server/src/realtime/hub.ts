// Realtime hub: browser /ws sockets <-> ref-counted EODHD upstream websocket subscriptions,
// per-symbol throttled tick fan-out, and a 60s quote-polling fallback for non-streamable symbols.
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ClientMsg, Quote, ServerMsg, Symbol, Tick } from "@eodview/shared";
import { config } from "../config/config";
import { eodhd } from "../eodhd/client";
import { normalizeSymbol } from "../store/validate";
import { FEEDS, toUpstream, type Feed } from "./symbols";
import { FeedPool, type UpstreamConnection } from "./upstream";
import { TickThrottle } from "./throttle";

type WsData = { id: string };
type Socket = ServerWebSocket<WsData>;
type StatusMsg = Extract<ServerMsg, { type: "status" }>;

const TICK_INTERVAL_MS = 100;          // ≤ 10 tick msgs / sec / symbol to browsers
const POLL_INTERVAL_MS = 60_000;       // non-streamable quote polling
const POLL_BATCH = 20;                 // symbols per eodhd.realtime call
const RELEASE_GRACE_MS = 5_000;        // keep upstream subscription briefly after last owner leaves (page reloads)
const SNAPSHOT_FRESH_MS = 15_000;      // reuse a cached quote this fresh for subscribe snapshots
const MAX_SYMBOLS_PER_SOCKET = 500;
const INTERNAL_PREFIX = "owner:";

const sockets = new Map<string, Socket>();
/** symbol → owner ids (browser socket ids and `owner:<name>` internal owners) */
const owners = new Map<Symbol, Set<string>>();
/** browser socket id → symbols it subscribed */
const socketSubs = new Map<string, Set<Symbol>>();
/** symbol → browser socket ids (fan-out index) */
const symbolSockets = new Map<Symbol, Set<string>>();
/** internal owner id → symbols */
const internalSubs = new Map<string, Set<Symbol>>();
const releaseTimers = new Map<Symbol, ReturnType<typeof setTimeout>>();
/** upstream-active symbols without a websocket feed (served by polling) */
const polled = new Set<Symbol>();
const lastQuotes = new Map<Symbol, { quote: Quote; at: number }>();

const tickListeners = new Set<(t: Tick) => void>();
const quoteListeners = new Set<(q: Quote) => void>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let lastStatusJson = "";

const throttle = new TickThrottle(TICK_INTERVAL_MS, (t) => sendToSymbol(t.symbol, { type: "tick", tick: t }));

const upstreamOpts = {
  getKey: () => config.getKey(),
  onTick: handleUpstreamTick,
  onStateChange: () => publishStatusIfChanged(),
};
const pools: Record<Feed, FeedPool> = {
  us: new FeedPool("us", upstreamOpts),
  forex: new FeedPool("forex", upstreamOpts),
  crypto: new FeedPool("crypto", upstreamOpts),
};

config.onKeyChange(() => {
  lastQuotes.clear();
  for (const f of FEEDS) pools[f].restartAll();
  publishStatusIfChanged();
  if (polled.size) void pollQuotes();
});

// ---------------------------------------------------------------- sending

function send(ws: Socket, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket closing; its close handler cleans up */
  }
}

function sendToSymbol(symbol: Symbol, msg: ServerMsg): void {
  const ids = symbolSockets.get(symbol);
  if (!ids || ids.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const id of ids) {
    const ws = sockets.get(id);
    if (!ws) continue;
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

function broadcast(msg: ServerMsg): void {
  const payload = JSON.stringify(msg);
  for (const ws of sockets.values()) {
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- status

function describeConn(c: UpstreamConnection): string {
  const retry = c.nextRetryAt ? `, retry in ${Math.max(0, Math.round((c.nextRetryAt - Date.now()) / 1000))}s` : "";
  return `${c.feed} ${c.state}${c.lastError ? ` (${c.lastError})` : ""}${retry}`;
}

function status(): StatusMsg {
  if (!config.getKey()) return { type: "status", upstream: "no_key", detail: "No EODHD API key configured" };
  const conns = FEEDS.flatMap((f) => pools[f].conns);
  if (conns.length === 0) {
    return { type: "status", upstream: "connected", detail: polled.size ? `polling ${polled.size} symbol(s)` : "idle" };
  }
  // A first connection attempt still in progress is not an outage (avoids red flicker on every new feed).
  const down = conns.filter((c) => c.state !== "connected" && !(c.state === "connecting" && !c.lastError));
  if (down.length === 0) {
    const n = conns.reduce((a, c) => a + c.size, 0);
    const pending = conns.some((c) => c.state !== "connected");
    return { type: "status", upstream: "connected", detail: pending ? "connecting" : `streaming ${n} symbol(s)` };
  }
  if (down.every((c) => c.state === "no_key")) return { type: "status", upstream: "no_key", detail: "No EODHD API key configured" };
  return { type: "status", upstream: "disconnected", detail: down.map(describeConn).join("; ") };
}

function publishStatusIfChanged(): void {
  const s = status();
  // Ignore the countdown in detail when deciding whether anything changed.
  const key = JSON.stringify({ u: s.upstream, d: s.detail?.replace(/retry in \d+s/g, "") });
  if (key === lastStatusJson) return;
  lastStatusJson = key;
  broadcast(s);
}

// ---------------------------------------------------------------- upstream ticks & quotes

function handleUpstreamTick(t: Tick): void {
  if (!owners.has(t.symbol)) return;
  for (const cb of tickListeners) {
    try { cb(t); } catch (e) { console.error("[hub] tick listener failed", e); }
  }
  throttle.push(t);
}

function emitQuote(q: Quote, onlySocket?: Socket): void {
  lastQuotes.set(q.symbol, { quote: q, at: Date.now() });
  if (onlySocket) send(onlySocket, { type: "quote", quote: q });
  else sendToSymbol(q.symbol, { type: "quote", quote: q });
  for (const cb of quoteListeners) {
    try { cb(q); } catch (e) { console.error("[hub] quote listener failed", e); }
  }
}

async function fetchQuotes(symbols: Symbol[]): Promise<Quote[]> {
  if (!config.getKey() || symbols.length === 0) return [];
  const out: Quote[] = [];
  for (let i = 0; i < symbols.length; i += POLL_BATCH) {
    const batch = symbols.slice(i, i + POLL_BATCH);
    try {
      const qs = await eodhd.realtime(batch);
      for (const q of qs) {
        const sym = normalizeSymbol(q.symbol);
        if (sym && Number.isFinite(q.price) && q.price > 0) out.push(sym === q.symbol ? q : { ...q, symbol: sym });
      }
    } catch (e) {
      console.warn(`[hub] realtime quotes failed for ${batch.join(",")}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function pollQuotes(): Promise<void> {
  if (pollRunning || polled.size === 0) return;
  pollRunning = true;
  try {
    const quotes = await fetchQuotes([...polled]);
    for (const q of quotes) if (owners.has(q.symbol)) emitQuote(q);
  } finally {
    pollRunning = false;
  }
}

async function sendSnapshots(ws: Socket, symbols: Symbol[]): Promise<void> {
  const now = Date.now();
  const missing: Symbol[] = [];
  for (const s of symbols) {
    const c = lastQuotes.get(s);
    if (c && now - c.at < SNAPSHOT_FRESH_MS) send(ws, { type: "quote", quote: c.quote });
    else missing.push(s);
  }
  const quotes = await fetchQuotes(missing);
  for (const q of quotes) {
    if (!sockets.has(ws.data.id) || !socketSubs.get(ws.data.id)?.has(q.symbol)) {
      lastQuotes.set(q.symbol, { quote: q, at: Date.now() });
      continue;
    }
    emitQuote(q, ws);
  }
}

function updatePollTimer(): void {
  if (polled.size > 0 && !pollTimer) {
    pollTimer = setInterval(() => void pollQuotes(), POLL_INTERVAL_MS);
  } else if (polled.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---------------------------------------------------------------- ref counting

function startUpstream(symbol: Symbol): void {
  const ref = toUpstream(symbol);
  if (ref) pools[ref.feed].add(ref.code);
  else {
    polled.add(symbol);
    updatePollTimer();
  }
}

function stopUpstream(symbol: Symbol): void {
  const ref = toUpstream(symbol);
  if (ref) pools[ref.feed].remove(ref.code);
  else {
    polled.delete(symbol);
    updatePollTimer();
  }
  throttle.forget(symbol);
}

function acquire(symbol: Symbol, owner: string): void {
  let set = owners.get(symbol);
  if (!set) {
    set = new Set();
    owners.set(symbol, set);
    const pending = releaseTimers.get(symbol);
    if (pending) {
      clearTimeout(pending);
      releaseTimers.delete(symbol);
    } else {
      startUpstream(symbol);
    }
  }
  set.add(owner);
}

function release(symbol: Symbol, owner: string): void {
  const set = owners.get(symbol);
  if (!set || !set.delete(owner) || set.size > 0) return;
  owners.delete(symbol);
  if (releaseTimers.has(symbol)) return;
  releaseTimers.set(
    symbol,
    setTimeout(() => {
      releaseTimers.delete(symbol);
      if (!owners.has(symbol)) {
        stopUpstream(symbol);
        publishStatusIfChanged();
      }
    }, RELEASE_GRACE_MS),
  );
}

function subscribeSocket(ws: Socket, raw: unknown[]): void {
  const id = ws.data.id;
  const subs = socketSubs.get(id);
  if (!subs) return;
  const added: Symbol[] = [];
  for (const r of raw) {
    const s = normalizeSymbol(r);
    if (!s || subs.has(s)) continue;
    if (subs.size >= MAX_SYMBOLS_PER_SOCKET) break;
    subs.add(s);
    let ids = symbolSockets.get(s);
    if (!ids) symbolSockets.set(s, (ids = new Set()));
    ids.add(id);
    acquire(s, id);
    added.push(s);
  }
  if (added.length) {
    publishStatusIfChanged();
    void sendSnapshots(ws, added);
  }
}

function unsubscribeSocket(id: string, raw: Iterable<unknown>): void {
  const subs = socketSubs.get(id);
  if (!subs) return;
  for (const r of raw) {
    const s = normalizeSymbol(r);
    if (!s || !subs.delete(s)) continue;
    const ids = symbolSockets.get(s);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) symbolSockets.delete(s);
    }
    release(s, id);
  }
}

function parseClientMsg(data: string | Buffer): ClientMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as { type?: unknown; symbols?: unknown };
  if (o.type === "ping") return { type: "ping" };
  if ((o.type === "subscribe" || o.type === "unsubscribe") && Array.isArray(o.symbols)) {
    return { type: o.type, symbols: o.symbols.filter((s): s is string => typeof s === "string") };
  }
  return null;
}

// ---------------------------------------------------------------- public API

const websocket: WebSocketHandler<WsData> = {
  open(ws) {
    sockets.set(ws.data.id, ws);
    socketSubs.set(ws.data.id, new Set());
    send(ws, status());
  },
  message(ws, data) {
    const msg = parseClientMsg(data);
    if (!msg) return;
    switch (msg.type) {
      case "ping":
        send(ws, { type: "pong" });
        break;
      case "subscribe":
        subscribeSocket(ws, msg.symbols);
        break;
      case "unsubscribe":
        unsubscribeSocket(ws.data.id, msg.symbols);
        break;
    }
  },
  close(ws) {
    const id = ws.data.id;
    const subs = socketSubs.get(id);
    if (subs) unsubscribeSocket(id, [...subs]);
    socketSubs.delete(id);
    sockets.delete(id);
  },
};

export const hub = {
  websocket,

  broadcast,

  /** Raw (unthrottled) upstream ticks for every subscribed streamable symbol. */
  onTick(cb: (t: Tick) => void): () => void {
    tickListeners.add(cb);
    return () => { tickListeners.delete(cb); };
  },

  /** Extension: quote snapshots (polling fallback + subscribe snapshots). */
  onQuote(cb: (q: Quote) => void): () => void {
    quoteListeners.add(cb);
    return () => { quoteListeners.delete(cb); };
  },

  /**
   * Declare the full set of symbols an internal owner (e.g. "alerts") needs kept alive upstream.
   * Replaces that owner's previous set: symbols not listed are released.
   */
  ensureSubscribed(symbols: Symbol[], ownerId: string): void {
    const owner = INTERNAL_PREFIX + ownerId;
    const next = new Set<Symbol>();
    for (const r of symbols) {
      const s = normalizeSymbol(r);
      if (s) next.add(s);
    }
    const prev = internalSubs.get(owner) ?? new Set<Symbol>();
    for (const s of prev) if (!next.has(s)) release(s, owner);
    const added: Symbol[] = [];
    for (const s of next) {
      if (!prev.has(s)) {
        acquire(s, owner);
        added.push(s);
      }
    }
    if (next.size) internalSubs.set(owner, next);
    else internalSubs.delete(owner);
    publishStatusIfChanged();
    // Prime newly-added non-streamable symbols so alert evaluation has a baseline before the next poll.
    const prime = added.filter((s) => polled.has(s));
    if (prime.length) {
      void fetchQuotes(prime).then((qs) => { for (const q of qs) if (owners.has(q.symbol)) emitQuote(q); });
    }
  },

  status,

  /** Diagnostics: current upstream subscription picture. */
  debug() {
    return {
      sockets: sockets.size,
      symbols: Object.fromEntries([...owners].map(([s, o]) => [s, o.size])),
      polled: [...polled],
      feeds: Object.fromEntries(FEEDS.map((f) => [f, pools[f].conns.map((c) => ({ state: c.state, symbols: [...c.codes], error: c.lastError }))])),
    };
  },
};
