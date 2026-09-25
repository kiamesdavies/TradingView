import type { Bar, BarsResponse, Quote, Symbol, Tick, Timeframe } from "@eodview/shared";
import { api } from "../api/http";
import type { BarsChangeKind } from "./types";
import { applyPrice, applyTick, mergeTail, prependBars, sessionTimeZone, type TickResult } from "./candles";

export const PAGE_SIZE = 500;

export function fetchBars(symbol: Symbol, tf: Timeframe, to?: number, limit = PAGE_SIZE): Promise<BarsResponse> {
  const q = new URLSearchParams({ symbol, tf, limit: String(limit) });
  if (to !== undefined) q.set("to", String(to));
  return api.get<BarsResponse>(`/bars?${q.toString()}`);
}

export type BarsListener = (bars: Bar[], kind: BarsChangeKind) => void;
export type Fetcher = typeof fetchBars;

/**
 * Owns the raw bars for the current symbol/timeframe: initial load, left-edge backfill, tail refresh and
 * live tick folding. Every async result is tagged with a generation so responses for a previous
 * symbol/timeframe are dropped.
 *
 * Emitted kinds:
 * - reset: new symbol/tf (bars may be empty while loading)
 * - update: last bar changed or one bar appended
 * - prepend: older history loaded, or the tail was re-synced (any change that is not a plain last-bar update)
 */
export class BarsController {
  private _bars: Bar[] = [];
  private _symbol: Symbol = "";
  private _tf: Timeframe = "1D";
  private _hasMore = false;
  private gen = 0;
  private loadingOlder = false;
  private readonly listeners = new Set<BarsListener>();

  constructor(private readonly fetcher: Fetcher = fetchBars) {}

  get bars(): Bar[] { return this._bars; }
  get symbol(): Symbol { return this._symbol; }
  get tf(): Timeframe { return this._tf; }
  get hasMore(): boolean { return this._hasMore; }
  get isLoadingOlder(): boolean { return this.loadingOlder; }

  onChange(cb: BarsListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Load the newest page for symbol/tf. Resolves false when superseded by a newer load. Throws on fetch failure. */
  async load(symbol: Symbol, tf: Timeframe): Promise<boolean> {
    const gen = ++this.gen;
    this._symbol = symbol;
    this._tf = tf;
    this._bars = [];
    this._hasMore = false;
    this.loadingOlder = false;
    this.emit("reset");
    const res = await this.fetcher(symbol, tf);
    if (gen !== this.gen) return false;
    this._bars = sanitize(res.bars);
    this._hasMore = res.hasMore && this._bars.length > 0;
    this.emit("reset");
    return true;
  }

  /** Fetch the page before the oldest loaded bar. Returns the number of bars prepended (0 when skipped/stale). */
  async loadOlder(): Promise<number> {
    if (this.loadingOlder || !this._hasMore || this._bars.length === 0) return 0;
    const gen = this.gen;
    const oldest = this._bars[0]!.time;
    this.loadingOlder = true;
    try {
      const res = await this.fetcher(this._symbol, this._tf, oldest);
      if (gen !== this.gen) return 0;
      const before = this._bars.length;
      this._bars = prependBars(sanitize(res.bars), this._bars);
      const added = this._bars.length - before;
      this._hasMore = res.hasMore && added > 0;
      if (added > 0) this.emit("prepend");
      return added;
    } catch (e) {
      if (gen === this.gen) console.warn("[chart] backfill failed", e);
      return 0;
    } finally {
      if (gen === this.gen) this.loadingOlder = false;
    }
  }

  /** Re-fetch the newest page and splice it over the tail (e.g. after a websocket reconnect gap). */
  async refreshTail(): Promise<void> {
    if (this._bars.length === 0) return;
    const gen = this.gen;
    try {
      const res = await this.fetcher(this._symbol, this._tf);
      if (gen !== this.gen || res.bars.length === 0) return;
      this._bars = mergeTail(this._bars, sanitize(res.bars));
      this.emit("prepend");
    } catch (e) {
      console.warn("[chart] tail refresh failed", e);
    }
  }

  applyTick(tick: Tick): TickResult {
    if (tick.symbol !== this._symbol) return { kind: "ignored" };
    return this.commit(applyTick(this._bars, tick, this._tf, sessionTimeZone(this._symbol)));
  }

  /** Snapshot quotes (non-streamable symbols): move the last bar's close; volume is a daily total, so ignored. */
  applyQuote(quote: Quote): TickResult {
    if (quote.symbol !== this._symbol || !quote.time) return { kind: "ignored" };
    return this.commit(applyPrice(this._bars, quote.price, 0, quote.time, this._tf, { tz: sessionTimeZone(this._symbol) }));
  }

  private commit(r: TickResult): TickResult {
    if (r.kind === "update") this._bars[this._bars.length - 1] = r.bar;
    else if (r.kind === "append") this._bars.push(r.bar);
    else return r;
    this.emit("update");
    return r;
  }

  private emit(kind: BarsChangeKind): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(this._bars, kind);
      } catch (e) {
        console.error("[chart] bars listener failed", e);
      }
    }
  }
}

/** Ascending, unique times, finite OHLC. Guards the chart against malformed upstream rows (lightweight-charts throws on unsorted data). */
export function sanitize(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let lastTime = -Infinity;
  const sorted = isAscending(bars) ? bars : [...bars].sort((a, b) => a.time - b.time);
  for (const b of sorted) {
    if (![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    const bar: Bar = { ...b, volume: Number.isFinite(b.volume) ? b.volume : 0 };
    if (b.time === lastTime) out[out.length - 1] = bar;
    else out.push(bar);
    lastTime = b.time;
  }
  return out;
}

function isAscending(bars: readonly Bar[]): boolean {
  for (let i = 1; i < bars.length; i++) if (bars[i]!.time < bars[i - 1]!.time) return false;
  return true;
}
