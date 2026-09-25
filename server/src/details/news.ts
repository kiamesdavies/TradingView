// EODHD /news → NewsItem[]. Pure.
import type { NewsItem } from "@eodview/shared";

export const SUMMARY_MAX = 280;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Stable, short id derived from the article link. */
export function newsId(link: string): string {
  return Bun.hash(link).toString(36);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Strip tags, decode common entities and collapse whitespace. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] !== undefined) return ENTITIES[k];
      if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** plainText, cut to ~max chars on a word boundary with an ellipsis. */
export function summarize(content: string, max = SUMMARY_MAX): string {
  const text = plainText(content);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

function sourceOf(link: string): string | undefined {
  try {
    return new URL(link).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

export function mapNews(raw: unknown): NewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isObj(r)) continue;
    const url = typeof r.link === "string" ? r.link.trim() : "";
    const title = typeof r.title === "string" ? plainText(r.title) : "";
    const ms = typeof r.date === "string" ? Date.parse(r.date) : NaN;
    if (!url || !/^https?:\/\//i.test(url) || !title || !Number.isFinite(ms)) continue;
    const id = newsId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    const item: NewsItem = {
      id,
      title,
      url,
      publishedAt: Math.floor(ms / 1000),
      symbols: Array.isArray(r.symbols) ? r.symbols.filter((s): s is string => typeof s === "string") : [],
    };
    const source = sourceOf(url);
    if (source) item.source = source;
    const pol = isObj(r.sentiment) ? Number(r.sentiment.polarity) : NaN;
    if (Number.isFinite(pol)) item.sentiment = Math.max(-1, Math.min(1, pol));
    const summary = typeof r.content === "string" ? summarize(r.content) : "";
    if (summary) item.summary = summary;
    out.push(item);
  }
  out.sort((a, b) => b.publishedAt - a.publishedAt);
  return out;
}
