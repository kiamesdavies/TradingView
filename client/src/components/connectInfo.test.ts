import { describe, expect, test } from "bun:test";
import type { DeploymentInfo } from "@eodview/shared";
import { connectCommands, mcpAddCommand } from "./connectInfo";

const hosted: DeploymentInfo = {
  hosted: true,
  publicUrl: "https://charts.example.com",
  gcpProject: "eodview-prod",
  gcpAccount: "me@example.com",
  adminTokenSecret: "eodview-admin-token",
  cfAccessClientId: "abc.access",
  repoPath: "/Users/me/eodview",
};
const local: DeploymentInfo = {
  hosted: false, publicUrl: null, gcpProject: null, gcpAccount: null,
  adminTokenSecret: null, cfAccessClientId: null, repoPath: null,
};

describe("connect commands", () => {
  test("hosted: admin token, service secret, MCP with all headers", () => {
    const cmds = connectCommands(hosted, "https://charts.example.com");
    expect(cmds.map((c) => c.id)).toEqual(["admin-token", "service-secret", "mcp-add"]);
    expect(cmds[0]!.command).toBe(
      "gcloud secrets versions access latest --secret=eodview-admin-token --project=eodview-prod --account=me@example.com",
    );
    expect(cmds[1]!.command).toBe("cd /Users/me/eodview && deploy/tf.sh output -raw agent_service_token_client_secret");
    const mcp = cmds[2]!.command;
    expect(mcp).toContain("claude mcp add --transport http eodview https://charts.example.com/mcp");
    expect(mcp).toContain('--header "CF-Access-Client-Id: abc.access"');
    expect(mcp).toContain("CF-Access-Client-Secret:");
    expect(mcp).toContain("Authorization: Bearer");
    expect(cmds[2]!.title.startsWith("3.")).toBe(true);
  });

  test("local dev: only the plain MCP command, no headers", () => {
    const cmds = connectCommands(local, "http://localhost:3001");
    expect(cmds.map((c) => c.id)).toEqual(["mcp-add"]);
    expect(cmds[0]!.command).toBe("claude mcp add --transport http eodview http://localhost:3001/mcp");
    expect(cmds[0]!.title.startsWith("1.")).toBe(true);
  });

  test("public URL wins over the browser origin and trailing slashes are trimmed", () => {
    expect(mcpAddCommand({ ...hosted, publicUrl: "https://x.example.com/" }, "http://localhost:5173")).toContain(
      "https://x.example.com/mcp",
    );
  });
});
