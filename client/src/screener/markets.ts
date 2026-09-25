// Pure market-selector + per-market filter availability logic. Covered by markets.test.ts.
import type { MarketInfo, ScreenerFilterDef, ScreenerFilterValue } from "@eodview/shared";
import { ALL_MARKETS, DEFAULT_MARKET } from "./queryState";

/** Country names as EODHD writes them -> ISO 3166 alpha-2 (for the flag emoji). */
const COUNTRY_ISO: Record<string, string> = {
  usa: "US", "united states": "US", us: "US",
  uk: "GB", "united kingdom": "GB", "great britain": "GB", england: "GB",
  sweden: "SE", norway: "NO", denmark: "DK", finland: "FI", iceland: "IS",
  germany: "DE", france: "FR", netherlands: "NL", belgium: "BE", luxembourg: "LU", switzerland: "CH", austria: "AT",
  italy: "IT", spain: "ES", portugal: "PT", ireland: "IE", greece: "GR", poland: "PL", hungary: "HU", czechia: "CZ",
  "czech republic": "CZ", turkey: "TR", israel: "IL",
  canada: "CA", mexico: "MX", brazil: "BR", argentina: "AR", chile: "CL", peru: "PE", colombia: "CO",
  australia: "AU", "new zealand": "NZ", japan: "JP", china: "CN", "hong kong": "HK", taiwan: "TW", korea: "KR",
  "south korea": "KR", india: "IN", singapore: "SG", indonesia: "ID", thailand: "TH", malaysia: "MY",
  philippines: "PH", vietnam: "VN", "south africa": "ZA", "saudi arabia": "SA", uae: "AE", "united arab emirates": "AE",
};

/** "Sweden" / "SE" -> 🇸🇪; unknown -> 🌐. */
export function flagEmoji(country: string | null | undefined): string {
  const c = (country ?? "").trim();
  const iso = COUNTRY_ISO[c.toLowerCase()] ?? (/^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : undefined);
  if (!iso) return "\u{1F310}";
  return String.fromCodePoint(...[...iso].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export function findMarket(markets: MarketInfo[] | undefined, code: string): MarketInfo | undefined {
  return markets?.find((m) => m.code === code);
}

/** Human name used in notices: "Nasdaq Stockholm", "all markets", or the raw code. */
export function marketName(markets: MarketInfo[] | undefined, code: string): string {
  if (code === ALL_MARKETS) return "all markets";
  return findMarket(markets, code)?.name ?? code;
}

/** Option text: "🇸🇪 Nasdaq Stockholm (ST)". */
export function marketOptionLabel(m: MarketInfo): string {
  return `${flagEmoji(m.country)} ${m.name} (${m.code})`;
}

/** Option tooltip: counts, last price date, and why it is disabled. */
export function marketOptionTitle(m: MarketInfo): string {
  const n = (x: number) => (Number.isFinite(x) ? x.toLocaleString("en-US") : "?");
  const parts = [
    `${n(m.symbols)} symbols`,
    `${n(m.withPrices)} with prices`,
    `${n(m.withFundamentals)} with fundamentals`,
    `currency ${m.currency}`,
  ];
  if (m.lastPriceDate) parts.push(`last price ${m.lastPriceDate}`);
  const head = m.enabled ? "" : "Not enabled on the server (EODVIEW_MARKETS) — ";
  return head + parts.join(" · ");
}

/**
 * The market to actually query: the stored one if the server knows it and it is enabled (or "ALL"),
 * otherwise US if enabled, otherwise the first enabled market. Unknown lists (older server) keep the stored value.
 */
export function resolveMarket(stored: string, markets: MarketInfo[] | undefined): string {
  if (!markets || markets.length === 0) return stored;
  if (stored === ALL_MARKETS) return stored;
  const m = findMarket(markets, stored);
  if (m?.enabled) return stored;
  const enabled = markets.filter((x) => x.enabled);
  if (enabled.some((x) => x.code === DEFAULT_MARKET)) return DEFAULT_MARKET;
  return enabled[0]?.code ?? stored;
}

/** "All markets" only makes sense when more than one market is enabled. */
export function showAllOption(markets: MarketInfo[] | undefined): boolean {
  return (markets ?? []).filter((m) => m.enabled).length > 1;
}

export interface IgnoredFilter {
  id: string;
  label: string;
  reason: string;
}

/** Active filters that the current market's meta marks unavailable, with the reason (in state order). */
export function ignoredFilters(filters: ScreenerFilterValue[], defs: ScreenerFilterDef[] | undefined): IgnoredFilter[] {
  if (!defs) return [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: IgnoredFilter[] = [];
  for (const f of filters) {
    const d = byId.get(f.id);
    if (d && !d.available) out.push({ id: d.id, label: d.label, reason: d.unavailableReason ?? "No data for this market" });
  }
  return out;
}

/** "2 filters ignored for Nasdaq Stockholm" / null. */
export function ignoredNotice(count: number, name: string): string | null {
  if (count <= 0) return null;
  return `${count} filter${count === 1 ? "" : "s"} ignored for ${name}`;
}

/** Local-currency display is on for every market except US (ALL mixes currencies). */
export function showsLocalCurrency(market: string): boolean {
  return market !== DEFAULT_MARKET;
}

/** The single currency of the selected market (undefined for ALL / unknown). */
export function marketCurrency(markets: MarketInfo[] | undefined, market: string): string | undefined {
  if (market === ALL_MARKETS) return undefined;
  return findMarket(markets, market)?.currency || undefined;
}
