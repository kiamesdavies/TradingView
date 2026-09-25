// Symbol search over the local universe DB (no EODHD credits). Ranks exact ticker > ticker prefix > name match,
// then by market cap.
import type { Database } from "bun:sqlite";
import type { AssetClass, SymbolInfo } from "@eodview/shared";

interface Row { symbol: string; code: string | null; name: string | null; kind: string | null; country: string | null; currency: string | null }

export function createLocalSearch(db: Database, table = "universe_metrics") {
  const present = () => {
    try {
      return new Set(db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
    } catch {
      return new Set<string>();
    }
  };

  return (qRaw: string, limit: number): SymbolInfo[] => {
    const cols = present();
    if (!cols.has("symbol") || !cols.has("code")) return [];
    const q = qRaw.trim().toUpperCase();
    if (!q) return [];
    const opt = (c: string) => (cols.has(c) ? `"${c}"` : "NULL");
    const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = db.query<Row, (string | number)[]>(
      `SELECT symbol, code, ${opt("name")} AS name, ${opt("kind")} AS kind, ${opt("country")} AS country, ${opt("currency")} AS currency
       FROM "${table}"
       WHERE UPPER(code) = ? OR UPPER(symbol) = ? OR UPPER(code) LIKE ? ESCAPE '\\' OR UPPER(${opt("name")}) LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN UPPER(code) = ? OR UPPER(symbol) = ? THEN 0 WHEN UPPER(code) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                ${opt("market_cap")} IS NULL, ${opt("market_cap")} DESC, symbol
       LIMIT ?`,
    ).all(q, q, `${esc}%`, `%${esc}%`, q, q, `${esc}%`, Math.max(1, Math.min(50, limit)));
    return rows.map((r) => {
      const dot = r.symbol.lastIndexOf(".");
      const exchange = dot > 0 ? r.symbol.slice(dot + 1) : "US";
      const etf = r.kind === "etf";
      const assetClass: AssetClass = etf ? "etf" : exchange === "US" ? "us_stock" : "stock";
      return {
        symbol: r.symbol, code: r.code ?? r.symbol.slice(0, dot), exchange, name: r.name ?? "",
        type: etf ? "ETF" : "Common Stock", assetClass, streamable: exchange === "US",
        ...(r.country ? { country: r.country } : {}), ...(r.currency ? { currency: r.currency } : {}),
      };
    });
  };
}
