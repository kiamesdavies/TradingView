// In-panel news list (title, source, relative time, sentiment dot) with a back button.
import type { Symbol } from "@eodview/shared";
import { BackIcon, RetryIcon } from "./icons";
import { formatRelative, safeUrl, sentimentOf } from "./format";
import { useNews } from "./useDetailsData";

export function NewsList({ symbol, code, tz, onBack }: { symbol: Symbol; code: string; tz?: string; onBack(): void }) {
  const news = useNews(symbol, true);
  const now = Date.now();
  return (
    <div className="dtl-news">
      <div className="dtl-news-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to details" title="Back">
          <BackIcon size={18} />
        </button>
        <span className="dtl-news-title">{code} news</span>
      </div>
      <div className="dtl-scroll">
        {news.loading && (
          <div className="dtl-news-items" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="dtl-news-item">
                <div className="dtl-skel" style={{ width: "92%", height: 12 }} />
                <div className="dtl-skel" style={{ width: "70%", height: 12, marginTop: 6 }} />
                <div className="dtl-skel" style={{ width: "40%", height: 10, marginTop: 8 }} />
              </div>
            ))}
          </div>
        )}
        {news.error && (
          <div className="dtl-state">
            <div>{news.error.kind === "no_key" ? "Add your EODHD API key in Settings to load news." : news.error.message}</div>
            {news.error.kind !== "no_key" && (
              <button type="button" className="btn" onClick={news.reload}>
                <RetryIcon size={14} /> Retry
              </button>
            )}
          </div>
        )}
        {news.items && news.items.length === 0 && <div className="dtl-state">No recent news for {code}.</div>}
        {news.items && news.items.length > 0 && (
          <ul className="dtl-news-items">
            {news.items.map((n) => {
              const href = safeUrl(n.url);
              const s = sentimentOf(n.sentiment);
              const body = (
                <>
                  <span className="dtl-news-item-title">{n.title}</span>
                  <span className="dtl-news-meta">
                    <span className={`dtl-sent dtl-sent-${s}`} title={`Sentiment: ${s}`} aria-label={`Sentiment ${s}`} />
                    {n.source && <span className="dtl-news-source">{n.source}</span>}
                    <span>{formatRelative(n.publishedAt, now, tz)}</span>
                  </span>
                </>
              );
              return (
                <li key={n.id}>
                  {href ? (
                    <a className="dtl-news-item" href={href} target="_blank" rel="noopener noreferrer">{body}</a>
                  ) : (
                    <div className="dtl-news-item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
