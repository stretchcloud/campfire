import { describe, expect, it, vi } from "vitest";
import { AgentMcpBridge } from "./agent-mcp-bridge.js";

describe("AgentMcpBridge", () => {
  it("injects the Campfire agent MCP server into lead sessions only", () => {
    // Prevents recursive tool injection into sub-agent sessions spawned by the bridge.
    const wsBridge = {
      getSession: vi.fn(() => ({ state: { cwd: "/repo" } })),
      setMcpServers: vi.fn(),
    };
    const bridge = new AgentMcpBridge(wsBridge as any, {} as any, {
      port: 4567,
      packageRoot: "/app/web",
      token: "token",
      backends: ["codex"],
    });

    bridge.onSessionReady("parent-1", "claude", "/repo");
    bridge.onSessionReady("parent-1", "claude", "/repo");

    expect(wsBridge.setMcpServers).toHaveBeenCalledTimes(1);
    expect(wsBridge.setMcpServers).toHaveBeenCalledWith("parent-1", {
      campfire_agents: expect.objectContaining({
        type: "stdio",
        env: expect.objectContaining({
          CAMPFIRE_PARENT_SESSION_ID: "parent-1",
          CAMPFIRE_AGENT_MCP_TOKEN: "token",
        }),
      }),
    });
  });

  it("delegates ask tool calls to the sub-session manager", async () => {
    // Validates the HTTP/MCP tool handler path without a live MCP process.
    const wsBridge = {
      getSession: vi.fn(() => ({ state: { cwd: "/repo" } })),
      setMcpServers: vi.fn(),
    };
    const subSessionManager = {
      spawnSubSession: vi.fn(async () => ({
        sessionId: "child-1",
        backendType: "codex",
        text: "done",
        filesChanged: [],
        costUsd: 0,
        durationMs: 1,
      })),
    };
    const bridge = new AgentMcpBridge(wsBridge as any, subSessionManager as any, {
      port: 4567,
      packageRoot: "/app/web",
      token: "token",
    });

    const result = await bridge.callTool("parent-1", "ask_codex", { prompt: "Write tests", timeout_seconds: 1 });

    expect(result.text).toBe("done");
    expect(subSessionManager.spawnSubSession).toHaveBeenCalledWith(
      "parent-1",
      "codex",
      "Write tests",
      "/repo",
      expect.objectContaining({ timeoutMs: 1000 }),
    );
  });
});
