// Finviz-style screener page (module C7). Rendered full-width below the top bar when ui.page === "screener".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenerColumnDef, ScreenerView } from "@eodview/shared";
import { useShell } from "../components/shellStore";
import { ChartsGrid } from "./ChartsGrid";
import { buildCsv, collectRows, csvFilename } from "./csv";
import { FilterChips, FilterPanel } from "./FilterPanel";
import { isUniverseBuilding } from "./format";
import { Pagination } from "./Pagination";
import { PresetBar } from "./PresetBar";
import { activeCounts, CHARTS_QUERY_VIEW, CHARTS_VIEW, filterKey, toQuery, totalPages, type ScreenerUniverse } from "./queryState";
import { ResultsTable } from "./ResultsTable";
import { errorMessage, isNoKeyError, screenerApi } from "./screenerApi";
import { useScreener } from "./screenerStore";
import { BuildBanner, StatusLine } from "./UniverseInfo";
import "./screener.css";

const UNIVERSES: { id: ScreenerUniverse; label: string }[] = [
  { id: "stocks", label: "Stocks" },
  { id: "etfs", label: "ETFs" },
  { id: "all", label: "All" },
];
const CHARTS_TAB: ScreenerView = { id: CHARTS_VIEW, label: "Charts", columns: [] };
const STATUS_POLL_MS = 10_000;

function columnDef(byId: Map<string, ScreenerColumnDef>, id: string): ScreenerColumnDef {
  return byId.get(id) ?? { id, label: id, format: "text", align: "left" };
}

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TickersInput() {
  const tickers = useScreener((s) => s.q.tickers);
  const setTickers = useScreener((s) => s.setTickers);
  return (
    <input
      className="input input-sm scr-tickers"
      value={tickers}
      placeholder="Tickers: AAPL, MSFT…"
      aria-label="Restrict to tickers"
      spellCheck={false}
      onChange={(e) => setTickers(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && tickers) {
          e.preventDefault();
          setTickers("");
        }
      }}
    />
  );
}

export function ScreenerPage() {
  const q = useScreener((s) => s.q);
  const meta = useScreener((s) => s.meta);
  const metaError = useScreener((s) => s.metaError);
  const result = useScreener((s) => s.result);
  const loading = useScreener((s) => s.loading);
  const error = useScreener((s) => s.error);
  const noKeyErr = useScreener((s) => s.noKey);
  const st = useScreener.getState();
  const config = useShell((s) => s.config);
  const noKey = config ? !config.hasKey : noKeyErr;
  const [metaTry, setMetaTry] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);

  // ---- meta + presets
  useEffect(() => {
    let alive = true;
    screenerApi
      .meta()
      .then((m) => alive && useScreener.getState().setData({ meta: m, metaError: null }))
      .catch((e) => alive && useScreener.getState().setData({ metaError: errorMessage(e), noKey: isNoKeyError(e) }));
    screenerApi
      .presets()
      .then((p) => alive && useScreener.getState().setData({ presets: Array.isArray(p) ? p : [] }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [metaTry]);

  // ---- views
  const views = useMemo<ScreenerView[]>(() => {
    const list = meta?.views ?? [];
    return list.some((v) => v.id === CHARTS_VIEW) ? list : [...list, CHARTS_TAB];
  }, [meta]);
  useEffect(() => {
    if (meta && views.length && !views.some((v) => v.id === q.view)) {
      useScreener.getState().setView(views.find((v) => v.id === "overview")?.id ?? views[0].id);
    }
  }, [meta, views, q.view]);
  const colById = useMemo(() => new Map((meta?.columns ?? []).map((c) => [c.id, c])), [meta]);
  const viewColumns = useCallback(
    (viewId: string) => {
      const id = viewId === CHARTS_VIEW ? CHARTS_QUERY_VIEW : viewId;
      const v = views.find((x) => x.id === id);
      return (v?.columns ?? []).map((c) => columnDef(colById, c));
    },
    [views, colById],
  );
  const columns = useMemo(() => viewColumns(q.view), [viewColumns, q.view]);

  // ---- query (filter edits debounced 300ms; paging/sort/view immediate)
  const fk = filterKey(q);
  const queryJson = JSON.stringify(toQuery(q));
  const lastFk = useRef<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!meta) return;
    const delay = lastFk.current !== null && lastFk.current !== fk ? 300 : 0;
    lastFk.current = fk;
    const id = ++seq.current;
    const query = JSON.parse(queryJson) as ReturnType<typeof toQuery>;
    const t = setTimeout(() => {
      const set = useScreener.getState().setData;
      set({ loading: true });
      screenerApi
        .query(query)
        .then((res) => {
          if (id !== seq.current) return;
          set({ result: { ...res, rows: Array.isArray(res.rows) ? res.rows : [], offset: query.offset }, loading: false, error: null, noKey: false });
          // filters shrank the result below the current page -> jump to the last page
          const s = useScreener.getState();
          const pages = totalPages(res.total, s.q.pageSize);
          if (res.total > 0 && s.q.page > pages) s.setPage(pages);
        })
        .catch((e) => {
          if (id !== seq.current) return;
          set({ loading: false, error: errorMessage(e), noKey: isNoKeyError(e) });
        });
    }, delay);
    return () => clearTimeout(t);
  }, [queryJson, fk, meta, refresh]);

  // ---- universe status polling while the pipeline is building
  // also poll while the universe is still empty (the pipeline may start later, e.g. after a key is added)
  const building = isUniverseBuilding(meta?.universe) || (!!meta && meta.universe.withPrices === 0);
  useEffect(() => {
    if (!building) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const u = await screenerApi.universeStatus();
        if (!alive) return;
        const prev = useScreener.getState().meta?.universe;
        useScreener.getState().setUniverseStatus(u);
        if (!prev || prev.withPrices !== u.withPrices || prev.lastPriceDate !== u.lastPriceDate || prev.withFundamentals !== u.withFundamentals) {
          setRefresh((n) => n + 1);
        }
      } catch {
        /* keep the last status; retry on the next tick */
      }
    }, STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [building]);

  // ---- CSV export
  const exportCsv = async () => {
    if (exporting) return;
    const s = useScreener.getState().q;
    const cols = viewColumns(s.view);
    setExporting("Exporting…");
    try {
      const { rows, truncated, total } = await collectRows(
        (offset, limit) => screenerApi.query(toQuery(s, { offset, limit })),
        { onProgress: (done, target) => setExporting(`Exporting ${done.toLocaleString("en-US")}/${target.toLocaleString("en-US")}…`) },
      );
      download(buildCsv(cols, rows), csvFilename(new Date(), s.view === CHARTS_VIEW ? CHARTS_QUERY_VIEW : s.view));
      if (truncated) {
        useShell.getState().pushToast({ kind: "info", title: `Exported the first ${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows` });
      }
    } catch (e) {
      useShell.getState().pushToast({ kind: "error", title: "CSV export failed", body: errorMessage(e) }, 6000);
    } finally {
      setExporting(null);
    }
  };

  const counts = useMemo(() => activeCounts(q.filters, meta?.filters ?? []), [q.filters, meta]);
  const onSort = useCallback(
    (c: ScreenerColumnDef) => useScreener.getState().toggleSort(c.id, c.align === "right" && c.format !== "text" ? "desc" : "asc"),
    [],
  );

  // ---------------- render ----------------

  const noKeyBanner = noKey && (
    <div className="scr-banner scr-banner-warn" role="alert">
      <div className="scr-banner-body">
        <b>No EODHD API key configured.</b> The screener universe can't be built or refreshed until a key is set
        {meta && meta.universe.withPrices > 0 ? " — showing previously collected data." : "."}
      </div>
      <button type="button" className="btn btn-primary scr-btn-sm" onClick={() => useShell.getState().openSettings("Add your EODHD API key to build the screener universe.")}>
        Open settings
      </button>
    </div>
  );

  if (!meta) {
    return (
      <div className="scr-page">
        {noKeyBanner}
        {metaError ? (
          <div className="scr-state">
            <p className="error-text">Couldn't load the screener: {metaError}</p>
            <button type="button" className="btn" onClick={() => setMetaTry((n) => n + 1)}>Retry</button>
          </div>
        ) : (
          <div className="scr-state"><span className="spinner" /> Loading screener…</div>
        )}
      </div>
    );
  }

  const rows = result?.rows ?? [];
  const total = result?.total ?? null;
  const universeEmpty = meta.universe.symbols === 0 || meta.universe.withPrices === 0;

  return (
    <div className="scr-page">
      {/* top row */}
      <div className="scr-toprow">
        <PresetBar />
        <button
          type="button"
          className={`btn scr-btn-sm scr-filters-toggle${q.filtersOpen ? " open" : ""}`}
          aria-expanded={q.filtersOpen}
          onClick={st.toggleFilters}
        >
          Filters{counts.all > 0 && <span className="scr-count">{counts.all}</span>}
          <span className="scr-caret" aria-hidden="true">▾</span>
        </button>
        <div className="scr-seg" role="radiogroup" aria-label="Universe">
          {UNIVERSES.map((u) => (
            <button
              key={u.id}
              type="button"
              role="radio"
              aria-checked={q.universe === u.id}
              className={q.universe === u.id ? "active" : ""}
              onClick={() => st.setUniverse(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>
        <TickersInput />
        <button type="button" className="btn scr-btn-sm" onClick={st.reset} disabled={q.filters.length === 0 && !q.tickers.trim()}>
          Reset
        </button>
      </div>

      {q.filtersOpen && <FilterPanel />}
      <FilterChips />

      {noKeyBanner}
      <BuildBanner universe={meta.universe} />

      <StatusLine
        total={total}
        offset={result?.offset ?? 0}
        rows={rows.length}
        asOf={result?.asOf ?? null}
        universe={meta.universe}
        loading={loading}
      />

      {/* view tabs */}
      <div className="scr-vtabs">
        <div className="scr-vtabs-list" role="tablist" aria-label="View">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={q.view === v.id}
              className={`scr-vtab${q.view === v.id ? " active" : ""}`}
              onClick={() => st.setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn scr-btn-sm" onClick={exportCsv} disabled={!!exporting || !total} title="Download the current results as CSV (up to 5,000 rows)">
          {exporting ?? "Export CSV"}
        </button>
      </div>

      {/* results */}
      {error ? (
        <div className="scr-state">
          <p className="error-text">Query failed: {error}</p>
          <button type="button" className="btn" onClick={() => setRefresh((n) => n + 1)}>Retry</button>
        </div>
      ) : !result ? (
        <div className="scr-state"><span className="spinner" /> Loading results…</div>
      ) : rows.length === 0 ? (
        <div className="scr-state">
          {universeEmpty ? (
            <p>The universe has no price data yet{isUniverseBuilding(meta.universe) ? " — it is being built; results appear automatically." : "."}</p>
          ) : (
            <>
              <p>No matches for the current filters.</p>
              {(q.filters.length > 0 || q.tickers.trim()) && <button type="button" className="btn" onClick={st.reset}>Reset filters</button>}
            </>
          )}
        </div>
      ) : q.view === CHARTS_VIEW ? (
        <ChartsGrid rows={rows} loading={loading} />
      ) : (
        <ResultsTable columns={columns} rows={rows} offset={result.offset} sort={q.sort} onSort={onSort} loading={loading} />
      )}

      {result && result.total > 0 && (
        <Pagination total={result.total} page={q.page} pageSize={q.pageSize} onPage={st.setPage} onPageSize={st.setPageSize} />
      )}
    </div>
  );
}
