// /api/tokens calls (agent API tokens). Config-guarded like /api/config: localhost, or `Authorization: Bearer
// <EODVIEW_ADMIN_TOKEN>` when the server sets one. Used by the Settings dialog's "API access" section.
import type { ApiError, ApiTokenView } from "@eodview/shared";
import { ApiRequestError } from "../api/http";

export type CreatedToken = ApiTokenView & { token: string };

async function tokenRequest<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, adminToken?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const res = await fetch(`/api/tokens${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(res.status, err.error ?? res.statusText, err.detail);
  }
  return data as T;
}

export const tokensApi = {
  list: (adminToken?: string) => tokenRequest<ApiTokenView[]>("GET", "", undefined, adminToken),
  create: (name: string, adminToken?: string) => tokenRequest<CreatedToken>("POST", "", { name }, adminToken),
  revoke: (id: string, adminToken?: string) => tokenRequest<{ ok: true }>("DELETE", `/${encodeURIComponent(id)}`, undefined, adminToken),
};

/** Copy text to the clipboard; falls back to a hidden textarea when the async API is unavailable (http non-localhost). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
