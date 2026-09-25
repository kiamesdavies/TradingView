// Minimal router for Bun.serve. Modules call register(router) to add their routes.
export type Params = Record<string, string>;
export type Handler = (req: Request, params: Params, url: URL, server: import("bun").Server) => Response | Promise<Response>;

type Method = "GET" | "POST" | "PUT" | "DELETE";
interface Route { method: Method; parts: string[]; handler: Handler }

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function error(status: number, message: string, detail?: string): Response {
  return json({ error: message, ...(detail ? { detail } : {}) }, status);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class Router {
  private routes: Route[] = [];

  private add(method: Method, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
  }
  get(path: string, h: Handler) { this.add("GET", path, h); }
  post(path: string, h: Handler) { this.add("POST", path, h); }
  put(path: string, h: Handler) { this.add("PUT", path, h); }
  delete(path: string, h: Handler) { this.add("DELETE", path, h); }

  async handle(req: Request, server: import("bun").Server): Promise<Response | null> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== req.method || r.parts.length !== parts.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      try {
        return await r.handler(req, params, url, server);
      } catch (e) {
        if (e instanceof HttpError) return error(e.status, e.message);
        const status = typeof (e as any)?.status === "number" ? (e as any).status : 500;
        console.error(`[http] ${req.method} ${url.pathname}`, e);
        return error(status >= 400 && status < 600 ? status : 500, (e as Error).message ?? "internal error");
      }
    }
    return null;
  }
}
