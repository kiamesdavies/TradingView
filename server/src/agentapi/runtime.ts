// Process-wide agent API singletons: token store (shared SQLite), auth, service and MCP server.
import { db } from "../db";
import { createAgentAuth, parseEnvTokens } from "./auth";
import { createAgentCredits, DEFAULT_AGENT_CREDIT_BUDGET } from "./credits";
import { agentBackend } from "./backend";
import { createMcpServer } from "./mcp";
import { createAgentService } from "./service";
import { createTokenStore } from "./tokens";

export const tokenStore = createTokenStore(db);

/** Non-negative integer env var (0 allowed), else `def`. */
function envLimit(name: string, def: number): number {
  const raw = process.env[name];
  const n = Number(raw ?? "");
  return raw && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

export const agentAuth = createAgentAuth({
  envTokens: parseEnvTokens(process.env.EODVIEW_API_TOKENS),
  store: tokenStore,
  requireTokenOnLoopback: process.env.EODVIEW_API_REQUIRE_TOKEN === "1",
  rateLimit: envLimit("EODVIEW_API_RATE_LIMIT", 120),
  loopbackRateLimit: envLimit("EODVIEW_API_LOOPBACK_RATE_LIMIT", 600),
});

export const agentService = createAgentService(agentBackend);
export const mcpServer = createMcpServer(agentService);

/** EODHD credits agent requests may spend per UTC day (EODVIEW_AGENT_CREDIT_BUDGET, default 5000). */
export const agentCredits = createAgentCredits(db, { budget: envLimit("EODVIEW_AGENT_CREDIT_BUDGET", DEFAULT_AGENT_CREDIT_BUDGET) });
