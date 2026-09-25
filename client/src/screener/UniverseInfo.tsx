import type { ReactNode } from "react";
import type { UniverseStatus } from "@eodview/shared";
import { formatInt, fundamentalsTotal, isUniverseBuilding, resultRangeText } from "./format";

/** "Total: 1,234 • #1–20 • Prices as of … • Universe: 11,020 symbols, fundamentals 4,210/6,031" */
export function StatusLine({ total, offset, rows, asOf, universe, loading }: {
  total: number | null;
  offset: number;
  rows: number;
  asOf: string | null;
  universe: UniverseStatus | null;
  loading: boolean;
}) {
  const fTotal = universe ? fundamentalsTotal(universe) : null;
  const errored = universe?.jobs.filter((j) => j.state === "error") ?? [];
  const parts: ReactNode[] = [];
  if (total !== null) {
    parts.push(<span key="t">Total: <b className="scr-strong">{formatInt(total)}</b></span>);
    parts.push(<span key="r">{resultRangeText(total, offset, rows)}</span>);
  }
  const priceDate = asOf ?? universe?.lastPriceDate ?? null;
  if (priceDate) parts.push(<span key="p">Prices as of {priceDate}</span>);
  if (universe) {
    parts.push(
      <span key="u">
        Universe: {formatInt(universe.symbols)} symbols, fundamentals {formatInt(universe.withFundamentals)}
        {fTotal ? `/${formatInt(fTotal)}` : ""}
      </span>,
    );
  }
  if (errored.length) {
    parts.push(
      <span key="e" className="warn" title={errored.map((j) => `${j.name}: ${j.lastError ?? "error"}`).join("\n")}>
        {errored.length} job error{errored.length > 1 ? "s" : ""}
      </span>,
    );
  }
  return (
    <div className="scr-status" aria-live="polite">
      {loading && <span className="spinner" />}
      {parts.map((p, i) => (
        <span key={i} className="scr-status-part">
          {i > 0 && <span className="scr-dot">•</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/** Progress banner shown while the universe pipeline is still building. */
export function BuildBanner({ universe }: { universe: UniverseStatus }) {
  if (!isUniverseBuilding(universe)) return null;
  const running = universe.jobs.filter((j) => j.state === "running");
  const errored = universe.jobs.filter((j) => j.state === "error");
  const pct = universe.symbols > 0 ? Math.round((universe.withPrices / universe.symbols) * 100) : 0;
  return (
    <div className="scr-banner" role="status">
      <span className="spinner" />
      <div className="scr-banner-body">
        <div>
          <b>Building the screener universe…</b> Prices for {formatInt(universe.withPrices)} of {formatInt(universe.symbols)} symbols
          {universe.historyDays > 0 && <> · {formatInt(universe.historyDays)} days of history</>}. Results fill in as data arrives.
        </div>
        <div className="scr-banner-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
        <div className="scr-banner-jobs muted">
          {running.map((j) => (
            <span key={j.name} className="scr-job">{j.name}{j.progress ? ` ${j.progress}` : ""}</span>
          ))}
          {errored.map((j) => (
            <span key={j.name} className="scr-job warn" title={j.lastError ?? ""}>{j.name}: error</span>
          ))}
          <span className="scr-job">API credits today {formatInt(universe.creditsUsedToday)} / {formatInt(universe.dailyCreditBudget)}</span>
        </div>
      </div>
    </div>
  );
}
