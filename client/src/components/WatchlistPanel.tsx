import { memo, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { Symbol, SymbolInfo, Watchlist } from "@eodview/shared";
import { api } from "../api/http";
import { useStore } from "../state/store";
import { direction, formatChange, formatPct, formatPrice, formatVolume, moveItem, splitSymbol } from "./format";
import { CloseIcon, GripIcon, PencilIcon, PlusIcon, TrashIcon } from "./icons";
import { useShell } from "./shellStore";
import { useLiveQuotes } from "./useLiveQuotes";

function toastError(title: string, e: unknown) {
  useShell.getState().pushToast({ kind: "error", title, body: e instanceof Error ? e.message : String(e) });
}

/** Optimistically replace a list, PUT it, and roll back on failure. */
async function saveList(next: Watchlist): Promise<void> {
  const { watchlists, setWatchlists } = useStore.getState();
  const prev = watchlists.find((w) => w.id === next.id);
  setWatchlists(watchlists.map((w) => (w.id === next.id ? next : w)));
  try {
    const saved = await api.put<Watchlist>(`/watchlists/${encodeURIComponent(next.id)}`, next);
    if (saved && saved.id) {
      const cur = useStore.getState().watchlists;
      useStore.getState().setWatchlists(cur.map((w) => (w.id === saved.id ? saved : w)));
    }
  } catch (e) {
    if (prev) {
      const cur = useStore.getState().watchlists;
      useStore.getState().setWatchlists(cur.map((w) => (w.id === prev.id ? prev : w)));
    }
    toastError("Watchlist not saved", e);
  }
}

function currentList(): Watchlist | undefined {
  const { watchlists, layout } = useStore.getState();
  return watchlists.find((w) => w.id === layout.activeWatchlistId) ?? watchlists[0];
}

export function addSymbolToActiveList(symbol: Symbol): void {
  const list = currentList();
  if (!list) return;
  if (list.symbols.includes(symbol)) {
    useShell.getState().pushToast({ kind: "info", title: `${symbol} is already in “${list.name}”` });
    return;
  }
  void saveList({ ...list, symbols: [...list.symbols, symbol] });
}

type EditMode = { kind: "create" | "rename"; value: string } | null;

export function WatchlistPanel() {
  const watchlists = useStore((s) => s.watchlists);
  const activeId = useStore((s) => s.layout.activeWatchlistId);
  const currentSymbol = useStore((s) => s.layout.symbol);
  const setLayout = useStore((s) => s.setLayout);
  const active = watchlists.find((w) => w.id === activeId) ?? watchlists[0];
  const [edit, setEdit] = useState<EditMode>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  useLiveQuotes(active?.symbols ?? []);

  const openAdd = () => {
    if (!active) return;
    useShell.getState().openSearch({
      title: `Add symbol to “${active.name}”`,
      onPick: (info: SymbolInfo) => addSymbolToActiveList(info.symbol),
    });
  };

  const submitEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const name = edit.value.trim();
    if (!name) return;
    setEdit(null);
    if (edit.kind === "create") {
      try {
        const created = await api.post<Watchlist>("/watchlists", { name });
        useStore.getState().setWatchlists([...useStore.getState().watchlists, created]);
        setLayout({ activeWatchlistId: created.id });
      } catch (err) {
        toastError("Could not create watchlist", err);
      }
    } else if (active && name !== active.name) {
      await saveList({ ...active, name });
    }
  };

  const deleteList = async () => {
    if (!active) return;
    if (!window.confirm(`Delete watchlist “${active.name}” (${active.symbols.length} symbols)?`)) return;
    try {
      await api.del<{ ok: true }>(`/watchlists/${encodeURIComponent(active.id)}`);
      const rest = useStore.getState().watchlists.filter((w) => w.id !== active.id);
      useStore.getState().setWatchlists(rest);
      setLayout({ activeWatchlistId: rest[0]?.id });
    } catch (err) {
      toastError("Could not delete watchlist", err);
    }
  };

  const removeSymbol = (symbol: Symbol) => {
    if (!active) return;
    void saveList({ ...active, symbols: active.symbols.filter((s) => s !== symbol) });
  };

  const onDrop = (to: number) => {
    if (active && dragFrom !== null && dragFrom !== to) {
      void saveList({ ...active, symbols: moveItem(active.symbols, dragFrom, to) });
    }
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <div className="panel watchlist-panel">
      <div className="panel-head">
        {edit ? (
          <form className="wl-edit" onSubmit={submitEdit}>
            <input
              autoFocus
              className="input input-sm"
              value={edit.value}
              placeholder={edit.kind === "create" ? "New list name" : "List name"}
              maxLength={60}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setEdit(null);
                }
              }}
              onBlur={() => setEdit(null)}
            />
          </form>
        ) : (
          <select
            className="input input-sm wl-select"
            value={active?.id ?? ""}
            onChange={(e) => setLayout({ activeWatchlistId: e.target.value })}
            aria-label="Watchlist"
            disabled={!watchlists.length}
          >
            {!watchlists.length && <option value="">No watchlists</option>}
            {watchlists.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.symbols.length})
              </option>
            ))}
          </select>
        )}
        <div className="panel-actions">
          <button type="button" className="icon-btn" onClick={openAdd} disabled={!active} title="Add symbol">
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEdit({ kind: "create", value: "" })}
            title="New watchlist"
          >
            <span className="icon-text">New</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => active && setEdit({ kind: "rename", value: active.name })}
            disabled={!active}
            title="Rename watchlist"
          >
            <PencilIcon />
          </button>
          <button type="button" className="icon-btn danger" onClick={deleteList} disabled={!active} title="Delete watchlist">
            <TrashIcon />
          </button>
        </div>
      </div>

      <div className="wl-table" role="table" aria-label="Watchlist">
        <div className="wl-row wl-header" role="row">
          <span role="columnheader">Symbol</span>
          <span role="columnheader" className="num">Last</span>
          <span role="columnheader" className="num">Chg</span>
          <span role="columnheader" className="num">Chg%</span>
          <span role="columnheader" className="num">Vol</span>
        </div>
        <div className="wl-body" onDragLeave={(e) => e.currentTarget === e.target && setDragOver(null)}>
          {!active && (
            <div className="empty">
              <p>No watchlists yet.</p>
              <button type="button" className="btn" onClick={() => setEdit({ kind: "create", value: "" })}>Create a watchlist</button>
            </div>
          )}
          {active && active.symbols.length === 0 && (
            <div className="empty">
              <p>This list is empty.</p>
              <button type="button" className="btn" onClick={openAdd}>Add symbol</button>
            </div>
          )}
          {active?.symbols.map((sym, i) => (
            <WatchRow
              key={sym}
              symbol={sym}
              index={i}
              selected={sym === currentSymbol}
              dropIndicator={dragOver === i && dragFrom !== null && dragFrom !== i ? (dragFrom < i ? "below" : "above") : null}
              dragging={dragFrom === i}
              onRemove={removeSymbol}
              onDragStart={setDragFrom}
              onDragOverRow={setDragOver}
              onDropRow={onDrop}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface WatchRowProps {
  symbol: Symbol;
  index: number;
  selected: boolean;
  dragging: boolean;
  dropIndicator: "above" | "below" | null;
  onRemove(symbol: Symbol): void;
  onDragStart(index: number): void;
  onDragOverRow(index: number): void;
  onDropRow(index: number): void;
  onDragEnd(): void;
}

const WatchRow = memo(function WatchRow(p: WatchRowProps) {
  const q = useStore((s) => s.quotes[p.symbol]);
  const { code, exchange } = splitSymbol(p.symbol);
  const dir = direction(q?.change);
  const flash = usePriceFlash(q?.price);

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", p.symbol);
    p.onDragStart(p.index);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    p.onDragOverRow(p.index);
  };

  return (
    <div
      role="row"
      className={[
        "wl-row",
        p.selected && "selected",
        p.dragging && "dragging",
        p.dropIndicator && `drop-${p.dropIndicator}`,
      ].filter(Boolean).join(" ")}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        p.onDropRow(p.index);
      }}
      onDragEnd={p.onDragEnd}
      onClick={() => useStore.getState().setSymbol(p.symbol)}
      title={p.symbol}
    >
      <span className="wl-sym" role="cell">
        <span className="grip" aria-hidden="true"><GripIcon /></span>
        <span className="wl-code">{code}</span>
        <span className="wl-ex">{exchange}</span>
      </span>
      <span role="cell" className={`num wl-last${flash ? ` flash-${flash}` : ""}`}>{formatPrice(q?.price, p.symbol)}</span>
      <span role="cell" className={`num ${dir}`}>{formatChange(q?.change, p.symbol, q?.price)}</span>
      <span role="cell" className={`num ${dir}`}>{formatPct(q?.changePct)}</span>
      <span role="cell" className="num wl-vol">{formatVolume(q?.volume)}</span>
      <button
        type="button"
        className="wl-remove"
        title={`Remove ${p.symbol}`}
        aria-label={`Remove ${p.symbol}`}
        onClick={(e) => {
          e.stopPropagation();
          p.onRemove(p.symbol);
        }}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
});

/** Returns "up"/"down" briefly after the price changes. */
function usePriceFlash(price: number | undefined): "up" | "down" | null {
  const prev = useRef(price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = price;
    if (before === undefined || price === undefined || before === price) return;
    setFlash(price > before ? "up" : "down");
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [price]);
  return flash;
}
