import { describe, expect, test } from "bun:test";
import fixture from "./__fixtures__/aapl-news.json";
import { SUMMARY_MAX, mapNews, newsId, summarize } from "./news";

describe("mapNews", () => {
  test("maps the EODHD /news fixture", () => {
    const items = mapNews(fixture);
    expect(items).toHaveLength(3);
    const [a] = items;
    expect(a.title).toBe("Apple shares near buy point after new iPhone launch");
    expect(a.url).toStartWith("https://finance.yahoo.com/");
    expect(a.source).toBe("finance.yahoo.com");
    expect(a.publishedAt).toBe(Date.parse("2026-09-25T12:00:16+00:00") / 1000);
    expect(a.symbols).toEqual(["AAPL.US"]);
    expect(a.sentiment).toBe(0.718);
    expect(a.id).toBe(newsId(a.url));
    expect(a.summary!.startsWith("Apple stock traded just below a buy point. Analysts raised targets & reiterated")).toBe(true);
    expect(a.summary!.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
    expect(a.summary!.endsWith("…")).toBe(true);
    expect(items[2].summary).toBeUndefined(); // empty content
    expect(items.map((i) => i.publishedAt)).toEqual([...items.map((i) => i.publishedAt)].sort((x, y) => y - x));
  });

  test("ids are stable and duplicates / invalid rows are dropped", () => {
    const row = { date: "2026-01-01T00:00:00+00:00", title: "T", link: "https://x.com/a", symbols: ["A.US", 5], content: "c" };
    const out = mapNews([row, { ...row }, { ...row, link: "javascript:alert(1)" }, { ...row, date: "nope" }, null, { title: "no link" }]);
    expect(out).toHaveLength(1);
    expect(out[0].symbols).toEqual(["A.US"]);
    expect(newsId("https://x.com/a")).toBe(newsId("https://x.com/a"));
    expect(newsId("https://x.com/a")).not.toBe(newsId("https://x.com/b"));
    expect(mapNews({ error: "x" })).toEqual([]);
  });

  test("summarize strips html and entities", () => {
    expect(summarize("<div>Hello&nbsp;<b>world</b> &#39;x&#39; &#x41;</div>\n\n  ok<script>bad()</script>")).toBe("Hello world 'x' A ok");
    expect(summarize("word ".repeat(100), 20)).toBe("word word word word…");
  });
});
