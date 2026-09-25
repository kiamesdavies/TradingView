import { describe, expect, test } from "bun:test";
import { assertConfigAccess } from "./guard";

const ok = (g: Parameters<typeof assertConfigAccess>[0]) => { assertConfigAccess(g); return true; };

describe("config route guard", () => {
  test("loopback mode: loopback IP and loopback Host required", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(ok({ adminToken: undefined, authorization: null, ip, host: "localhost:3001" })).toBe(true);
    }
    expect(ok({ adminToken: undefined, authorization: null, ip: "::1", host: "[::1]:3001" })).toBe(true);
    expect(ok({ adminToken: undefined, authorization: null, ip: "127.0.0.1", host: "127.0.0.1:5173" })).toBe(true);
    expect(() => assertConfigAccess({ adminToken: undefined, authorization: null, ip: "192.168.1.5", host: "localhost" })).toThrow();
    expect(() => assertConfigAccess({ adminToken: undefined, authorization: null, ip: "127.0.0.1", host: "evil.example:3001" })).toThrow();
    expect(() => assertConfigAccess({ adminToken: undefined, authorization: null, ip: null, host: "localhost" })).toThrow();
  });

  test("token mode: bearer token required regardless of IP", () => {
    const base = { adminToken: "s3cret", ip: "10.0.0.2", host: "box:3001" };
    expect(ok({ ...base, authorization: "Bearer s3cret" })).toBe(true);
    expect(() => assertConfigAccess({ ...base, authorization: "Bearer nope" })).toThrow("admin token required");
    expect(() => assertConfigAccess({ ...base, authorization: null, ip: "127.0.0.1", host: "localhost" })).toThrow();
    try {
      assertConfigAccess({ ...base, authorization: "Basic s3cret" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(401);
    }
  });
});
