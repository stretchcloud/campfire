import { describe, expect, it, vi } from "vitest";
import { AgentMcpBridge } from "./agent-mcp-bridge.js";

describe("AgentMcpBridge", () => {
  it("injects the Campfire agent MCP server into top-level sessions by default", () => {
    // Normal top-level Claude/Codex sessions are the delegation entry point.
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

  it("does not inject the Campfire agent MCP server into sub-agent sessions", () => {
    // Prevents recursive tool injection into sessions spawned by the bridge.
    const wsBridge = {
      getSession: vi.fn(() => ({ state: { cwd: "/repo", parent_session_id: "parent-1", orchestration_role: "subagent" } })),
      setMcpServers: vi.fn(),
    };
    const bridge = new AgentMcpBridge(wsBridge as any, {} as any, {
      port: 4567,
      packageRoot: "/app/web",
      token: "token",
      backends: ["codex"],
    });

    bridge.onSessionReady("child-1", "codex", "/repo");

    expect(wsBridge.setMcpServers).not.toHaveBeenCalled();
  });

  it("can disable Campfire agent MCP injection with an environment flag", () => {
    // Keeps an escape hatch for deployments that do not want delegation tools.
    const previous = process.env.CAMPFIRE_ENABLE_AGENT_MCP;
    process.env.CAMPFIRE_ENABLE_AGENT_MCP = "0";
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

    try {
      bridge.onSessionReady("normal-1", "codex", "/repo");
      expect(wsBridge.setMcpServers).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CAMPFIRE_ENABLE_AGENT_MCP;
      else process.env.CAMPFIRE_ENABLE_AGENT_MCP = previous;
    }
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

  it("auto-allows Campfire agent MCP permission requests from adapter backends", () => {
    // Codex exposes MCP calls as mcp:<server>:<tool>; Campfire's own agent
    // tools should bypass generic MCP approval and let SubSessionManager emit
    // the sub_agent_update lifecycle.
    const wsBridge = {
      getSession: vi.fn(() => ({ state: { cwd: "/repo" } })),
      setMcpServers: vi.fn(),
    };
    const bridge = new AgentMcpBridge(wsBridge as any, {} as any, {
      port: 4567,
      packageRoot: "/app/web",
      token: "token",
    });
    const respond = vi.fn();

    const handled = bridge.handleAdapterPermissionRequest("parent-1", {
      request_id: "perm-1",
      tool_name: "mcp:campfire_agents:ask_claude",
      input: { prompt: "Review this change" },
      tool_use_id: "tool-1",
      timestamp: Date.now(),
    }, respond);

    expect(handled).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      type: "permission_response",
      request_id: "perm-1",
      behavior: "allow",
      updated_input: { prompt: "Review this change" },
    });
  });

  it("does not auto-allow non-Campfire MCP permission requests", () => {
    // Third-party MCP servers still need the normal user-visible permission
    // path, even if their tool happens to be named like an ask tool.
    const wsBridge = {
      getSession: vi.fn(() => ({ state: { cwd: "/repo" } })),
      setMcpServers: vi.fn(),
    };
    const bridge = new AgentMcpBridge(wsBridge as any, {} as any, {
      port: 4567,
      packageRoot: "/app/web",
      token: "token",
    });
    const respond = vi.fn();

    const handled = bridge.handleAdapterPermissionRequest("parent-1", {
      request_id: "perm-1",
      tool_name: "mcp:other_server:ask_claude",
      input: { prompt: "Review this change" },
      tool_use_id: "tool-1",
      timestamp: Date.now(),
    }, respond);

    expect(handled).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});
