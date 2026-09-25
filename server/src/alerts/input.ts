// Validation of alert request bodies (throws HttpError 400 with a message).
import type { AlertCondition, AlertInput } from "@eodview/shared";
import { optionalString, requireBoolean, requireEnum, requireFinite, requireObject, requireSymbol } from "../store/validate";
import type { AlertPatch } from "./repo";

export const ALERT_CONDITIONS: readonly AlertCondition[] = ["cross_up", "cross_down", "cross"];
const NOTE_MAX = 500;

export function validateAlertInput(body: unknown): AlertInput {
  const o = requireObject(body);
  const input: AlertInput = {
    symbol: requireSymbol(o.symbol),
    price: requireFinite(o.price, "price", { positive: true }),
    condition: o.condition === undefined ? "cross" : requireEnum(o.condition, "condition", ALERT_CONDITIONS),
    repeat: o.repeat === undefined ? false : requireBoolean(o.repeat, "repeat"),
  };
  const note = optionalString(o.note, "note", NOTE_MAX);
  if (note) input.note = note;
  return input;
}

export function validateAlertPatch(body: unknown): AlertPatch {
  const o = requireObject(body);
  const patch: AlertPatch = {};
  if (o.symbol !== undefined) patch.symbol = requireSymbol(o.symbol);
  if (o.price !== undefined) patch.price = requireFinite(o.price, "price", { positive: true });
  if (o.condition !== undefined) patch.condition = requireEnum(o.condition, "condition", ALERT_CONDITIONS);
  if (o.repeat !== undefined) patch.repeat = requireBoolean(o.repeat, "repeat");
  if (o.active !== undefined) patch.active = requireBoolean(o.active, "active");
  if ("note" in o) patch.note = optionalString(o.note, "note", NOTE_MAX);
  return patch;
}
