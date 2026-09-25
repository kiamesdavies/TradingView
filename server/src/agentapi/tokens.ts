// API tokens for agents. Only a SHA-256 hash and a short prefix are stored; the token is shown once on creation.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiTokenView } from "@eodview/shared";
import { badRequest } from "./errors";

export const TOKEN_PREFIX_LEN = 6;
const MAX_TOKENS = 100;
const TOUCH_INTERVAL_SEC = 60;

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url"); // 43 chars, 256 bits
}

interface Row { id: string; name: string; prefix: string; hash: string; created_at: number; last_used_at: number | null }

const view = (r: Row): ApiTokenView => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at });

export interface TokenStoreOpts { now?: () => number } // unix seconds

export function createTokenStore(db: Database, opts: TokenStoreOpts = {}) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  db.exec(`CREATE TABLE IF NOT EXISTS agent_api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`);

  return {
    list(): ApiTokenView[] {
      return db.query<Row, []>(`SELECT * FROM agent_api_tokens ORDER BY created_at DESC, id`).all().map(view);
    },

    create(nameRaw: unknown): ApiTokenView & { token: string } {
      if (typeof nameRaw !== "string" || !nameRaw.trim()) badRequest("name is required");
      const name = nameRaw.trim().slice(0, 64);
      const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_api_tokens`).get()?.n ?? 0;
      if (n >= MAX_TOKENS) badRequest(`at most ${MAX_TOKENS} tokens; delete unused ones first`);
      const token = generateToken();
      const row: Row = {
        id: crypto.randomUUID(), name, prefix: token.slice(0, TOKEN_PREFIX_LEN), hash: sha256Hex(token),
        created_at: now(), last_used_at: null,
      };
      db.query(`INSERT INTO agent_api_tokens (id, name, prefix, hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)`)
        .run(row.id, row.name, row.prefix, row.hash, row.created_at);
      return { ...view(row), token };
    },

    remove(id: string): boolean {
      return db.query(`DELETE FROM agent_api_tokens WHERE id = ?`).run(id).changes > 0;
    },

    /** The token's record when `token` is valid; records lastUsedAt (at most once a minute). */
    verify(token: string): ApiTokenView | null {
      const hash = sha256Hex(token);
      const row = db.query<Row, [string]>(`SELECT * FROM agent_api_tokens WHERE hash = ?`).get(hash);
      if (!row || !digestEqual(row.hash, hash)) return null;
      const t = now();
      if (row.last_used_at === null || t - row.last_used_at >= TOUCH_INTERVAL_SEC) {
        db.query(`UPDATE agent_api_tokens SET last_used_at = ? WHERE id = ?`).run(t, row.id);
        row.last_used_at = t;
      }
      return view(row);
    },
  };
}
export type TokenStore = ReturnType<typeof createTokenStore>;
