// Symbol details panel (right sidebar "Details" tab), modelled on TradingView's symbol panel.
import { useEffect, useState, type ReactNode } from "react";
import type { KeyStat, NewsItem, Quote, Symbol, SymbolOverview } from "@eodview/shared";
import { useStore } from "../state/store";
import { useShell } from "../components/shellStore";
import { useLiveQuotes } from "../components/useLiveQuotes";
import { direction, formatChange, formatPct, formatPrice, splitSymbol } from "../components/format";
import { EarningsChart } from "./EarningsChart";
import { NewsList } from "./NewsList";
import {
  analystTotal, avatarColor, consensusOf, displayHost, formatClock, formatDate, formatDaysUntil, formatNumber,
  formatShortDate, formatStat, lacksFundamentals, resolveTimeZone, safeUrl, upsidePct,
} from "./format";
import { CheckIcon, ChevronDown, ChevronRight, CopyIcon, MoonSmall, NewsIcon, RetryIcon, SunSmall } from "./icons";
import { useOverview, type LoadError } from "./useDetailsData";
import "./details.css";

const TIMING_LABEL = { BeforeMarket: "Before market open", AfterMarket: "After market close" } as const;

export function DetailsPanel() {
  const symbol = useStore((s) => s.layout.symbol);
  const layoutTz = useStore((s) => s.layout.timezone);
  const [view, setView] = useState<"main" | "news">("main");
  useEffect(() => setView("main"), [symbol]);
  useLiveQuotes([symbol]);

  const ov = useOverview(symbol);
  const tz = resolveTimeZone(layoutTz, symbol);
  const { code } = splitSymbol(symbol);

  if (view === "news") {
    return (
      <div className="dtl-panel">
        <NewsList symbol={symbol} code={code} tz={tz} onBack={() => setView("main")} />
      </div>
    );
  }

  const data = ov.data;
  const noFundamentals = lacksFundamentals(symbol, data?.profile.type);
  const skeleton = ov.loading && !data;

  return (
    <div className="dtl-panel">
      <div className="dtl-scroll">
        <Header symbol={symbol} data={data} loading={skeleton} onNews={noFundamentals ? undefined : () => setView("news")} />
        <PriceBlock symbol={symbol} data={data} loading={skeleton} tz={tz} />
        {noFundamentals ? (
          <div className="dtl-note">Fundamentals are not available for {kindName(symbol, data?.profile.type)}.</div>
        ) : data ? (
          <>
            {data.latestNews && <NewsCard item={data.latestNews} tz={tz} onMore={() => setView("news")} />}
            {data.stats.length > 0 && <KeyStats stats={data.stats} />}
            {(data.earnings.length > 0 || data.revenue.length > 0) && <Earnings data={data} />}
            {data.analyst && (analystTotal(data.analyst) > 0 || data.analyst.targetPrice !== null) && (
              <Analyst analyst={data.analyst} price={data.quote?.price ?? null} currency={data.profile.currency} symbol={symbol} />
            )}
            <Profile data={data} />
            {data.fundamentalsAsOf ? <div className="dtl-foot">Fundamentals as of {formatDate(data.fundamentalsAsOf)}</div> : null}
          </>
        ) : ov.loading ? (
          <SkeletonBody />
        ) : ov.error ? (
          <ErrorState error={ov.error} symbol={code} onRetry={ov.reload} />
        ) : null}
      </div>
    </div>
  );
}

function kindName(symbol: Symbol, type?: string): string {
  if (/\.FOREX$/i.test(symbol)) return "currency pairs";
  if (/\.CC$/i.test(symbol)) return "crypto assets";
  if (/\.INDX$/i.test(symbol)) return "indices";
  return type ? `${type.toLowerCase()} symbols` : "this symbol";
}

// ---------- header ----------

function Logo({ url, letter }: { url?: string; letter: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) {
    return (
      <span className="dtl-logo dtl-logo-letter" style={{ background: avatarColor(letter) }} aria-hidden="true">
        {letter.charAt(0).toUpperCase()}
      </span>
    );
  }
  return <img className="dtl-logo" src={url} alt="" onError={() => setFailed(true)} />;
}

function Header({ symbol, data, loading, onNews }: { symbol: Symbol; data: SymbolOverview | null; loading: boolean; onNews?: () => void }) {
  const { code, exchange } = splitSymbol(symbol);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(symbol).then(() => setCopied(true), () => undefined);
  };
  const p = data?.profile;
  const sub = [p?.sector, p?.industry].filter(Boolean).join(" • ");
  return (
    <div className="dtl-header">
      <div className="dtl-header-top">
        <Logo key={symbol} url={p?.logoUrl} letter={code} />
        <span className="dtl-ticker" title={symbol}>{code}</span>
        <span className="dtl-header-actions">
          {onNews && (
            <button type="button" className="icon-btn dtl-icon" onClick={onNews} title="News" aria-label="Open news list">
              <NewsIcon size={16} />
            </button>
          )}
          <button type="button" className="icon-btn dtl-icon" onClick={copy} title={copied ? "Copied" : `Copy ${symbol}`} aria-label="Copy symbol">
            {copied ? <CheckIcon size={16} className="up" /> : <CopyIcon size={16} />}
          </button>
        </span>
      </div>
      {loading ? (
        <>
          <div className="dtl-skel" style={{ width: "75%", height: 13, marginTop: 8 }} />
          <div className="dtl-skel" style={{ width: "55%", height: 11, marginTop: 6 }} />
        </>
      ) : (
        <>
          <div className="dtl-name">
            <span className="dtl-ellipsis" title={p?.name}>{p?.name || code}</span>
            <span className="dtl-dot-sep">·</span>
            <span className="dtl-exchange">{p?.exchange || exchange}</span>
          </div>
          {sub && <div className="dtl-muted dtl-ellipsis" title={sub}>{sub}</div>}
        </>
      )}
    </div>
  );
}

// ---------- price ----------

function pickQuote(live: Quote | undefined, snap: Quote | null | undefined): Quote | null {
  if (live && Number.isFinite(live.price)) {
    // A streamed quote may not know its change yet; derive it from the snapshot's previous close.
    if (!Number.isFinite(live.change) && snap && Number.isFinite(snap.prevClose) && snap.prevClose !== 0) {
      const change = live.price - snap.prevClose;
      return { ...live, change, changePct: (change / snap.prevClose) * 100 };
    }
    return live;
  }
  return snap ?? null;
}

function PriceBlock({ symbol, data, loading, tz }: { symbol: Symbol; data: SymbolOverview | null; loading: boolean; tz?: string }) {
  const live = useStore((s) => s.quotes[symbol]);
  const baseExt = data?.extended ?? null;
  // Outside regular hours the streamed trades are pre/post-market prints: keep the regular-session close as the
  // main price (as TradingView does) and move the live print onto the extended-hours line instead.
  const q = baseExt && data?.quote ? data.quote : pickQuote(live, data?.quote);
  const currency = data?.profile.currency;
  if (!q) {
    if (!loading) return null;
    return (
      <div className="dtl-price">
        <div className="dtl-skel" style={{ width: "60%", height: 30 }} />
        <div className="dtl-skel" style={{ width: "40%", height: 11, marginTop: 8 }} />
      </div>
    );
  }
  const ext =
    baseExt && live && Number.isFinite(live.price) && live.time > baseExt.time
      ? { ...baseExt, price: live.price, time: live.time, change: live.price - q.price, changePct: q.price ? ((live.price - q.price) / q.price) * 100 : NaN }
      : baseExt;
  return (
    <div className="dtl-price">
      <div className="dtl-price-main">
        <span className="dtl-last">{formatPrice(q.price, symbol)}</span>
        {currency && <span className="dtl-currency">{currency}</span>}
        <span className={`dtl-change ${direction(q.change)}`}>
          {formatChange(q.change, symbol, q.price)} {formatPct(q.changePct)}
        </span>
      </div>
      <div className="dtl-muted dtl-small">Last update at {formatClock(q.time, tz)}</div>
      {ext && Number.isFinite(ext.price) && (
        <div className="dtl-ext">
          <div className="dtl-ext-line">
            <span className="dtl-ext-price">{formatPrice(ext.price, symbol)}</span>
            <span className={`dtl-change ${direction(ext.change)}`}>
              {formatChange(ext.change, symbol, ext.price)} {formatPct(ext.changePct)}
            </span>
            <span className={`dtl-session dtl-session-${ext.session}`}>
              {ext.session === "pre" ? <SunSmall size={14} /> : <MoonSmall size={14} />}
              {ext.session === "pre" ? "Pre-market" : "Post-market"}
            </span>
          </div>
          <div className="dtl-muted dtl-small">Last update at {formatClock(ext.time, tz)}</div>
        </div>
      )}
    </div>
  );
}

// ---------- news card ----------

function NewsCard({ item, tz, onMore }: { item: NewsItem; tz?: string; onMore(): void }) {
  const href = safeUrl(item.url);
  return (
    <div className="dtl-newscard">
      <div className="dtl-newscard-head">
        <span>News</span>
        <span className="dtl-dot-sep">•</span>
        <span>{formatShortDate(item.publishedAt, tz)}</span>
      </div>
      {href ? (
        <a className="dtl-newscard-title" href={href} target="_blank" rel="noopener noreferrer" title={item.title}>
          {item.title}
        </a>
      ) : (
        <div className="dtl-newscard-title">{item.title}</div>
      )}
      <button type="button" className="dtl-link-btn" onClick={onMore}>
        More news <ChevronRight size={12} />
      </button>
    </div>
  );
}

// ---------- key stats ----------

function KeyStats({ stats }: { stats: KeyStat[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? stats : stats.slice(0, 4);
  return (
    <section className="dtl-section">
      <h3 className="dtl-h">Key stats</h3>
      <dl className="dtl-stats">
        {shown.map((s) => (
          <div key={s.key} className="dtl-stat">
            <dt title={s.label}>{s.label}</dt>
            <dd>{formatStat(s.value, s.format)}</dd>
          </div>
        ))}
      </dl>
      {stats.length > 4 && (
        <button type="button" className="dtl-expand" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Show less" : `Show ${stats.length - 4} more`}
          <ChevronDown size={14} className={open ? "dtl-rot" : undefined} />
        </button>
      )}
    </section>
  );
}

// ---------- earnings ----------

function Earnings({ data }: { data: SymbolOverview }) {
  const hasEps = data.earnings.some((p) => p.epsActual !== null || p.epsEstimate !== null);
  const hasRev = data.revenue.some((p) => p.revenue !== null);
  const [mode, setMode] = useState<"eps" | "revenue">(hasEps || !hasRev ? "eps" : "revenue");
  const next = data.nextEarnings;
  return (
    <section className="dtl-section">
      <div className="dtl-h-row">
        <h3 className="dtl-h">Earnings</h3>
        {next && <span className="dtl-pill">{formatDaysUntil(next.daysUntil)}</span>}
      </div>
      {next && (
        <div className="dtl-muted dtl-small dtl-next">
          Next report {formatDate(next.date)}
          {next.timing ? ` · ${TIMING_LABEL[next.timing]}` : ""}
          {next.epsEstimate !== null && Number.isFinite(next.epsEstimate) ? ` · EPS est. ${next.epsEstimate.toFixed(2)}` : ""}
        </div>
      )}
      <div className="dtl-seg" role="tablist" aria-label="Earnings metric">
        <button type="button" role="tab" aria-selected={mode === "eps"} className={mode === "eps" ? "active" : ""} onClick={() => setMode("eps")}>
          EPS
        </button>
        <button type="button" role="tab" aria-selected={mode === "revenue"} className={mode === "revenue" ? "active" : ""} onClick={() => setMode("revenue")}>
          Revenue
        </button>
      </div>
      <EarningsChart mode={mode} earnings={data.earnings} revenue={data.revenue} currency={data.profile.currency} />
      {mode === "eps" && (
        <div className="dtl-legend">
          <span><i className="dtl-lg dtl-lg-est" /> Estimate</span>
          <span><i className="dtl-lg dtl-lg-beat" /> Beat</span>
          <span><i className="dtl-lg dtl-lg-miss" /> Missed</span>
        </div>
      )}
    </section>
  );
}

// ---------- analyst ----------

const RATINGS = [
  { key: "strongBuy", label: "Strong buy", cls: "sb" },
  { key: "buy", label: "Buy", cls: "b" },
  { key: "hold", label: "Hold", cls: "h" },
  { key: "sell", label: "Sell", cls: "s" },
  { key: "strongSell", label: "Strong sell", cls: "ss" },
] as const;

function Analyst({ analyst, price, currency, symbol }: { analyst: NonNullable<SymbolOverview["analyst"]>; price: number | null; currency?: string; symbol: Symbol }) {
  const live = useStore((s) => s.quotes[symbol]?.price);
  const ref = live !== undefined && Number.isFinite(live) ? live : price;
  const total = analystTotal(analyst);
  const consensus = consensusOf(analyst);
  const up = upsidePct(analyst.targetPrice, ref);
  const consCls = !consensus ? "" : consensus.label.endsWith("buy") || consensus.label === "Buy" ? "up" : consensus.label.toLowerCase().endsWith("sell") ? "down" : "";
  return (
    <section className="dtl-section">
      <h3 className="dtl-h">Analyst rating</h3>
      {consensus && (
        <div className="dtl-consensus">
          <span className={`dtl-consensus-label ${consCls}`}>{consensus.label}</span>
          {total > 0 && <span className="dtl-muted dtl-small">based on {total} analyst{total === 1 ? "" : "s"}</span>}
        </div>
      )}
      {total > 0 && (
        <>
          <div className="dtl-rating-bar" role="img" aria-label={RATINGS.map((r) => `${r.label} ${analyst[r.key]}`).join(", ")}>
            {RATINGS.map((r) =>
              analyst[r.key] > 0 ? (
                <span key={r.key} className={`dtl-rb-${r.cls}`} style={{ flexGrow: analyst[r.key] }} title={`${r.label}: ${analyst[r.key]}`} />
              ) : null,
            )}
          </div>
          <div className="dtl-rating-legend">
            {RATINGS.map((r) => (
              <div key={r.key} className="dtl-rating-row">
                <i className={`dtl-sw dtl-rb-${r.cls}`} />
                <span>{r.label}</span>
                <b>{analyst[r.key]}</b>
              </div>
            ))}
          </div>
        </>
      )}
      {analyst.targetPrice !== null && Number.isFinite(analyst.targetPrice) && (
        <div className="dtl-stat dtl-target">
          <span className="dtl-stat-label">Price target</span>
          <span className="dtl-stat-value">
            {formatPrice(analyst.targetPrice, symbol)}
            {currency ? ` ${currency}` : ""}
            {up !== null && <span className={up >= 0 ? "up" : "down"}> ({formatPct(up)})</span>}
          </span>
        </div>
      )}
    </section>
  );
}

// ---------- profile ----------

function Profile({ data }: { data: SymbolOverview }) {
  const p = data.profile;
  const [more, setMore] = useState(false);
  const site = safeUrl(p.website);
  const rows: [string, ReactNode][] = [];
  if (site) {
    rows.push(["Website", <a href={site} target="_blank" rel="noopener noreferrer">{displayHost(site)}</a>]);
  }
  if (typeof p.employees === "number" && Number.isFinite(p.employees)) rows.push(["Employees", formatNumber(p.employees, 0)]);
  if (p.ipoDate) rows.push(["IPO date", formatDate(p.ipoDate)]);
  if (p.country) rows.push(["Country", p.country]);
  if (!p.description && rows.length === 0) return null;
  const long = (p.description?.length ?? 0) > 220;
  return (
    <section className="dtl-section">
      <h3 className="dtl-h">Profile</h3>
      {p.description && (
        <div className="dtl-desc-wrap">
          <p className={`dtl-desc${more || !long ? "" : " clamped"}`}>{p.description}</p>
          {long && (
            <button type="button" className="dtl-link-btn" onClick={() => setMore((v) => !v)} aria-expanded={more}>
              {more ? "less" : "more"}
            </button>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <dl className="dtl-stats">
          {rows.map(([label, value]) => (
            <div key={label} className="dtl-stat">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// ---------- states ----------

function SkeletonBody() {
  return (
    <div aria-busy="true" aria-label="Loading details">
      <div className="dtl-skel dtl-skel-card" />
      <section className="dtl-section">
        <div className="dtl-skel" style={{ width: 90, height: 14, marginBottom: 12 }} />
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="dtl-skel-row">
            <div className="dtl-skel" style={{ width: "45%", height: 11 }} />
            <div className="dtl-skel" style={{ width: "25%", height: 11 }} />
          </div>
        ))}
      </section>
      <section className="dtl-section">
        <div className="dtl-skel" style={{ width: 80, height: 14, marginBottom: 12 }} />
        <div className="dtl-skel" style={{ width: "100%", height: 150 }} />
      </section>
    </div>
  );
}

function ErrorState({ error, symbol, onRetry }: { error: LoadError; symbol: string; onRetry(): void }) {
  const openSettings = useShell((s) => s.openSettings);
  if (error.kind === "no_key") {
    return (
      <div className="dtl-state">
        <div className="dtl-state-title">EODHD API key missing</div>
        <div className="dtl-muted">Add your API key in Settings to load fundamentals, earnings and news.</div>
        <button type="button" className="btn btn-primary" onClick={() => openSettings()}>Open settings</button>
      </div>
    );
  }
  const title =
    error.kind === "not_found" ? `No details available for ${symbol}` : error.kind === "plan" ? "Not included in your EODHD plan" : "Couldn't load details";
  return (
    <div className="dtl-state" role="alert">
      <div className="dtl-state-title">{title}</div>
      <div className="dtl-muted dtl-small">{error.message}</div>
      <button type="button" className="btn" onClick={onRetry}>
        <RetryIcon size={14} /> Retry
      </button>
    </div>
  );
}
