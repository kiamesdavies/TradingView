import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AssetClass, SymbolInfo } from "@eodview/shared";
import { api } from "../api/http";
import { useStore } from "../state/store";
import { splitSymbol } from "./format";
import { Modal } from "./Modal";
import { SearchIcon } from "./icons";
import { useShell } from "./shellStore";

const DEBOUNCE_MS = 250;

interface Row {
  symbol: string;
  code: string;
  exchange: string;
  name: string;
  badge: string;
  badgeClass: string;
  info?: SymbolInfo;
}

const CLASS_BADGE: Record<AssetClass, string> = {
  us_stock: "stock", stock: "stock", etf: "etf", forex: "forex", crypto: "crypto", index: "index", other: "other",
};

function toRow(info: SymbolInfo): Row {
  const badge = info.assetClass === "other" && info.type ? info.type.toLowerCase() : CLASS_BADGE[info.assetClass] ?? "other";
  return {
    symbol: info.symbol,
    code: info.code,
    exchange: info.exchange,
    name: info.name,
    badge,
    badgeClass: CLASS_BADGE[info.assetClass] ?? "other",
    info,
  };
}

function recentRow(symbol: string): Row {
  const { code, exchange } = splitSymbol(symbol);
  return { symbol, code, exchange, name: "Recent", badge: "recent", badgeClass: "recent" };
}

/** Fallback SymbolInfo for a picked recent symbol (no server round-trip). */
function rowInfo(r: Row): SymbolInfo {
  if (r.info) return r.info;
  const ex = r.exchange.toUpperCase();
  const assetClass: AssetClass = ex === "US" ? "us_stock" : ex === "FOREX" ? "forex" : ex === "CC" ? "crypto" : ex === "INDX" ? "index" : "stock";
  return { symbol: r.symbol, code: r.code, exchange: r.exchange, name: r.code, type: "", assetClass, streamable: ex === "US" || ex === "FOREX" || ex === "CC" };
}

export function SymbolSearch() {
  const open = useStore((s) => s.ui.searchOpen);
  if (!open) return null;
  return <SymbolSearchDialog />;
}

function SymbolSearchDialog() {
  const seed = useShell((s) => s.searchSeed);
  const title = useShell((s) => s.searchTitle);
  const recent = useStore((s) => s.layout.recentSymbols);
  const [query, setQuery] = useState(seed);
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  useEffect(() => {
    if (!q) {
      setResults([]);
      setLoading(false);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<SymbolInfo[]>(`/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (cancelled) return;
          setResults(Array.isArray(r) ? r : []);
          setErr(null);
        })
        .catch((e: Error) => {
          if (!cancelled) {
            setResults([]);
            setErr(e.message);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const rows: Row[] = useMemo(() => {
    if (!q) return recent.map(recentRow);
    const list = results.map(toRow);
    // Allow jumping straight to a fully-qualified symbol the search API did not return.
    if (/^[A-Z0-9^][A-Z0-9._^-]*\.[A-Z]{1,6}$/i.test(q) && !list.some((r) => r.symbol.toUpperCase() === q.toUpperCase())) {
      const { code, exchange } = splitSymbol(q.toUpperCase());
      list.push({ symbol: q.toUpperCase(), code, exchange, name: "Open this symbol", badge: "direct", badgeClass: "recent" });
    }
    return list;
  }, [q, results, recent]);

  useEffect(() => setActive(0), [rows]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (r: Row) => {
    const shell = useShell.getState();
    const handler = shell.searchPick;
    shell.closeSearch();
    if (handler) handler(rowInfo(r));
    else useStore.getState().setSymbol(r.symbol);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[active];
      if (r) pick(r);
    }
  };

  const close = () => useShell.getState().closeSearch();

  return (
    <Modal title={title ?? "Symbol search"} onClose={close} width={620} className="search-modal" top>
      <div className="search-input-wrap">
        <SearchIcon />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          placeholder="Search e.g. AAPL, EURUSD, BTC-USD"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Symbol"
          aria-controls="symbol-search-list"
          aria-activedescendant={rows[active] ? `sym-opt-${active}` : undefined}
        />
        {loading && <span className="spinner" aria-label="Loading" />}
      </div>
      <ul className="search-list" id="symbol-search-list" role="listbox" ref={listRef}>
        {!q && rows.length === 0 && <li className="search-empty">Type to search symbols. Recent symbols appear here.</li>}
        {q && !loading && !err && rows.length === 0 && <li className="search-empty">No symbols match “{q}”.</li>}
        {err && <li className="search-empty error-text">Search failed: {err}</li>}
        {!q && rows.length > 0 && <li className="search-section">Recent</li>}
        {rows.map((r, i) => (
          <li
            key={`${r.symbol}-${i}`}
            id={`sym-opt-${i}`}
            data-idx={i}
            role="option"
            aria-selected={i === active}
            className={`search-row${i === active ? " active" : ""}`}
            onMouseMove={() => i !== active && setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(r)}
          >
            <span className="search-code">{r.code}</span>
            <span className="search-name" title={r.name}>{r.name}</span>
            <span className={`badge badge-${r.badgeClass}`}>{r.badge}</span>
            <span className="search-exchange">{r.exchange}</span>
          </li>
        ))}
      </ul>
      <div className="search-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> select</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </Modal>
  );
}
