// v3 market selector for the screener top row (native <select>: disabled options + per-option tooltips for free).
import { ALL_MARKETS } from "./queryState";
import { findMarket, flagEmoji, marketOptionLabel, marketOptionTitle, showAllOption } from "./markets";
import { useScreener } from "./screenerStore";

export function MarketSelect() {
  const market = useScreener((s) => s.q.market);
  const markets = useScreener((s) => s.meta?.markets);
  const metaMarket = useScreener((s) => s.metaMarket);
  const setMarket = useScreener((s) => s.setMarket);
  const list = Array.isArray(markets) ? markets : [];
  if (list.length === 0) return null; // pre-v3 server: US only, nothing to choose
  const cur = findMarket(list, market);
  const loading = metaMarket !== null && metaMarket !== market;
  const known = market === ALL_MARKETS || !!cur;
  const title = market === ALL_MARKETS ? "All enabled markets (prices in local currency; USD columns for comparison)" : cur ? marketOptionTitle(cur) : market;
  return (
    <label className={`scr-market${loading ? " loading" : ""}`} title={title}>
      <span className="scr-market-flag" aria-hidden="true">{market === ALL_MARKETS ? "\u{1F310}" : flagEmoji(cur?.country)}</span>
      <select
        className="scr-select scr-market-select"
        aria-label="Market"
        value={market}
        onChange={(e) => setMarket(e.target.value)}
      >
        {showAllOption(list) && <option value={ALL_MARKETS} title="Every enabled market">All markets</option>}
        {!known && <option value={market}>{market}</option>}
        {list.map((m) => (
          <option key={m.code} value={m.code} disabled={!m.enabled} title={marketOptionTitle(m)}>
            {marketOptionLabel(m)}{m.enabled ? "" : " — not enabled"}
          </option>
        ))}
      </select>
    </label>
  );
}
