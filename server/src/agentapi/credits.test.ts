import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createEodhdClient } from "../eodhd/factory";
import { eodhdCallCost } from "../eodhd/meter";
import { AGENT_LEDGER_JOB, createAgentCredits } from "./credits";
import { AgentError } from "./errors";

const NOW = Date.UTC(2026, 8, 25, 22);

function fakeClient() {
  const urls: string[] = [];
  const client = createEodhdClient(() => "k".repeat(20), async (url: string) => {
    urls.push(new URL(url).pathname);
    return Response.json(url.includes("/fundamentals/") ? { General: {} } : []);
  });
  return { client, urls };
}

describe("agent credit budget", () => {
  test("call costs", () => {
    expect(eodhdCallCost("/fundamentals/AAPL.US")).toBe(10);
    expect(eodhdCallCost("/news", { s: "AAPL.US" })).toBe(5);
    expect(eodhdCallCost("/search/apple")).toBe(1);
    expect(eodhdCallCost("/eod/AAPL.US")).toBe(1);
    expect(eodhdCallCost("/intraday/AAPL.US")).toBe(5);
    expect(eodhdCallCost("/real-time/AAPL.US", { s: "MSFT.US,TSLA.US" })).toBe(3);
    expect(eodhdCallCost("/user")).toBe(0);
  });

  test("upstream calls inside run() are recorded in the ledger and refused past the budget", async () => {
    const db = new Database(":memory:");
    const credits = createAgentCredits(db, { budget: 25, nowMs: () => NOW });
    const { client, urls } = fakeClient();
    await credits.run(async () => {
      await client.raw("/fundamentals/AAPL.US");
      await client.raw("/news", { s: "AAPL.US" });
      await client.search("apple");
    });
    expect(credits.usedToday()).toBe(16);
    const row = db.query<{ credits: number; calls: number }, [string]>("SELECT credits, calls FROM universe_credits WHERE job = ?").get(AGENT_LEDGER_JOB)!;
    expect(row).toEqual({ credits: 16, calls: 3 });

    const e = await credits.run(() => client.raw("/fundamentals/MSFT.US")).catch((x) => x);
    expect(e).toBeInstanceOf(AgentError);
    expect((e as AgentError).status).toBe(429);
    expect(Number((e as AgentError).headers["retry-after"])).toBe(2 * 3600); // to midnight UTC
    expect(urls.some((u) => u.endsWith("/fundamentals/MSFT.US"))).toBe(false);
    expect(urls.length).toBe(3);
    await credits.run(() => client.search("msft")); // 17 + 1 still fits
    expect(credits.usedToday()).toBe(17);
  });

  test("calls outside run() (UI, pipeline) are not metered", async () => {
    const db = new Database(":memory:");
    const credits = createAgentCredits(db, { budget: 0, nowMs: () => NOW });
    const { client, urls } = fakeClient();
    await client.raw("/fundamentals/AAPL.US");
    expect(urls.length).toBe(1);
    expect(credits.usedToday()).toBe(0);
    await expect(credits.run(() => client.raw("/fundamentals/AAPL.US"))).rejects.toBeInstanceOf(AgentError);
    expect(urls.length).toBe(1);
  });

  test("a new UTC day starts from zero", async () => {
    const db = new Database(":memory:");
    let now = NOW;
    const credits = createAgentCredits(db, { budget: 10, nowMs: () => now });
    const { client } = fakeClient();
    await credits.run(() => client.raw("/fundamentals/A.US"));
    await expect(credits.run(() => client.raw("/eod/A.US"))).rejects.toBeInstanceOf(AgentError);
    now += 3 * 3600_000;
    await credits.run(() => client.raw("/eod/A.US"));
    expect(credits.usedToday()).toBe(1);
  });
});
