// Company logo proxy with an on-disk cache: DATA_DIR/logos/<SYMBOL>.img + <SYMBOL>.json (meta).
// Positive results are kept 30 days, "no logo" results 1 day. Upstream: https://eodhd.com/img/logos/<EX>/<CODE>.png
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOGO_BASE = "https://eodhd.com";
export const LOGO_TTL_SEC = 30 * 86400;
export const LOGO_MISS_TTL_SEC = 86400;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

export type LogoResult = { found: true; body: Uint8Array; contentType: string } | { found: false };

interface Meta { fetchedAt: number; contentType?: string; missing?: boolean }

export interface LogoStoreDeps {
  dir: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Unix seconds. */
  now?: () => number;
}

/** Upstream paths to try, in order. EODHD's file names are case-sensitive and inconsistent (US: lower case). */
export function logoCandidates(code: string, exchange: string, hint?: string | null): string[] {
  const out: string[] = [];
  if (hint && /^\/img\/logos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|svg|webp)$/i.test(hint)) out.push(hint);
  const ex = exchange.toUpperCase();
  const safe = code.replace(/[^A-Za-z0-9._-]/g, "");
  if (safe) {
    out.push(`/img/logos/${ex}/${safe.toLowerCase()}.png`, `/img/logos/${ex}/${safe.toUpperCase()}.png`);
  }
  return [...new Set(out)];
}

const fileBase = (symbol: string): string => symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, "_");

export function createLogoStore(deps: LogoStoreDeps) {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const inflight = new Map<string, Promise<LogoResult>>();
  let dirReady: Promise<unknown> | null = null;

  const paths = (symbol: string) => {
    const base = join(deps.dir, fileBase(symbol));
    return { img: `${base}.img`, meta: `${base}.json` };
  };

  async function readCached(symbol: string): Promise<LogoResult | null> {
    const p = paths(symbol);
    let meta: Meta;
    try {
      meta = JSON.parse(await readFile(p.meta, "utf8")) as Meta;
    } catch {
      return null;
    }
    const age = now() - meta.fetchedAt;
    if (meta.missing) return age < LOGO_MISS_TTL_SEC ? { found: false } : null;
    if (age >= LOGO_TTL_SEC || !meta.contentType) return null;
    try {
      return { found: true, body: new Uint8Array(await readFile(p.img)), contentType: meta.contentType };
    } catch {
      return null;
    }
  }

  async function write(symbol: string, res: LogoResult): Promise<void> {
    dirReady ??= mkdir(deps.dir, { recursive: true });
    await dirReady;
    const p = paths(symbol);
    if (res.found) {
      await writeFile(p.img, res.body);
      await writeFile(p.meta, JSON.stringify({ fetchedAt: now(), contentType: res.contentType } satisfies Meta));
    } else {
      await writeFile(p.meta, JSON.stringify({ fetchedAt: now(), missing: true } satisfies Meta));
    }
  }

  /** Returns "found", a definitive "not found" (cached a day), or throws on network/upstream trouble (not cached). */
  async function download(candidates: string[]): Promise<LogoResult> {
    let transient: Error | null = null;
    for (const path of candidates) {
      let res: Response;
      try {
        res = await fetchFn(`${LOGO_BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
      } catch (e) {
        transient = e as Error;
        continue;
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (res.ok && type.startsWith("image/")) {
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.byteLength > 0 && body.byteLength <= MAX_BYTES) return { found: true, body, contentType: type };
        continue;
      }
      await res.body?.cancel().catch(() => {});
      if (res.status >= 500 || res.status === 429) transient = new Error(`logo upstream ${res.status}`);
    }
    if (transient) throw transient;
    return { found: false };
  }

  return {
    async get(symbol: string, code: string, exchange: string, hint?: string | null): Promise<LogoResult> {
      const cached = await readCached(symbol);
      if (cached) return cached;
      const pending = inflight.get(symbol);
      if (pending) return pending;
      const p = (async () => {
        const res = await download(logoCandidates(code, exchange, hint));
        await write(symbol, res).catch((e) => console.warn(`[logo] cache write failed for ${symbol}: ${(e as Error).message}`));
        return res;
      })().finally(() => inflight.delete(symbol));
      inflight.set(symbol, p);
      return p;
    },
  };
}

export type LogoStore = ReturnType<typeof createLogoStore>;
