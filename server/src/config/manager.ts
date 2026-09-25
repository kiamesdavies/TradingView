// EODHD key resolution, persistence and change notification.
// Factory form so tests can point it at a temp file and a fake validator.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigView } from "@eodview/shared";
import { HttpError } from "../http";
import { EodhdError } from "../eodhd/request";
import type { EodhdUser } from "../eodhd/mappers";

export type KeySource = ConfigView["keySource"];

/** Shape of server/data/config.json. Unknown fields are preserved on write. */
export interface ConfigFile {
  apiKey?: string;
  [extra: string]: unknown;
}

export interface ConfigManagerOptions {
  /** Absolute path to config.json. */
  file: string;
  /** Environment to read EODHD_API_KEY from. */
  env: Record<string, string | undefined>;
  port: number;
  /** Fetches /user with the given key; must throw EodhdError on rejection. */
  fetchUser: (key: string) => Promise<EodhdUser>;
  /** How long plan info from /user is reused by view(). */
  planTtlMs?: number;
  /** How often getKey() re-checks the file for edits made by another process (e.g. the CLI). */
  fileCheckMs?: number;
  now?: () => number;
}

export interface ConfigManager {
  readonly port: number;
  getKey(): string | null;
  keySource(): KeySource;
  view(): Promise<ConfigView>;
  setKey(key: string): Promise<ConfigView>;
  clearKey(): Promise<ConfigView>;
  onKeyChange(cb: (key: string | null) => void): () => void;
}

/** "abcd…wxyz"; short keys are fully hidden. */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Keys are opaque tokens; reject whitespace/control chars and absurd lengths before any network call. */
export function normalizeKey(input: unknown): string {
  if (typeof input !== "string") throw new HttpError(400, "apiKey must be a string");
  const key = input.trim();
  if (!key) throw new HttpError(400, "apiKey is required");
  if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new HttpError(400, "apiKey has an invalid format");
  return key;
}

export function readConfigFile(file: string): ConfigFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ConfigFile) : {};
  } catch (e) {
    console.warn(`[config] ignoring unreadable ${file}: ${(e as Error).message}`);
    return {};
  }
}

/** Atomic write with owner-only permissions (0600). */
export function writeConfigFile(file: string, data: ConfigFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function createConfigManager(opts: ConfigManagerOptions): ConfigManager {
  const now = opts.now ?? Date.now;
  const planTtl = opts.planTtlMs ?? 5 * 60_000;
  const fileCheckMs = opts.fileCheckMs ?? 2_000;
  const listeners = new Set<(key: string | null) => void>();

  let fileKey: string | null = null;
  let fileMtime = -1;
  let lastCheck = -Infinity;
  let current: string | null = null;
  let plan: { key: string; user: EodhdUser; at: number } | null = null;

  const envKey = (): string | null => opts.env.EODHD_API_KEY?.trim() || null;

  function loadFile(): void {
    let mtime = 0;
    try {
      mtime = existsSync(opts.file) ? statSync(opts.file).mtimeMs : 0;
    } catch {
      mtime = 0;
    }
    if (mtime === fileMtime) return;
    fileMtime = mtime;
    const k = readConfigFile(opts.file).apiKey;
    fileKey = typeof k === "string" && k.trim() ? k.trim() : null;
  }

  function emitIfChanged(): void {
    const next = fileKey ?? envKey();
    if (next === current) return;
    current = next;
    plan = null;
    for (const cb of listeners) {
      try {
        cb(next);
      } catch (e) {
        console.error("[config] onKeyChange listener failed", e);
      }
    }
  }

  function refresh(force = false): void {
    const t = now();
    if (!force && t - lastCheck < fileCheckMs) return;
    lastCheck = t;
    loadFile();
    emitIfChanged();
  }

  // Initial resolution without notifying (nobody is subscribed yet).
  loadFile();
  lastCheck = now();
  current = fileKey ?? envKey();

  function source(): KeySource {
    if (fileKey) return "file";
    if (envKey()) return "env";
    return "none";
  }

  function toView(key: string | null, user?: EodhdUser): ConfigView {
    const v: ConfigView = { hasKey: !!key, keyMasked: maskKey(key), keySource: source(), port: opts.port };
    if (user) {
      v.plan = {
        name: user.subscriptionType,
        apiRequests: user.apiRequests,
        dailyRateLimit: user.dailyRateLimit,
        email: user.email,
      };
    }
    return v;
  }

  async function validate(key: string): Promise<EodhdUser> {
    try {
      return await opts.fetchUser(key);
    } catch (e) {
      if (e instanceof EodhdError && e.code === "unauthorized") throw new HttpError(400, "EODHD rejected the API key");
      if (e instanceof EodhdError) throw new HttpError(e.status === 429 ? 429 : 502, `Could not validate key: ${e.message}`);
      throw e;
    }
  }

  function persist(key: string | null): void {
    const data = readConfigFile(opts.file);
    if (key) data.apiKey = key;
    else delete data.apiKey;
    writeConfigFile(opts.file, data);
    fileMtime = -1; // force a re-read even if the mtime did not move (coarse fs timestamps)
    refresh(true);
  }

  async function view(): Promise<ConfigView> {
    refresh();
    const key = current;
    if (!key) return toView(null);
    if (plan && plan.key === key && now() - plan.at < planTtl) return toView(key, plan.user);
    try {
      const user = await opts.fetchUser(key);
      plan = { key, user, at: now() };
      return toView(key, user);
    } catch {
      return toView(key);
    }
  }

  return {
    port: opts.port,
    getKey() {
      refresh();
      return current;
    },
    keySource() {
      refresh();
      return source();
    },
    view,
    async setKey(input) {
      const key = normalizeKey(input);
      const user = await validate(key);
      persist(key);
      plan = { key, user, at: now() };
      return toView(current, user);
    },
    async clearKey() {
      persist(null);
      return view();
    },
    onKeyChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
