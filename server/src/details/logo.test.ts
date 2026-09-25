import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGO_MISS_TTL_SEC, LOGO_TTL_SEC, createLogoStore, logoCandidates } from "./logo";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function setup(routes: Record<string, () => Response>) {
  const dir = mkdtempSync(join(tmpdir(), "eodview-logo-"));
  const calls: string[] = [];
  let clock = 1_800_000_000;
  const store = createLogoStore({
    dir,
    now: () => clock,
    fetch: async (url) => {
      calls.push(url);
      const r = routes[url];
      return r ? r() : new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    },
  });
  return { store, calls, dir, advance: (s: number) => (clock += s), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("logo store", () => {
  test("candidates: fundamentals hint first, then exchange-aware lower/upper case", () => {
    expect(logoCandidates("AAPL", "US", "/img/logos/US/aapl.png")).toEqual(["/img/logos/US/aapl.png", "/img/logos/US/AAPL.png"]);
    expect(logoCandidates("VOD", "LSE")).toEqual(["/img/logos/LSE/vod.png", "/img/logos/LSE/VOD.png"]);
    expect(logoCandidates("X", "US", "https://evil.example/x.png")).toEqual(["/img/logos/US/x.png", "/img/logos/US/X.png"]);
  });

  test("hit is cached on disk for 30 days with its content type", async () => {
    const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });
    const { store, calls, dir, advance, cleanup } = setup({ "https://eodhd.com/img/logos/LSE/VOD.png": png });
    try {
      const r = await store.get("VOD.LSE", "VOD", "LSE");
      expect(r).toEqual({ found: true, body: PNG, contentType: "image/png" });
      expect(calls).toEqual(["https://eodhd.com/img/logos/LSE/vod.png", "https://eodhd.com/img/logos/LSE/VOD.png"]);
      expect(existsSync(join(dir, "VOD.LSE.img"))).toBe(true);
      advance(LOGO_TTL_SEC - 10);
      expect((await store.get("VOD.LSE", "VOD", "LSE")).found).toBe(true);
      expect(calls).toHaveLength(2);
      advance(20);
      await store.get("VOD.LSE", "VOD", "LSE");
      expect(calls).toHaveLength(4);
    } finally {
      cleanup();
    }
  });

  test("missing logo is a cached 404 for a day; transient failures are not cached", async () => {
    let down = true;
    const { store, calls, advance, cleanup } = setup({
      "https://eodhd.com/img/logos/US/zz.png": () => (down ? new Response("x", { status: 503 }) : new Response("nope", { status: 404 })),
    });
    try {
      await expect(store.get("ZZ.US", "ZZ", "US")).rejects.toThrow();
      down = false;
      expect(await store.get("ZZ.US", "ZZ", "US")).toEqual({ found: false });
      const n = calls.length;
      expect(await store.get("ZZ.US", "ZZ", "US")).toEqual({ found: false });
      expect(calls).toHaveLength(n);
      advance(LOGO_MISS_TTL_SEC + 1);
      await store.get("ZZ.US", "ZZ", "US");
      expect(calls.length).toBeGreaterThan(n);
    } finally {
      cleanup();
    }
  });
});
