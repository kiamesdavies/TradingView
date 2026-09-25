// Per-symbol tick coalescing: at most one emitted tick per symbol per interval.
// The first tick in a quiet period is emitted immediately; ticks arriving inside the window are merged
// (last price/time, summed volume, plus the window's open/high/low so the browser's live candle keeps its extremes)
// and emitted once when the window ends. A merged tick never spans a UTC minute boundary: a tick from a new minute
// flushes the pending one first, so every coalesced tick falls inside a single bar on every timeframe.
import type { Symbol, Tick } from "@eodview/shared";

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const minuteOf = (ms: number): number => Math.floor(ms / 60_000);

/** Fold `next` into the pending coalesced tick `p`. */
function merge(p: Tick, next: Tick): Tick {
  const open = p.open ?? p.price;
  const high = Math.max(p.high ?? p.price, next.price);
  const low = Math.min(p.low ?? p.price, next.price);
  return { symbol: next.symbol, price: next.price, volume: p.volume + next.volume, time: next.time, open, high, low };
}

interface Slot { lastEmit: number; pending: Tick | null; timer: unknown }

export class TickThrottle {
  private slots = new Map<Symbol, Slot>();

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (t: Tick) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  push(tick: Tick): void {
    const now = this.timers.now();
    let slot = this.slots.get(tick.symbol);
    if (!slot) {
      slot = { lastEmit: -Infinity, pending: null, timer: null };
      this.slots.set(tick.symbol, slot);
    }
    if (slot.pending) {
      const p = slot.pending;
      if (minuteOf(tick.time) !== minuteOf(p.time)) {
        // Crossing into a new minute: send what we have now so its volume/extremes stay in the old bar.
        slot.lastEmit = now;
        this.emit(p);
        slot.pending = { ...tick };
        return; // the scheduled flush sends the new pending tick
      }
      slot.pending = merge(p, tick);
      return;
    }
    const wait = slot.lastEmit + this.intervalMs - now;
    if (wait <= 0) {
      slot.lastEmit = now;
      this.emit(tick);
      return;
    }
    slot.pending = { ...tick };
    const s = slot;
    s.timer = this.timers.setTimeout(() => this.flush(tick.symbol, s), wait);
  }

  private flush(symbol: Symbol, slot: Slot): void {
    slot.timer = null;
    const p = slot.pending;
    slot.pending = null;
    if (!p || this.slots.get(symbol) !== slot) return;
    slot.lastEmit = this.timers.now();
    this.emit(p);
  }

  /** Drop state (and any pending coalesced tick) for a symbol nobody watches anymore. */
  forget(symbol: Symbol): void {
    const slot = this.slots.get(symbol);
    if (!slot) return;
    if (slot.timer !== null) this.timers.clearTimeout(slot.timer);
    this.slots.delete(symbol);
  }

  clear(): void {
    for (const s of [...this.slots.keys()]) this.forget(s);
  }
}
