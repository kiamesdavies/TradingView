// Builds the "Connect & access" commands shown in Settings from the server's DeploymentInfo.
import type { DeploymentInfo } from "@eodview/shared";

export interface ConnectCommand {
  id: string;
  title: string;
  command: string;
  note?: string;
}

const SERVICE_SECRET_PLACEHOLDER = "<service-token secret — see command above>";
const EODVIEW_TOKEN_PLACEHOLDER = "<EODView token from Settings → API access>";

function adminTokenCommand(info: DeploymentInfo): string | null {
  if (!info.adminTokenSecret || !info.gcpProject) return null;
  const account = info.gcpAccount ? ` --account=${info.gcpAccount}` : "";
  return `gcloud secrets versions access latest --secret=${info.adminTokenSecret} --project=${info.gcpProject}${account}`;
}

export function mcpAddCommand(info: DeploymentInfo, origin: string): string {
  const base = (info.publicUrl ?? origin).replace(/\/+$/, "");
  const lines = [`claude mcp add --transport http eodview ${base}/mcp`];
  if (info.cfAccessClientId) {
    lines.push(`  --header "CF-Access-Client-Id: ${info.cfAccessClientId}"`);
    lines.push(`  --header "CF-Access-Client-Secret: ${SERVICE_SECRET_PLACEHOLDER}"`);
  }
  if (info.hosted) lines.push(`  --header "Authorization: Bearer ${EODVIEW_TOKEN_PLACEHOLDER}"`);
  return lines.join(" \\\n");
}

export function connectCommands(info: DeploymentInfo, origin: string): ConnectCommand[] {
  const out: ConnectCommand[] = [];
  const admin = adminTokenCommand(info);
  if (admin) {
    out.push({
      id: "admin-token",
      title: "1. Admin token (unlocks this dialog and API access)",
      command: admin,
      note: "Run in a terminal, then paste the value into the admin token field below.",
    });
  }
  if (info.cfAccessClientId) {
    const repo = info.repoPath ? `cd ${info.repoPath} && ` : "";
    out.push({
      id: "service-secret",
      title: `${out.length + 1}. Cloudflare service-token secret (for agents)`,
      command: `${repo}deploy/tf.sh output -raw agent_service_token_client_secret`,
    });
  }
  out.push({
    id: "mcp-add",
    title: `${out.length + 1}. Add EODView to Claude Code (MCP)`,
    command: mcpAddCommand(info, origin),
    note: info.hosted
      ? "First create an EODView token in API access below, then fill in the placeholders."
      : "Callers on this machine need no token.",
  });
  return out;
}
