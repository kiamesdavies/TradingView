// /api/config calls. Separate from api/http.ts because they may need `Authorization: Bearer <EODVIEW_ADMIN_TOKEN>`.
import type { ApiError, ConfigUpdate, ConfigView } from "@eodview/shared";
import { ApiRequestError } from "../api/http";

async function configRequest(method: "GET" | "PUT", body?: ConfigUpdate, adminToken?: string): Promise<ConfigView> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const res = await fetch("/api/config", { method, headers, body: body ? JSON.stringify(body) : undefined });
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
  return data as ConfigView;
}

export const configApi = {
  get: (adminToken?: string) => configRequest("GET", undefined, adminToken),
  setKey: (apiKey: string, adminToken?: string) => configRequest("PUT", { apiKey }, adminToken),
};
