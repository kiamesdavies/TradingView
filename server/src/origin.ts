// Cross-site request protection for /ws upgrades and state-changing /api requests (pure; see origin.test.ts).
//
// Browsers do not apply CORS to WebSockets, and a cross-site `fetch(..., {method: "POST", mode: "no-cors"})`
// with a text/plain body is sent without a preflight. Both always carry an `Origin` header, so rejecting
// foreign origins closes them. Requests without `Origin` come from non-browser clients (CLI, curl) and pass,
// unless `Sec-Fetch-Site` says a browser sent them cross-site.

function hostOf(hostPort: string): string {
  const h = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":")[0]!;
  return h.toLowerCase();
}

function isLoopbackName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

/** Parse EODVIEW_ALLOWED_ORIGINS (comma separated, e.g. "http://mybox.lan:3001"). */
export function parseAllowedOrigins(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

export interface OriginInput {
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
  allowed: readonly string[];
}

/**
 * true when the request may proceed:
 * - no Origin (non-browser client), unless Sec-Fetch-Site is "cross-site"
 * - Origin equal to the server's own origin (same Host header)
 * - any loopback Origin (the Vite dev server on :5173, other local ports)
 * - an Origin listed in EODVIEW_ALLOWED_ORIGINS
 */
export function isAllowedOrigin(g: OriginInput): boolean {
  if (!g.origin) return g.secFetchSite?.toLowerCase() !== "cross-site";
  let url: URL;
  try {
    url = new URL(g.origin);
  } catch {
    return false; // "null" (sandboxed iframes, file://) or garbage
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const normalized = url.origin.toLowerCase();
  if (g.allowed.includes(normalized)) return true;
  if (isLoopbackName(hostOf(url.host))) return true;
  return g.host !== null && url.host.toLowerCase() === g.host.toLowerCase();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Only state-changing methods need the check on REST routes (cross-origin reads are already blocked by CORS). */
export function needsOriginCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function originInputFrom(req: Request, allowed: readonly string[]): OriginInput {
  return {
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    allowed,
  };
}
