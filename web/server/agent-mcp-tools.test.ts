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
    // Outside a Bun runtime (vitest runs on Node) the command falls back to
    // the PATH-resolved `bun`.
    expect(config.command).toBe("bun");
    expect(config.args).toEqual(["/app/web/server/agent-mcp-stdio.ts"]);
    expect(config.env?.CAMPFIRE_PARENT_SESSION_ID).toBe("parent-1");
    expect(config.env?.CAMPFIRE_AGENT_MCP_BACKENDS).toBe("codex");
  });

  it("uses the absolute runtime path when running under Bun", () => {
    // In production the server always runs under Bun. The desktop app bundles
    // Bun inside the .app (not on PATH), so the MCP config must point the
    // agent CLI at the absolute executable path, not a bare `bun` lookup.
    (globalThis as Record<string, unknown>).Bun = {};
    try {
      const config = createAgentMcpServerConfig({
        port: 4567,
        token: "secret",
        packageRoot: "/app/web",
        parentSessionId: "parent-1",
      });
      expect(config.command).toBe(process.execPath);
    } finally {
      delete (globalThis as Record<string, unknown>).Bun;
    }
  });
});
