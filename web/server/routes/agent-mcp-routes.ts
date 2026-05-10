import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { generateAgentToolDefinitions } from "../agent-mcp-tools.js";

function isInternalAuthorized(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const expected = process.env.CAMPFIRE_INTERNAL_AGENT_MCP_TOKEN;
  if (!expected) return false;
  const header = c.req.header("Authorization") || "";
  return header === `Bearer ${expected}`;
}

export function registerAgentMcpRoutes(api: Hono, deps: RouteDeps): void {
  api.get("/internal/agent-mcp/tools", (c) => {
    if (!isInternalAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ tools: generateAgentToolDefinitions() });
  });

  api.post("/internal/agent-mcp/call", async (c) => {
    if (!isInternalAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);
    if (!deps.agentMcpBridge) return c.json({ error: "Agent MCP bridge is not configured" }, 503);

    const body = await c.req.json<{
      parentSessionId?: string;
      toolName?: string;
      input?: Record<string, unknown>;
    }>().catch(() => ({} as { parentSessionId?: string; toolName?: string; input?: Record<string, unknown> }));

    if (!body.parentSessionId || !body.toolName) {
      return c.json({ error: "parentSessionId and toolName are required" }, 400);
    }

    const result = await deps.agentMcpBridge.callTool(body.parentSessionId, body.toolName, body.input ?? {});
    return c.json(result);
  });
}
