import { describe, expect, it } from "vitest";
import { backendFromAskTool, createAgentMcpServerConfig, generateAgentToolDefinitions } from "./agent-mcp-tools.js";

describe("agent MCP tools", () => {
  it("generates ask tools only for enabled backends", () => {
    // The MCP server must not advertise tools for backends the caller did not enable.
    const tools = generateAgentToolDefinitions(["codex", "goose"]);

    expect(tools.map((tool) => tool.name)).toEqual(["ask_codex", "ask_goose"]);
    expect(tools[0].input_schema.required).toEqual(["prompt"]);
    expect(backendFromAskTool("ask_codex")).toBe("codex");
    expect(backendFromAskTool("Bash")).toBeNull();
  });

  it("builds a per-parent stdio MCP config with internal auth", () => {
    // Each lead session gets its own parent session id in the MCP process env.
    const config = createAgentMcpServerConfig({
      port: 4567,
      token: "secret",
      packageRoot: "/app/web",
      parentSessionId: "parent-1",
      backends: ["codex"],
    });

    expect(config.type).toBe("stdio");
    expect(config.command).toBe("bun");
    expect(config.args).toEqual(["/app/web/server/agent-mcp-stdio.ts"]);
    expect(config.env?.CAMPFIRE_PARENT_SESSION_ID).toBe("parent-1");
    expect(config.env?.CAMPFIRE_AGENT_MCP_BACKENDS).toBe("codex");
  });
});
