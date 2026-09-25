// Agent API errors: HttpError plus an optional `detail` and extra response headers.
import { HttpError, json } from "../http";

export class AgentError extends HttpError {
  constructor(status: number, message: string, public detail?: string, public headers: Record<string, string> = {}) {
    super(status, message);
  }
}

export function badRequest(msg: string, detail?: string): never {
  throw new AgentError(400, msg, detail);
}

/** Error → `{error, detail}` JSON response (status from HttpError / upstream `status`, else 500). */
export function errorResponse(e: unknown): Response {
  if (e instanceof AgentError) {
    const r = json({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) }, e.status);
    for (const [k, v] of Object.entries(e.headers)) r.headers.set(k, v);
    return r;
  }
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  const s = (e as { status?: unknown })?.status;
  const status = typeof s === "number" && s >= 400 && s < 600 ? s : 500;
  const message = (e as Error)?.message || "error";
  if (status === 500) {
    console.error("[agentapi]", e);
    return json({ error: "internal error", detail: message }, 500);
  }
  return json({ error: message }, status);
}
