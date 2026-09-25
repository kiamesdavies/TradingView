// Pure alert evaluation: level-crossing detection with per-alert repeat cooldown.
import type { Alert, AlertCondition, UnixSeconds } from "@eodview/shared";

export const REPEAT_COOLDOWN_SEC = 60;

export type CrossDirection = "up" | "down";

/**
 * A crossing happens when the previous and current prices straddle the level:
 *   up:   prev < level <= cur
 *   down: prev > level >= cur
 * With no previous price there is no crossing (the first observation only establishes a baseline).
 */
export function detectCross(prev: number | undefined, cur: number, level: number): CrossDirection | null {
  if (prev === undefined || !Number.isFinite(prev) || !Number.isFinite(cur)) return null;
  if (prev < level && cur >= level) return "up";
  if (prev > level && cur <= level) return "down";
  return null;
}

export function matchesCondition(dir: CrossDirection, condition: AlertCondition): boolean {
  return condition === "cross" || (condition === "cross_up" && dir === "up") || (condition === "cross_down" && dir === "down");
}

/** True when an active alert should fire for the prev→cur price move at time `now`. */
export function shouldTrigger(alert: Alert, prev: number | undefined, cur: number, now: UnixSeconds): boolean {
  if (!alert.active) return false;
  const dir = detectCross(prev, cur, alert.price);
  if (!dir || !matchesCondition(dir, alert.condition)) return false;
  if (alert.repeat && alert.lastTriggeredAt !== undefined && now - alert.lastTriggeredAt < REPEAT_COOLDOWN_SEC) return false;
  return true;
}
