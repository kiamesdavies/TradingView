import { describe, expect, test } from "bun:test";
import { EodhdError, InFlight, eodhdGet, mapHttpError, requestKey } from "./request";
import { createEodhdClient } from "./factory";

const KEY = "SECRETKEY123456";

function fakeFetch(handler: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const fn = async (u: string) => {
    const url = new URL(u);
    urls.push(url);
    return handler(url);
  };
  return { fn, urls };
}

describe("error mapping", () => {
  test("status codes map to clear messages", () => {
    expect(mapHttpError(401, "Unauthenticated", "x")).toMatchObject({ status: 502, code: "unauthorized", message: "EODHD rejected the API key" });
    expect(mapHttpError(403, "", "x").code).toBe("unauthorized");
    expect(mapHttpError(402, "", "AAPL.US 1m")).toMatchObject({ status: 402, code: "plan" });
    expect(mapHttpError(402, "", "AAPL.US 1m").message).toContain("plan does not include");
    expect(mapHttpError(429, "", "x")).toMatchObject({ status: 429, code: "rate_limited" });
    expect(mapHttpError(404, "Ticker Not Found.", "ZZZ.US")).toMatchObject({ status: 404, code: "not_found" });
    expect(mapHttpError(500, "", "x")).toMatchObject({ status: 502, code: "upstream" });
  });

  test("eodhdGet never leaks the key into errors", async () => {
    const { fn } = fakeFetch(() => new Response("Unauthenticated", { status: 401 }));
    const err = (await eodhdGet("/user", {}, KEY, "user info", fn).catch((e: unknown) => e)) as EodhdError;
    expect(err).toBeInstanceOf(EodhdError);
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toContain(KEY);

    const net = (await eodhdGet("/user", {}, KEY, "user info", async () => {
      throw new TypeError(`fetch failed https://x?api_token=${KEY}`);
    }).catch((e: unknown) => e)) as EodhdError;
    expect(net).toMatchObject({ status: 502, code: "network" });
    expect(net.message).not.toContain(KEY);
  });

  test("builds URL with fmt=json and api_token", async () => {
    const { fn, urls } = fakeFetch(() => Response.json([]));
    await eodhdGet("/eod/AAPL.US", { from: "2024-01-01", to: undefined, period: "d" }, KEY, "x", fn);
    const u = urls[0];
    expect(u.pathname).toBe("/api/eod/AAPL.US");
    expect(u.searchParams.get("fmt")).toBe("json");
    expect(u.searchParams.get("api_token")).toBe(KEY);
    expect(u.searchParams.has("to")).toBe(false);
  });

  test("requestKey is order-independent", () => {
    expect(requestKey("/a", { b: 1, a: 2, c: undefined })).toBe(requestKey("/a", { a: 2, b: 1 }));
  });
});

describe("client", () => {
  test("no key → 503", async () => {
    const c = createEodhdClient(() => null, async () => Response.json([]));
    await expect(c.search("apple")).rejects.toMatchObject({ status: 503, message: "EODHD API key not configured" });
  });

  test("identical concurrent requests are de-duplicated", async () => {
    let n = 0;
    const c = createEodhdClient(() => KEY, async () => {
      n++;
      await Bun.sleep(5);
      return Response.json([{ date: "2024-01-02", open: 1, high: 1, low: 1, close: 1, adjusted_close: 1, volume: 1 }]);
    });
    const [a, b] = await Promise.all([c.eod("AAPL.US", "2024-01-01"), c.eod("AAPL.US", "2024-01-01")]);
    expect(n).toBe(1);
    expect(a).toEqual(b);
    await c.eod("AAPL.US", "2024-01-01");
    expect(n).toBe(2); // not cached after settling
  });

  test("realtime batches and routes first symbol into the path", async () => {
    const { fn, urls } = fakeFetch((u) => {
      const first = decodeURIComponent(u.pathname.split("/").pop()!);
      const rest = u.searchParams.get("s")?.split(",") ?? [];
      return Response.json([first, ...rest].map((code) => ({ code, timestamp: 1, close: 1, previousClose: 1, change: 0, change_p: 0, volume: 0 })));
    });
    const c = createEodhdClient(() => KEY, fn);
    const syms = Array.from({ length: 20 }, (_, i) => `S${i}.US`);
    const q = await c.realtime([...syms, "S0.US"]);
    expect(q.map((x) => x.symbol)).toEqual(syms);
    expect(urls).toHaveLength(2);
  });

  test("intraday rejects ranges beyond EODHD maximum", async () => {
    const c = createEodhdClient(() => KEY, async () => Response.json([]));
    await expect(c.intraday("AAPL.US", "1m", 0, 121 * 86400)).rejects.toMatchObject({ status: 400 });
  });
});

describe("InFlight", () => {
  test("clears after rejection", async () => {
    const f = new InFlight();
    await expect(f.run("k", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(f.size).toBe(0);
  });
});
