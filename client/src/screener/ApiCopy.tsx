// "Copy as API" / "Copy MCP call" buttons: hand the current screen to an agent.
import { useShell } from "../components/shellStore";
import { buildScreenLink, isLoopbackHost, mcpArgsText, serverOrigin } from "./apiLinks";
import { toQuery } from "./queryState";
import { useScreener } from "./screenerStore";
import { copyText } from "./tokensApi";

function currentQuery() {
  const s = useScreener.getState();
  // agents get the first page at the current page size; unavailable filters are left out like in the UI query
  return { query: toQuery(s.q, { offset: 0 }, s.meta?.filters), defs: s.meta?.filters ?? [] };
}

function origin(): string {
  return serverOrigin(window.location, useShell.getState().config?.port);
}

async function copy(text: string, title: string, body?: string) {
  const ok = await copyText(text);
  useShell.getState().pushToast(
    ok ? { kind: "success", title, body } : { kind: "error", title: "Copy failed", body: text.slice(0, 300) },
    ok ? 5000 : 10000,
  );
}

export function ApiCopyButtons({ disabled }: { disabled?: boolean }) {
  const withToken = typeof window !== "undefined" && !isLoopbackHost(window.location.hostname);
  const copyApi = () => {
    const { query, defs } = currentQuery();
    const link = buildScreenLink(origin(), query, defs, withToken);
    const auth = withToken ? ` Remote callers need an API token (Settings → API access).` : "";
    void copy(
      link.text,
      link.kind === "get" ? "API URL copied" : "curl POST copied",
      (link.kind === "get" ? "GET /api/v1/screen — Finviz-style filter codes." : `${link.reason}.`) + auth,
    );
  };
  const copyMcp = () => {
    const { query } = currentQuery();
    void copy(mcpArgsText(query), "MCP `screen` arguments copied", "JSON arguments for the MCP tool `screen` (endpoint in Settings → API access).");
  };
  return (
    <>
      <button type="button" className="btn scr-btn-sm" onClick={copyApi} disabled={disabled} title="Copy a GET /api/v1/screen URL for this screen (curl POST when it has custom ranges)">
        Copy as API
      </button>
      <button type="button" className="btn scr-btn-sm" onClick={copyMcp} disabled={disabled} title="Copy the JSON arguments for the MCP `screen` tool">
        Copy MCP call
      </button>
    </>
  );
}
