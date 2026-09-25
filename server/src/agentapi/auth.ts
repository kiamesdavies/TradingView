// Agent API authentication + per-caller rate limiting (pure apart from the injected token store; see auth.test.ts).
//
// - Loopback callers (loopback source IP *and* loopback Host header, which blocks DNS rebinding) need no token,
//   unless requireTokenOnLoopback is set (EODVIEW_API_REQUIRE_TOKEN=1). A request carrying a proxy header
//   (Forwarded, X-Forwarded-For, X-Forwarded-Host, X-Real-IP, Via) is never loopback: behind a same-host reverse
//   proxy every client arrives from 127.0.0.1, and nginx/Apache rewrite Host to the upstream "127.0.0.1:3001".
// - Everyone else sends `Authorization: Bearer <token>`: a token from EODVIEW_API_TOKENS or one created via /api/tokens.
import { AgentError } from "./errors";
import { digestEqual, sha256Hex, type TokenStore } from "./tokens";

const LOOPBACK_IPS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const MIN_ENV_TOKEN_LEN = 16;

export function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0]!;
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

export function isLoopbackCaller(ip: string | null | undefined, host: string | null, proxied = false): boolean {
  return !proxied && !!ip && LOOPBACK_IPS.has(ip) && isLoopbackHost(host);
}

/** EODVIEW_API_TOKENS → tokens (comma separated; too-short entries are ignored with a warning). */
export function parseEnvTokens(v: string | undefined, warn: (m: string) => void = console.warn): string[] {
  const out: string[] = [];
  for (const t of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (t.length < MIN_ENV_TOKEN_LEN) warn(`[agentapi] ignoring EODVIEW_API_TOKENS entry shorter than ${MIN_ENV_TOKEN_LEN} chars`);
    else out.push(t);
  }
  return out;
}

export type Principal =
  | { kind: "loopback"; id: "loopback" }
  | { kind: "env"; id: string }
  | { kind: "token"; id: string; name: string };

export interface AuthInput {
  ip: string | null | undefined;
  host: string | null;
  authorization: string | null;
  /** The request carries a proxy header (config/guard.ts isProxied). */
  proxied?: boolean;
}

export interface AgentAuthOpts {
  envTokens: string[];
  store?: Pick<TokenStore, "verify"> | null;
  requireTokenOnLoopback?: boolean;
  /** Requests per window per token (default 120/min); 0 = unlimited. */
  rateLimit?: number;
  /** Requests per window for all loopback callers together (default 600/min); 0 = unlimited. */
  loopbackRateLimit?: number;
  windowMs?: number;
  nowMs?: () => number;
}

const WWW_AUTH = { "www-authenticate": 'Bearer realm="eodview"' };

export function createAgentAuth(opts: AgentAuthOpts) {
  const envDigests = opts.envTokens.map((t) => ({ digest: sha256Hex(t), id: `env:${t.slice(0, 6)}` }));
  const limit = opts.rateLimit ?? 120;
  const loopLimit = opts.loopbackRateLimit ?? 600;
  const windowMs = opts.windowMs ?? 60_000;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const windows = new Map<string, { start: number; count: number }>();

  function identify(g: AuthInput): Principal {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(g.authorization ?? "");
    if (!m) {
      if (!opts.requireTokenOnLoopback && isLoopbackCaller(g.ip, g.host, g.proxied)) return { kind: "loopback", id: "loopback" };
      throw new AgentError(401, "bearer token required",
        "send `Authorization: Bearer <token>` (EODVIEW_API_TOKENS or a token created in Settings → API tokens)", WWW_AUTH);
    }
    const token = m[1]!;
    const digest = sha256Hex(token);
    // Check every env token (no early exit) so timing doesn't reveal which one matched.
    let envHit: string | null = null;
    for (const e of envDigests) if (digestEqual(e.digest, digest)) envHit = e.id;
    if (envHit) return { kind: "env", id: envHit };
    const rec = opts.store?.verify(token);
    if (rec) return { kind: "token", id: rec.id, name: rec.name };
    throw new AgentError(401, "invalid token", undefined, { "www-authenticate": 'Bearer realm="eodview", error="invalid_token"' });
  }

  /** Count `n` requests (an MCP batch counts each message) against the principal's window; throws 429. */
  function consume(p: Principal, n = 1): void {
    const max = p.kind === "loopback" ? loopLimit : limit;
    if (max <= 0 || n <= 0) return;
    const t = nowMs();
    let w = windows.get(p.id);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(p.id, w);
      if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
    }
    if (w.count + n > max) {
      w.count = Math.max(w.count, max); // a rejected request still uses up the window
      const retry = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      const who = p.kind === "loopback" ? "for loopback callers" : "per token";
      throw new AgentError(429, "rate limit exceeded", `${max} requests per ${windowMs / 1000}s ${who}`, { "retry-after": String(retry) });
    }
    w.count += n;
  }

  return {
    /** Principal for the request, or throws AgentError 401/429. */
    authenticate(g: AuthInput): Principal {
      const p = identify(g);
      consume(p);
      return p;
    },
    /** Charge `n` more requests to an authenticated principal (extra messages of an MCP batch); throws 429. */
    charge(p: Principal, n: number): void {
      consume(p, n);
    },
  };
}
export type AgentAuth = ReturnType<typeof createAgentAuth>;
