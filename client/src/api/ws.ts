import type { ClientMsg, ServerMsg, Symbol } from "@eodview/shared";

export type ServerMsgType = ServerMsg["type"];
export type ServerMsgOf<T extends ServerMsgType> = Extract<ServerMsg, { type: T }>;
export type ServerMsgHandler<T extends ServerMsgType> = (msg: ServerMsgOf<T>) => void;
export type ConnectionHandler = (connected: boolean) => void;

/** Minimal slice of the DOM WebSocket the client relies on (lets tests inject a fake). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WsClientOptions {
  /** Resolved lazily on every (re)connect. */
  url?: () => string;
  createSocket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 0..1 fraction of random jitter added to each backoff delay. */
  jitter?: number;
}

const OPEN = 1;

function defaultUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/** Delay before reconnect attempt `attempt` (0-based): base * 2^attempt capped at max, plus jitter. */
export function backoffDelay(attempt: number, base: number, max: number, jitter = 0, rand: () => number = Math.random): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(raw + raw * jitter * rand());
}

/**
 * Browser <-> server socket. Subscriptions are ref-counted per symbol across all callers:
 * `subscribe` / `unsubscribe` must be paired, and the server only hears about 0 <-> 1 transitions.
 * All held subscriptions are replayed after every reconnect.
 */
export class WsClient {
  private socket: SocketLike | null = null;
  private readonly refs = new Map<Symbol, number>();
  private readonly listeners = new Map<ServerMsgType, Set<(msg: ServerMsg) => void>>();
  private readonly connListeners = new Set<ConnectionHandler>();
  private wanted = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPong = 0;
  private isOpen = false;
  private readonly opts: Required<WsClientOptions>;

  constructor(opts: WsClientOptions = {}) {
    this.opts = {
      url: opts.url ?? defaultUrl,
      createSocket: opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      pingIntervalMs: opts.pingIntervalMs ?? 25_000,
      backoffBaseMs: opts.backoffBaseMs ?? 500,
      backoffMaxMs: opts.backoffMaxMs ?? 15_000,
      jitter: opts.jitter ?? 0.25,
    };
  }

  get connected(): boolean {
    return this.isOpen;
  }

  /** Symbols with at least one holder. */
  subscribedSymbols(): Symbol[] {
    return [...this.refs.keys()];
  }

  refCount(symbol: Symbol): number {
    return this.refs.get(symbol) ?? 0;
  }

  /** Idempotent. */
  connect(): void {
    this.wanted = true;
    if (this.socket || this.reconnectTimer) return;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.clearReconnect();
    const s = this.socket;
    this.teardown();
    s?.close(1000, "client disconnect");
  }

  /** Force a fresh connection now (e.g. browser came back online). */
  reconnectNow(): void {
    if (!this.wanted) return;
    this.clearReconnect();
    this.attempt = 0;
    const s = this.socket;
    this.teardown();
    s?.close(4000, "reconnect");
    this.open();
  }

  /**
   * Take one reference on each symbol. Returns a function that releases exactly these references
   * (safe to call more than once).
   */
  subscribe(symbols: readonly Symbol[]): () => void {
    const list = uniq(symbols);
    const added: Symbol[] = [];
    for (const s of list) {
      const n = this.refs.get(s) ?? 0;
      this.refs.set(s, n + 1);
      if (n === 0) added.push(s);
    }
    if (added.length) this.send({ type: "subscribe", symbols: added });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unsubscribe(list);
    };
  }

  /** Release one reference on each symbol. */
  unsubscribe(symbols: readonly Symbol[]): void {
    const removed: Symbol[] = [];
    for (const s of uniq(symbols)) {
      const n = this.refs.get(s) ?? 0;
      if (n <= 0) continue;
      if (n === 1) {
        this.refs.delete(s);
        removed.push(s);
      } else this.refs.set(s, n - 1);
    }
    if (removed.length) this.send({ type: "unsubscribe", symbols: removed });
  }

  on<T extends ServerMsgType>(type: T, cb: ServerMsgHandler<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const fn = cb as (msg: ServerMsg) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  onConnection(cb: ConnectionHandler): () => void {
    this.connListeners.add(cb);
    return () => {
      this.connListeners.delete(cb);
    };
  }

  // ---------- internals ----------

  private open(): void {
    let socket: SocketLike;
    try {
      socket = this.opts.createSocket(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.isOpen = true;
      this.awaitingPong = 0;
      const all = this.subscribedSymbols();
      if (all.length) this.send({ type: "subscribe", symbols: all });
      this.startPing();
      this.emitConnection(true);
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // onclose follows; nothing to do here.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const wasOpen = this.isOpen;
      this.teardown();
      if (wasOpen) this.emitConnection(false);
      if (this.wanted) this.scheduleReconnect();
    };
  }

  private teardown(): void {
    this.stopPing();
    if (this.socket) {
      this.socket.onopen = this.socket.onclose = this.socket.onerror = null;
      this.socket.onmessage = null;
    }
    this.socket = null;
    this.isOpen = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.wanted) return;
    const delay = backoffDelay(this.attempt++, this.opts.backoffBaseMs, this.opts.backoffMaxMs, this.opts.jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && !this.socket) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Two missed pongs in a row: the connection is likely dead even if the socket has not noticed.
      if (this.awaitingPong >= 2) {
        const s = this.socket;
        const wasOpen = this.isOpen;
        this.teardown();
        s?.close(4001, "ping timeout");
        if (wasOpen) this.emitConnection(false);
        this.scheduleReconnect();
        return;
      }
      this.awaitingPong++;
      this.send({ type: "ping" });
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(msg: ClientMsg): void {
    const s = this.socket;
    if (!s || !this.isOpen || s.readyState !== OPEN) return; // replayed on (re)open
    try {
      s.send(JSON.stringify(msg));
    } catch {
      // socket died between checks; onclose will handle reconnect
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    this.awaitingPong = 0; // any traffic proves liveness
    const set = this.listeners.get(msg.type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (e) {
        console.error(`[ws] ${msg.type} handler failed`, e);
      }
    }
  }

  private emitConnection(connected: boolean): void {
    for (const fn of [...this.connListeners]) {
      try {
        fn(connected);
      } catch (e) {
        console.error("[ws] connection handler failed", e);
      }
    }
  }
}

function uniq(symbols: readonly Symbol[]): Symbol[] {
  const out: Symbol[] = [];
  const seen = new Set<Symbol>();
  for (const raw of symbols) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export const wsClient = new WsClient();

if (typeof window !== "undefined") {
  window.addEventListener("online", () => wsClient.reconnectNow());
}
