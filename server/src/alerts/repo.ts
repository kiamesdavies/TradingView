// SQLite persistence for alerts and alert history.
import type { Database } from "bun:sqlite";
import type { Alert, AlertCondition, AlertEvent, AlertInput, Symbol, UnixSeconds } from "@eodview/shared";

interface AlertRow {
  id: string; symbol: string; price: number; condition: string; repeat: number; note: string | null;
  active: number; created_at: number; last_triggered_at: number | null;
}
interface EventRow {
  id: string; alert_id: string; symbol: string; price: number; tick_price: number; condition: string; at: number; note: string | null;
}

export type AlertPatch = Partial<AlertInput> & { active?: boolean };

function toAlert(r: AlertRow): Alert {
  const a: Alert = {
    id: r.id,
    symbol: r.symbol,
    price: r.price,
    condition: r.condition as AlertCondition,
    repeat: r.repeat === 1,
    active: r.active === 1,
    createdAt: r.created_at,
  };
  if (r.note) a.note = r.note;
  if (r.last_triggered_at !== null) a.lastTriggeredAt = r.last_triggered_at;
  return a;
}

function toEvent(r: EventRow): AlertEvent {
  const e: AlertEvent = {
    id: r.id, alertId: r.alert_id, symbol: r.symbol, price: r.price, tickPrice: r.tick_price,
    condition: r.condition as AlertCondition, at: r.at,
  };
  if (r.note) e.note = r.note;
  return e;
}

const nowSec = (): UnixSeconds => Math.floor(Date.now() / 1000);

export function createAlertRepo(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      condition TEXT NOT NULL,
      repeat INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_triggered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS alerts_symbol ON alerts(symbol);
    CREATE TABLE IF NOT EXISTS alert_events (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      tick_price REAL NOT NULL,
      condition TEXT NOT NULL,
      at INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS alert_events_at ON alert_events(at DESC);
  `);

  const qAll = db.query<AlertRow, []>("SELECT * FROM alerts ORDER BY created_at, rowid");
  const qActive = db.query<AlertRow, []>("SELECT * FROM alerts WHERE active = 1 ORDER BY created_at, rowid");
  const qGet = db.query<AlertRow, [string]>("SELECT * FROM alerts WHERE id = ?");
  const qInsert = db.query<null, [string, string, number, string, number, string | null, number, number]>(
    "INSERT INTO alerts (id, symbol, price, condition, repeat, note, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const qUpdate = db.query<null, [string, number, string, number, string | null, number, string]>(
    "UPDATE alerts SET symbol = ?, price = ?, condition = ?, repeat = ?, note = ?, active = ? WHERE id = ?",
  );
  const qDelete = db.query<null, [string]>("DELETE FROM alerts WHERE id = ?");
  const qTrigger = db.query<null, [number, number, string]>("UPDATE alerts SET last_triggered_at = ?, active = ? WHERE id = ?");
  const qInsertEvent = db.query<null, [string, string, string, number, number, string, number, string | null]>(
    "INSERT INTO alert_events (id, alert_id, symbol, price, tick_price, condition, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const qHistory = db.query<EventRow, [number]>("SELECT * FROM alert_events ORDER BY at DESC, rowid DESC LIMIT ?");

  return {
    list(): Alert[] {
      return qAll.all().map(toAlert);
    },
    listActive(): Alert[] {
      return qActive.all().map(toAlert);
    },
    get(id: string): Alert | null {
      const r = qGet.get(id);
      return r ? toAlert(r) : null;
    },
    create(input: AlertInput): Alert {
      const id = crypto.randomUUID();
      qInsert.run(id, input.symbol, input.price, input.condition, input.repeat ? 1 : 0, input.note ?? null, 1, nowSec());
      return this.get(id)!;
    },
    update(id: string, patch: AlertPatch): Alert | null {
      const cur = this.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      const note = "note" in patch ? patch.note : cur.note;
      qUpdate.run(next.symbol, next.price, next.condition, next.repeat ? 1 : 0, note ?? null, next.active ? 1 : 0, id);
      return this.get(id);
    },
    remove(id: string): boolean {
      return qDelete.run(id).changes > 0;
    },
    /** Record a trigger atomically: insert the event, stamp lastTriggeredAt, deactivate one-shot alerts. */
    recordTrigger(alert: Alert, tickPrice: number, at: UnixSeconds): AlertEvent {
      const ev: AlertEvent = {
        id: crypto.randomUUID(), alertId: alert.id, symbol: alert.symbol as Symbol, price: alert.price, tickPrice,
        condition: alert.condition, at,
      };
      if (alert.note) ev.note = alert.note;
      db.transaction(() => {
        qInsertEvent.run(ev.id, ev.alertId, ev.symbol, ev.price, ev.tickPrice, ev.condition, ev.at, ev.note ?? null);
        qTrigger.run(at, alert.repeat ? 1 : 0, alert.id);
      })();
      return ev;
    },
    history(limit: number): AlertEvent[] {
      return qHistory.all(limit).map(toEvent);
    },
  };
}

export type AlertRepo = ReturnType<typeof createAlertRepo>;
