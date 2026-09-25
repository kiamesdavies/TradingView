import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EodhdError } from "../eodhd/request";
import type { EodhdUser } from "../eodhd/mappers";
import { createConfigManager, maskKey, normalizeKey, type ConfigManagerOptions } from "./manager";

let dir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eodview-config-"));
  prevDataDir = process.env.EODVIEW_DATA_DIR;
  process.env.EODVIEW_DATA_DIR = dir;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.EODVIEW_DATA_DIR;
  else process.env.EODVIEW_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const GOOD = "goodkey1234567890";
const USER: EodhdUser = { subscriptionType: "monthly", apiRequests: 5, dailyRateLimit: 100000, email: "a@b.c" };

function make(over: Partial<ConfigManagerOptions> = {}) {
  const calls: string[] = [];
  let clock = 1_000_000;
  const mgr = createConfigManager({
    file: join(dir, "config.json"),
    env: {},
    port: 3001,
    fetchUser: async (key) => {
      calls.push(key);
      if (key.startsWith("bad")) throw new EodhdError(502, "EODHD rejected the API key", "unauthorized", 401);
      if (key.startsWith("down")) throw new EodhdError(502, "Could not reach EODHD (user info)", "network");
      return USER;
    },
    fileCheckMs: 0,
    now: () => clock,
    ...over,
  });
  return { mgr, calls, tick: (ms: number) => (clock += ms) };
}

describe("maskKey / normalizeKey", () => {
  test("first4…last4, short keys hidden, null passthrough", () => {
    expect(maskKey("abcdefghijklmnop")).toBe("abcd…mnop");
    expect(maskKey("short")).toBe("••••");
    expect(maskKey(null)).toBeNull();
    expect(maskKey("")).toBeNull();
  });
  test("normalizeKey trims and rejects junk", () => {
    expect(normalizeKey("  abc.def  ")).toBe("abc.def");
    expect(() => normalizeKey("")).toThrow("apiKey is required");
    expect(() => normalizeKey("a b")).toThrow("invalid format");
    expect(() => normalizeKey(42)).toThrow("must be a string");
  });
});

describe("key precedence", () => {
  test("none → env → file", () => {
    expect(make().mgr.getKey()).toBeNull();
    expect(make().mgr.keySource()).toBe("none");

    const env = make({ env: { EODHD_API_KEY: " envkey123456789 " } }).mgr;
    expect(env.getKey()).toBe("envkey123456789");
    expect(env.keySource()).toBe("env");

    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "filekey123456789" }));
    const both = make({ env: { EODHD_API_KEY: "envkey123456789" } }).mgr;
    expect(both.getKey()).toBe("filekey123456789");
    expect(both.keySource()).toBe("file");
  });

  test("empty or corrupt file falls back to env", () => {
    writeFileSync(join(dir, "config.json"), "{not json");
    const m = make({ env: { EODHD_API_KEY: "envkey123456789" } }).mgr;
    expect(m.getKey()).toBe("envkey123456789");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "  " }));
    expect(make({ env: { EODHD_API_KEY: "envkey123456789" } }).mgr.keySource()).toBe("env");
  });
});

describe("setKey", () => {
  test("validates, persists with mode 0600, preserves extra fields, emits change", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ other: 1 }));
    const { mgr, calls } = make({ env: { EODHD_API_KEY: "envkey123456789" } });
    const seen: (string | null)[] = [];
    mgr.onKeyChange((k) => seen.push(k));
    const view = await mgr.setKey(`  ${GOOD} `);
    expect(calls).toEqual([GOOD]);
    expect(view).toEqual({
      hasKey: true, keyMasked: "good…7890", keySource: "file", port: 3001,
      plan: { name: "monthly", apiRequests: 5, dailyRateLimit: 100000, email: "a@b.c" },
    });
    const file = join(dir, "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ other: 1, apiKey: GOOD });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(seen).toEqual([GOOD]);
    expect(mgr.getKey()).toBe(GOOD);
  });

  test("rejected key → 400 and nothing written", async () => {
    const { mgr } = make();
    let seen = 0;
    mgr.onKeyChange(() => seen++);
    await expect(mgr.setKey("badkey1234567")).rejects.toMatchObject({ status: 400, message: "EODHD rejected the API key" });
    expect(mgr.getKey()).toBeNull();
    expect(seen).toBe(0);
  });

  test("network failure during validation → 502, not persisted", async () => {
    const { mgr } = make();
    await expect(mgr.setKey("downkey1234567")).rejects.toMatchObject({ status: 502 });
    expect(mgr.keySource()).toBe("none");
  });

  test("clearKey falls back to env and emits", async () => {
    const { mgr } = make({ env: { EODHD_API_KEY: "envkey123456789" } });
    await mgr.setKey(GOOD);
    const seen: (string | null)[] = [];
    const off = mgr.onKeyChange((k) => seen.push(k));
    const v = await mgr.clearKey();
    expect(v.keySource).toBe("env");
    expect(seen).toEqual(["envkey123456789"]);
    off();
  });
});

describe("view and external edits", () => {
  test("view caches plan info and survives /user failures", async () => {
    const { mgr, calls, tick } = make({ env: { EODHD_API_KEY: GOOD }, planTtlMs: 1000 });
    expect((await mgr.view()).plan?.name).toBe("monthly");
    await mgr.view();
    expect(calls).toHaveLength(1);
    tick(1500);
    await mgr.view();
    expect(calls).toHaveLength(2);

    const down = make({ env: { EODHD_API_KEY: "downkey1234567" } }).mgr;
    expect(await down.view()).toEqual({ hasKey: true, keyMasked: "down…4567", keySource: "env", port: 3001 });
  });

  test("a key written by another process (CLI) is picked up and emitted", () => {
    const { mgr, tick } = make();
    const seen: (string | null)[] = [];
    mgr.onKeyChange((k) => seen.push(k));
    expect(mgr.getKey()).toBeNull();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "clikey123456789" }));
    tick(10);
    expect(mgr.getKey()).toBe("clikey123456789");
    expect(seen).toEqual(["clikey123456789"]);
  });
});
