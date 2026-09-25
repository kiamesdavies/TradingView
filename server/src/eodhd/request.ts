// Low-level EODHD REST access: URL building, error mapping, in-flight de-duplication.
// Has no dependency on the config module so config can use it to validate keys.
import { HttpError } from "../http";

export const EODHD_BASE = "https://eodhd.com/api";
const TIMEOUT_MS = 20_000;

export type EodhdErrorCode =
  | "no_key"
  | "unauthorized"
  | "plan"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "upstream"
  | "network";

/**
 * Error thrown by every EODHD call. `status` is the HTTP status our own API should answer with
 * (the router forwards `status` automatically); `upstreamStatus` is what EODHD returned, if anything.
 * Messages never contain the API key or the request URL. Extends HttpError so the router answers
 * with `status`/`message` without logging a stack trace for expected upstream failures.
 */
export class EodhdError extends HttpError {
  constructor(
    status: number,
    message: string,
    public code: EodhdErrorCode,
    public upstreamStatus?: number,
  ) {
    super(status, message);
    this.name = "EodhdError";
  }
}

export const noKeyError = (): EodhdError => new EodhdError(503, "EODHD API key not configured", "no_key");

/** Map an upstream HTTP failure to an EodhdError with a clear, key-free message. */
export function mapHttpError(upstreamStatus: number, body: string, what: string): EodhdError {
  const hint = body.trim().slice(0, 160);
  switch (upstreamStatus) {
    case 401:
    case 403:
      return new EodhdError(502, "EODHD rejected the API key", "unauthorized", upstreamStatus);
    case 402:
      return new EodhdError(402, `Your EODHD plan does not include this data (${what})`, "plan", upstreamStatus);
    case 429:
      return new EodhdError(429, "EODHD rate limit reached; try again later", "rate_limited", upstreamStatus);
    case 404:
      return new EodhdError(404, `EODHD has no data for ${what}${hint ? `: ${hint}` : ""}`, "not_found", upstreamStatus);
    case 400:
    case 422:
      return new EodhdError(400, `EODHD rejected the request for ${what}${hint ? `: ${hint}` : ""}`, "bad_request", upstreamStatus);
    default:
      return new EodhdError(502, `EODHD error ${upstreamStatus} for ${what}`, "upstream", upstreamStatus);
  }
}

export type QueryValue = string | number | undefined;
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Path (already URL-encoded per segment) + params, without the token. Used as the de-dupe key. */
export function requestKey(path: string, params: Record<string, QueryValue>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${path}?${qs}` : path;
}

/** Perform one GET against EODHD and return parsed JSON. Throws EodhdError. */
export async function eodhdGet(
  path: string,
  params: Record<string, QueryValue>,
  key: string,
  what: string,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  // `path` never carries its own query string; the token is only ever placed in this local URL.
  const url = `${EODHD_BASE}${requestKey(path, { ...params, fmt: "json", api_token: key })}`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
    throw new EodhdError(
      timedOut ? 504 : 502,
      timedOut ? `EODHD did not respond in time (${what})` : `Could not reach EODHD (${what})`,
      "network",
    );
  }
  const text = await res.text();
  if (!res.ok) throw mapHttpError(res.status, text, what);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // EODHD answers some failures with a 200 + plain-text body.
    if (/unauthenticated|invalid api token/i.test(text)) throw mapHttpError(401, text, what);
    throw new EodhdError(502, `EODHD returned a non-JSON response for ${what}`, "upstream", res.status);
  }
}

/** Shares one promise between identical concurrent requests. */
export class InFlight {
  private pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  get size(): number {
    return this.pending.size;
  }
}
