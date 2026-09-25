// Access control for the config endpoints (pure; see guard.test.ts).
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../http";

const LOOPBACK_IPS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Headers a reverse proxy (nginx, Apache, Caddy, Traefik, Vite with xfwd…) adds. A request carrying any of them
 * was relayed, so its loopback source IP says nothing about the real client.
 */
export const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "via"] as const;

/** True when the request carries a proxy header (see PROXY_HEADERS). */
export function isProxied(headers: Pick<Headers, "has">): boolean {
  return PROXY_HEADERS.some((h) => headers.has(h));
}

function isLoopbackHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  // Strip the port; IPv6 hosts come bracketed ("[::1]:3001").
  const host = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface GuardInput {
  adminToken: string | undefined;
  authorization: string | null;
  ip: string | null | undefined;
  host: string | null;
  /** The request carries a proxy header (Forwarded, X-Forwarded-For, …): never treated as loopback. */
  proxied?: boolean;
}

/**
 * Throws HttpError unless the caller may use the config endpoints.
 * In loopback mode the Host header must also be a loopback name, which blocks DNS-rebinding pages
 * that would otherwise reach the server from the user's own browser with a loopback source IP. Requests relayed by
 * a proxy (see PROXY_HEADERS) are never loopback: a same-host nginx rewrites Host to "127.0.0.1:3001" by default.
 */
export function assertConfigAccess(g: GuardInput): void {
  if (g.adminToken) {
    const m = /^Bearer\s+(.+)$/i.exec(g.authorization ?? "");
    if (!m || !safeEqual(m[1].trim(), g.adminToken)) throw new HttpError(401, "admin token required");
    return;
  }
  if (g.proxied || !g.ip || !LOOPBACK_IPS.has(g.ip) || !isLoopbackHost(g.host)) {
    throw new HttpError(403, "config endpoints are only available from localhost (set EODVIEW_ADMIN_TOKEN for remote access)");
  }
}
