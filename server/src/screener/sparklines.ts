// Validation for GET /api/screener/sparklines?symbols=A.US,B.US&days=60
import { HttpError } from "../http";
import { normalizeSymbol } from "../store/validate";

export const MAX_SPARKLINE_SYMBOLS = 200;
export const DEFAULT_SPARKLINE_DAYS = 60;
export const MAX_SPARKLINE_DAYS = 400;

export function parseSparklineParams(url: URL): { symbols: string[]; days: number } {
  const raw = (url.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (raw.length > MAX_SPARKLINE_SYMBOLS) throw new HttpError(400, `at most ${MAX_SPARKLINE_SYMBOLS} symbols`);
  const symbols: string[] = [];
  for (const s of raw) {
    // Accept bare US tickers from the screener grid ("AAPL" → "AAPL.US").
    const sym = normalizeSymbol(s) ?? normalizeSymbol(`${s}.US`);
    if (!sym) throw new HttpError(400, `invalid symbol ${JSON.stringify(s.slice(0, 40))}`);
    if (!symbols.includes(sym)) symbols.push(sym);
  }
  const d = url.searchParams.get("days");
  let days = DEFAULT_SPARKLINE_DAYS;
  if (d !== null && d !== "") {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 2 || n > MAX_SPARKLINE_DAYS) throw new HttpError(400, `days must be an integer 2..${MAX_SPARKLINE_DAYS}`);
    days = n;
  }
  return { symbols, days };
}
