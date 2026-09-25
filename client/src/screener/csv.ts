// Pure CSV generation + paged collection for the screener export. Covered by csv.test.ts.
import type { ScreenerColumnDef, ScreenerResponse } from "@eodview/shared";

export type Row = ScreenerResponse["rows"][number];
export const CSV_PAGE = 500;
export const CSV_CAP = 5000;

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  // neutralise spreadsheet formula injection from text fields (names, news titles…)
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header = column labels (raw numeric values, not display-formatted). Adds "No." like Finviz's export. */
export function buildCsv(columns: Pick<ScreenerColumnDef, "id" | "label">[], rows: Row[]): string {
  const lines = [["No.", ...columns.map((c) => c.label)].map(csvEscape).join(",")];
  rows.forEach((r, i) => {
    lines.push([i + 1, ...columns.map((c) => r[c.id] ?? (c.id === "ticker" ? tickerOf(r) : null))].map(csvEscape).join(","));
  });
  return lines.join("\r\n") + "\r\n";
}

export function tickerOf(r: Row): string {
  const t = r.ticker;
  if (typeof t === "string" && t) return t;
  const sym = typeof r.symbol === "string" ? r.symbol : "";
  const i = sym.lastIndexOf(".");
  return i > 0 ? sym.slice(0, i) : sym;
}

/**
 * Fetch rows page by page (`pageSize` each) until the total, an empty/short page, or `cap` is reached.
 * `onProgress(done, target)` is called after each page.
 */
export async function collectRows(
  fetchPage: (offset: number, limit: number) => Promise<ScreenerResponse>,
  opts: { cap?: number; pageSize?: number; onProgress?: (done: number, target: number) => void; signal?: AbortSignal } = {},
): Promise<{ rows: Row[]; total: number; truncated: boolean }> {
  const cap = opts.cap ?? CSV_CAP;
  const size = Math.min(opts.pageSize ?? CSV_PAGE, 500);
  const rows: Row[] = [];
  let total = Infinity;
  while (rows.length < Math.min(cap, total)) {
    if (opts.signal?.aborted) throw new Error("Export cancelled");
    const limit = Math.min(size, cap - rows.length);
    const res = await fetchPage(rows.length, limit);
    total = res.total;
    rows.push(...res.rows.slice(0, limit));
    opts.onProgress?.(rows.length, Math.min(cap, total));
    if (res.rows.length < limit) break;
  }
  return { rows, total: Number.isFinite(total) ? total : rows.length, truncated: Number.isFinite(total) && total > rows.length };
}

export function csvFilename(now: Date = new Date(), view = "overview"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `screener-${view}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.csv`;
}
