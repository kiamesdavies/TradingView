import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAgentAuth, isLoopbackCaller, parseEnvTokens } from "./auth";
import { AgentError } from "./errors";
import { createTokenStore, sha256Hex } from "./tokens";

const ENV = "env-token-0123456789abcdef";
const LOOP = { ip: "127.0.0.1", host: "localhost:3001", authorization: null };
const REMOTE = { ip: "192.168.1.20", host: "mybox.lan:3001", authorization: null };

function fail(fn: () => unknown): AgentError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(AgentError); return e as AgentError; }
  throw new Error("expected AgentError");
}

describe("loopback", () => {
  test("loopback ip + host needs no token", () => {
    const auth = createAgentAuth({ envTokens: [] });
    expect(auth.authenticate(LOOP)).toEqual({ kind: "loopback", id: "loopback" });
    expect(auth.authenticate({ ip: "::1", host: "[::1]:3001", authorization: null }).kind).toBe("loopback");
    expect(auth.authenticate({ ip: "::ffff:127.0.0.1", host: "127.0.0.1", authorization: null }).kind).toBe("loopback");
  });
  test("DNS rebinding (loopback ip, foreign host) and remote callers need a token", () => {
    const auth = createAgentAuth({ envTokens: [] });
    const e = fail(() => auth.authenticate({ ip: "127.0.0.1", host: "evil.example:3001", authorization: null }));
    expect(e.status).toBe(401);
    expect(e.headers["www-authenticate"]).toContain("Bearer");
    expect(fail(() => auth.authenticate(REMOTE)).status).toBe(401);
    expect(isLoopbackCaller(undefined, "localhost")).toBe(false);
  });
  test("proxy headers make a loopback request remote", () => {
    const auth = createAgentAuth({ envTokens: [ENV] });
    expect(fail(() => auth.authenticate({ ip: "127.0.0.1", host: "127.0.0.1:3001", authorization: null, proxied: true })).status).toBe(401);
    expect(isLoopbackCaller("127.0.0.1", "localhost", true)).toBe(false);
    expect(auth.authenticate({ ip: "127.0.0.1", host: "127.0.0.1:3001", authorization: `Bearer ${ENV}`, proxied: true }).kind).toBe("env");
  });
  test("requireTokenOnLoopback", () => {
    const auth = createAgentAuth({ envTokens: [], requireTokenOnLoopback: true });
    expect(fail(() => auth.authenticate(LOOP)).status).toBe(401);
  });
});

describe("bearer tokens", () => {
  test("env tokens: valid, invalid, short entries ignored", () => {
    const warns: string[] = [];
    const env = parseEnvTokens(` ${ENV} , short ,`, (m) => warns.push(m));
    expect(env).toEqual([ENV]);
    expect(warns.length).toBe(1);
    const auth = createAgentAuth({ envTokens: env });
    expect(auth.authenticate({ ...REMOTE, authorization: `Bearer ${ENV}` })).toEqual({ kind: "env", id: "env:env-to" });
    expect(auth.authenticate({ ...REMOTE, authorization: `bearer   ${ENV}` }).kind).toBe("env");
    const bad = fail(() => auth.authenticate({ ...REMOTE, authorization: `Bearer ${ENV}x` }));
    expect(bad.status).toBe(401);
    expect(bad.message).toBe("invalid token");
    expect(fail(() => auth.authenticate({ ...REMOTE, authorization: `Basic abc` })).status).toBe(401);
  });
  test("a wrong bearer from loopback is rejected, not downgraded to loopback", () => {
    const auth = createAgentAuth({ envTokens: [ENV] });
    expect(fail(() => auth.authenticate({ ...LOOP, authorization: "Bearer nope" })).status).toBe(401);
  });
  test("stored tokens: hashed at rest, verify, lastUsedAt, delete", () => {
    const db = new Database(":memory:");
    let t = 1_000;
    const store = createTokenStore(db, { now: () => t });
    const created = store.create("  research agent ");
    expect(created.name).toBe("research agent");
    expect(created.token.length).toBeGreaterThanOrEqual(43);
    expect(created.prefix).toBe(created.token.slice(0, 6));
    expect(created.lastUsedAt).toBeNull();
    const raw = db.query<{ hash: string }, []>("SELECT * FROM agent_api_tokens").all();
    expect(JSON.stringify(raw)).not.toContain(created.token);
    expect(raw[0]!.hash).toBe(sha256Hex(created.token));

    const auth = createAgentAuth({ envTokens: [], store });
    expect(auth.authenticate({ ...REMOTE, authorization: `Bearer ${created.token}` })).toEqual({ kind: "token", id: created.id, name: "research agent" });
    expect(store.list()[0]!.lastUsedAt).toBe(1_000);
    t = 1_030; // within a minute: not rewritten
    store.verify(created.token);
    expect(store.list()[0]!.lastUsedAt).toBe(1_000);
    t = 1_100;
    store.verify(created.token);
    expect(store.list()[0]!.lastUsedAt).toBe(1_100);

    // Change the last character (to something else: a token ending in "A" made this flaky).
    const wrong = created.token.slice(0, -1) + (created.token.endsWith("A") ? "B" : "A");
    expect(fail(() => auth.authenticate({ ...REMOTE, authorization: `Bearer ${wrong}` })).status).toBe(401);
    expect(store.remove(created.id)).toBe(true);
    expect(store.remove(created.id)).toBe(false);
    expect(fail(() => auth.authenticate({ ...REMOTE, authorization: `Bearer ${created.token}` })).status).toBe(401);
  });
  test("create validates the name", () => {
    const store = createTokenStore(new Database(":memory:"));
    expect(fail(() => store.create("")).status).toBe(400);
    expect(fail(() => store.create(42)).status).toBe(400);
  });
});

describe("rate limit", () => {
  test("per token, fixed window, 429 with retry-after; loopback unlimited", () => {
    let now = 0;
    const auth = createAgentAuth({ envTokens: [ENV, ENV.toUpperCase()], rateLimit: 3, windowMs: 60_000, nowMs: () => now });
    const a = { ...REMOTE, authorization: `Bearer ${ENV}` };
    for (let i = 0; i < 3; i++) auth.authenticate(a);
    now = 15_000;
    const e = fail(() => auth.authenticate(a));
    expect(e.status).toBe(429);
    expect(e.headers["retry-after"]).toBe("45");
    // another token has its own budget
    auth.authenticate({ ...REMOTE, authorization: `Bearer ${ENV.toUpperCase()}` });
    for (let i = 0; i < 10; i++) auth.authenticate(LOOP);
    now = 60_000;
    expect(auth.authenticate(a).kind).toBe("env");
  });
});

describe("rate limit: loopback and batches", () => {
  test("loopback callers share a generous limit", () => {
    let now = 0;
    const auth = createAgentAuth({ envTokens: [], loopbackRateLimit: 5, nowMs: () => now });
    for (let i = 0; i < 5; i++) auth.authenticate(LOOP);
    const e = fail(() => auth.authenticate(LOOP));
    expect(e.status).toBe(429);
    expect(e.detail).toContain("loopback");
    now = 60_000;
    expect(auth.authenticate(LOOP).kind).toBe("loopback");
    expect(createAgentAuth({ envTokens: [] }).authenticate(LOOP).kind).toBe("loopback"); // default 600/min
  });
  test("charge() counts the extra messages of a batch", () => {
    const auth = createAgentAuth({ envTokens: [ENV], rateLimit: 10, nowMs: () => 0 });
    const a = { ...REMOTE, authorization: `Bearer ${ENV}` };
    const p = auth.authenticate(a);
    auth.charge(p, 8); // 9 used
    expect(fail(() => auth.charge(p, 2)).status).toBe(429);
    expect(fail(() => auth.authenticate(a)).status).toBe(429);
  });
});
