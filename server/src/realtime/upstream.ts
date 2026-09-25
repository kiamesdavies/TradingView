// One EODHD websocket connection (one feed, ≤ MAX_PER_CONNECTION symbols) with auth handshake,
// incremental subscribe/unsubscribe, and reconnect with exponential backoff.
import type { Tick } from "@eodview/shared";
import { parseUpstreamMessage, type Feed } from "./symbols";

export const UPSTREAM_BASE = "wss://ws.eodhistoricaldata.com/ws";
export const MAX_PER_CONNECTION = 50;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** If the server never sends the "Authorized" frame, subscribe anyway after this long. */
const AUTH_FALLBACK_MS = 4_000;

export type UpstreamState = "idle" | "connecting" | "connected" | "backoff" | "no_key" | "closed";

/** Minimal slice of the WHATWG WebSocket we rely on (lets tests inject a fake). */
export interface WsLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WsFactory = (url: string) => WsLike;

export interface UpstreamOptions {
  getKey: () => string | null;
  onTick: (t: Tick) => void;
  onStateChange: () => void;
  wsFactory?: WsFactory;
  baseUrl?: string;
}

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
}

const WS_OPEN = 1;

export class UpstreamConnection {
  readonly codes = new Set<string>();
  state: UpstreamState = "idle";
  lastError: string | null = null;
  nextRetryAt: number | null = null;

  private ws: WsLike | null = null;
  private authorized = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSub = new Set<string>();
  private pendingUnsub = new Set<string>();
  private flushQueued = false;
  private readonly factory: WsFactory;

  constructor(readonly feed: Feed, private readonly opts: UpstreamOptions) {
    this.factory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  get size(): number { return this.codes.size; }

  add(codes: Iterable<string>): void {
    if (this.state === "closed") return;
    for (const c of codes) {
      if (this.codes.has(c)) continue;
      this.codes.add(c);
      this.pendingUnsub.delete(c);
      this.pendingSub.add(c);
    }
    if (this.codes.size === 0) return;
    if (!this.ws && this.state !== "backoff") this.connect();
    else this.queueFlush();
  }

  remove(codes: Iterable<string>): void {
    for (const c of codes) {
      if (!this.codes.delete(c)) continue;
      this.pendingSub.delete(c);
      this.pendingUnsub.add(c);
    }
    if (this.codes.size === 0) this.shutdown("idle");
    else this.queueFlush();
  }

  /** Drop the socket and reconnect now (e.g. after an API key change). */
  restart(): void {
    if (this.state === "closed") return;
    this.teardownSocket();
    this.clearRetry();
    this.attempt = 0;
    this.lastError = null;
    if (this.codes.size > 0) this.connect();
    else this.setState("idle");
  }

  /** Permanently close this connection. */
  close(): void {
    this.shutdown("closed");
  }

  private shutdown(state: "idle" | "closed"): void {
    this.teardownSocket();
    this.clearRetry();
    this.attempt = 0;
    this.pendingSub.clear();
    this.pendingUnsub.clear();
    this.setState(state);
  }

  private connect(): void {
    this.clearRetry();
    const key = this.opts.getKey();
    if (!key) {
      this.lastError = "no API key configured";
      this.setState("no_key");
      return;
    }
    const url = `${this.opts.baseUrl ?? UPSTREAM_BASE}/${this.feed}?api_token=${encodeURIComponent(key)}`;
    let ws: WsLike;
    try {
      ws = this.factory(url);
    } catch (e) {
      this.lastError = `connect failed: ${(e as Error).message}`;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.authorized = false;
    this.setState("connecting");

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.authTimer = setTimeout(() => {
        if (this.ws === ws && !this.authorized) this.onAuthorized();
      }, AUTH_FALLBACK_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const raw = typeof ev.data === "string" ? ev.data : ev.data instanceof Uint8Array ? new TextDecoder().decode(ev.data) : String(ev.data);
      const e = parseUpstreamMessage(this.feed, raw);
      switch (e.kind) {
        case "authorized":
          if (!this.authorized) this.onAuthorized();
          break;
        case "error":
          this.lastError = `${e.status} ${e.message}`;
          break;
        case "tick": {
          const code = e.tick.symbol.slice(0, e.tick.symbol.lastIndexOf("."));
          if (this.codes.has(code)) this.opts.onTick(e.tick);
          break;
        }
        case "ignored":
          break;
      }
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (!this.lastError) this.lastError = "socket error";
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authorized = false;
      this.clearAuthTimer();
      if (ev.code !== 1000 && !this.lastError) this.lastError = `closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`;
      if (this.state === "closed" || this.codes.size === 0) {
        this.setState(this.state === "closed" ? "closed" : "idle");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private onAuthorized(): void {
    this.clearAuthTimer();
    this.authorized = true;
    this.attempt = 0;
    this.lastError = null;
    // Fresh socket: subscribe to the full set; nothing to unsubscribe.
    this.pendingUnsub.clear();
    this.pendingSub = new Set(this.codes);
    this.setState("connected");
    this.flush();
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || !this.authorized || ws.readyState !== WS_OPEN) return;
    try {
      if (this.pendingUnsub.size) ws.send(JSON.stringify({ action: "unsubscribe", symbols: [...this.pendingUnsub].join(",") }));
      if (this.pendingSub.size) ws.send(JSON.stringify({ action: "subscribe", symbols: [...this.pendingSub].join(",") }));
      this.pendingUnsub.clear();
      this.pendingSub.clear();
    } catch (e) {
      this.lastError = `send failed: ${(e as Error).message}`;
    }
  }

  private scheduleReconnect(): void {
    this.clearRetry();
    const delay = backoffDelay(this.attempt++);
    this.nextRetryAt = Date.now() + delay;
    this.setState("backoff");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      if (this.codes.size > 0 && this.state === "backoff") this.connect();
    }, delay);
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.authorized = false;
    this.clearAuthTimer();
    if (ws) {
      try { ws.close(1000, "eodview"); } catch { /* already closed */ }
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private setState(s: UpstreamState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange();
  }
}

/** All connections for one feed; shards symbols across connections of at most MAX_PER_CONNECTION. */
export class FeedPool {
  readonly conns: UpstreamConnection[] = [];

  constructor(readonly feed: Feed, private readonly opts: UpstreamOptions, private readonly maxPerConn = MAX_PER_CONNECTION) {}

  has(code: string): boolean {
    return this.conns.some((c) => c.codes.has(code));
  }

  add(code: string): void {
    if (this.has(code)) return;
    let conn = this.conns.find((c) => c.size < this.maxPerConn);
    if (!conn) {
      conn = new UpstreamConnection(this.feed, this.opts);
      this.conns.push(conn);
    }
    conn.add([code]);
  }

  remove(code: string): void {
    const i = this.conns.findIndex((c) => c.codes.has(code));
    if (i < 0) return;
    const conn = this.conns[i];
    conn.remove([code]);
    if (conn.size === 0) {
      conn.close();
      this.conns.splice(i, 1);
    }
  }

  restartAll(): void {
    for (const c of this.conns) c.restart();
  }
}
