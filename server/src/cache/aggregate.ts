// Pure bar aggregation on fixed UTC boundaries.
import type { Bar } from "@eodview/shared";

/** Start of the `bucketSec` bucket containing `time` (UTC, epoch-aligned). */
export function bucketOf(time: number, bucketSec: number): number {
  return Math.floor(time / bucketSec) * bucketSec;
}

/**
 * Merge ascending bars into `bucketSec` buckets aligned to the Unix epoch (so 4h buckets start at
 * 00:00, 04:00, … UTC). open = first, close = last, high/low = extremes, volume = sum.
 * Unsorted input is tolerated (sorted first); the input array is not mutated.
 */
export function aggregate(bars: readonly Bar[], bucketSec: number): Bar[] {
  if (!(bucketSec > 0)) throw new Error("bucketSec must be positive");
  let src = bars;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time < bars[i - 1].time) {
      src = [...bars].sort((a, b) => a.time - b.time);
      break;
    }
  }
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of src) {
    const t = bucketOf(b.time, bucketSec);
    if (cur && cur.time === t) {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume;
    } else {
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      out.push(cur);
    }
  }
  return out;
}
