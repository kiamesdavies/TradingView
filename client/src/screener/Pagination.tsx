import { formatInt } from "./format";
import { PAGE_SIZES, pageItems, totalPages, type PageSize } from "./queryState";

export function Pagination({ total, page, pageSize, onPage, onPageSize }: {
  total: number;
  page: number;
  pageSize: PageSize;
  onPage: (p: number) => void;
  onPageSize: (n: PageSize) => void;
}) {
  const pages = totalPages(total, pageSize);
  const items = pageItems(page, pages);
  return (
    <nav className="scr-pager" aria-label="Pages">
      <span className="muted">Total: <b className="scr-strong">{formatInt(total)}</b></span>
      <div className="scr-pages">
        <button type="button" className="scr-pg" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
        {items.map((it, i) =>
          it === "gap" ? (
            <span key={`g${i}`} className="scr-pg-gap">…</span>
          ) : (
            <button
              key={it}
              type="button"
              className={`scr-pg${it === page ? " active" : ""}`}
              aria-current={it === page ? "page" : undefined}
              onClick={() => onPage(it)}
            >
              {it}
            </button>
          ),
        )}
        <button type="button" className="scr-pg" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
      </div>
      <label className="scr-pagesize">
        <span className="muted">Rows</span>
        <select className="scr-select" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value) as PageSize)}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
    </nav>
  );
}
