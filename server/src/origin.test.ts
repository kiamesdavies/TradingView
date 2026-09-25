import { describe, expect, test } from "bun:test";
import { isAllowedOrigin, needsOriginCheck, parseAllowedOrigins } from "./origin";

const base = { host: "localhost:3001", secFetchSite: null, allowed: [] as string[] };

describe("isAllowedOrigin", () => {
  test("same origin and loopback dev origins pass", () => {
    expect(isAllowedOrigin({ ...base, origin: "http://localhost:3001" })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: "http://localhost:5173", host: "localhost:5173" })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: "http://127.0.0.1:5173" })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: "http://[::1]:3001" })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: "http://192.168.1.5:3001", host: "192.168.1.5:3001" })).toBe(true);
  });

  test("foreign origins are rejected", () => {
    expect(isAllowedOrigin({ ...base, origin: "https://evil.example" })).toBe(false);
    expect(isAllowedOrigin({ ...base, origin: "http://evil.example:3001" })).toBe(false);
    expect(isAllowedOrigin({ ...base, origin: "null" })).toBe(false);
    expect(isAllowedOrigin({ ...base, origin: "chrome-extension://abc" })).toBe(false);
  });

  test("allow-list", () => {
    const allowed = parseAllowedOrigins(" http://MyBox.lan:3001/ , https://x.example");
    expect(allowed).toEqual(["http://mybox.lan:3001", "https://x.example"]);
    expect(isAllowedOrigin({ ...base, allowed, origin: "http://mybox.lan:3001" })).toBe(true);
    expect(isAllowedOrigin({ ...base, allowed, origin: "http://mybox.lan:3002" })).toBe(false);
  });

  test("missing Origin: non-browser clients pass, cross-site browser requests do not", () => {
    expect(isAllowedOrigin({ ...base, origin: null })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: null, secFetchSite: "same-origin" })).toBe(true);
    expect(isAllowedOrigin({ ...base, origin: null, secFetchSite: "cross-site" })).toBe(false);
  });

  test("only unsafe methods are checked on REST", () => {
    expect(needsOriginCheck("GET")).toBe(false);
    expect(needsOriginCheck("POST")).toBe(true);
    expect(needsOriginCheck("delete")).toBe(true);
  });
});
