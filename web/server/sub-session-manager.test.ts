import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";
import { SubSessionManager } from "./sub-session-manager.js";
import type { BrowserIncomingMessage } from "./session-types.js";

vi.mock("./auto-namer.js", () => ({
  generateSessionTitle: vi.fn(async () => null),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateSessionTitle).mockResolvedValue(null);
  vi.mocked(sessionNames.getName).mockReturnValue(undefined);
});

describe("SubSessionManager", () => {
  it("launches a child session, injects one prompt, collects result metadata, and kills the process", async () => {
    // This validates the one-turn sub-agent lifecycle without spawning a real backend process.
    const history: BrowserIncomingMessage[] = [];
    const launcher = {
      getSession: vi.fn(() => undefined),
      launch: vi.fn(() => ({ sessionId: "child-1", detectedEnvironment: undefined })),
      kill: vi.fn(async () => true),
      markSessionExited: vi.fn(() => true),
    };
    const wsBridge = {
      broadcastSubAgentUpdate: vi.fn(),
      markSessionOrchestration: vi.fn(),
      isCliConnected: vi.fn(() => true),
      injectUserMessage: vi.fn((_sessionId: string, content: string) => {
        history.push({
          type: "user_message",
          content,
          timestamp: Date.now(),
        });
        history.push({
          type: "assistant",
          parent_tool_use_id: null,
          timestamp: Date.now(),
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "codex",
            content: [{ type: "text", text: "Implemented schema." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        });
        history.push({
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 12,
            duration_api_ms: 10,
            num_turns: 1,
            total_cost_usd: 0.02,
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "result-1",
            session_id: "child-1",
          },
        });
      }),
      getSession: vi.fn(() => ({
        messageHistory: history,
        state: { total_cost_usd: 0.02 },
      })),
      addSubAgentCost: vi.fn(),
    };

    const manager = new SubSessionManager(launcher as any, wsBridge as any);
    const result = await manager.spawnSubSession("parent-1", "codex", "Create schema", "/tmp", {
      timeoutMs: 1000,
      toolUseId: "tool-1",
    });

    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
      backendType: "codex",
      cwd: "/tmp",
      parentSessionId: "parent-1",
      orchestrationRole: "subagent",
    }));
    expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("child-1", "Create schema");
    expect(result.text).toContain("Implemented schema.");
    expect(result.costUsd).toBe(0.02);
    expect(manager.getChildSessions("parent-1")).toEqual(["child-1"]);
    expect(wsBridge.addSubAgentCost).toHaveBeenCalledWith("parent-1", 0.02);
    expect(launcher.kill).toHaveBeenCalledWith("child-1");
    expect(launcher.markSessionExited).toHaveBeenCalledWith("child-1", 0);
  });

  it("inherits the parent session environment when launching a sub-agent", async () => {
    // Delegated agents run as separate backend processes, so provider-specific
    // credentials from the lead session must be forwarded to the child session.
    const history: BrowserIncomingMessage[] = [];
    const launcher = {
      getSession: vi.fn(() => ({
        sessionId: "parent-1",
        sessionEnv: {
          AZURE_OPENAI_API_KEY: "azure-secret",
          AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        },
      })),
      launch: vi.fn(() => ({ sessionId: "child-1", detectedEnvironment: undefined })),
      kill: vi.fn(async () => true),
      markSessionExited: vi.fn(() => true),
    };
    const wsBridge = {
      broadcastSubAgentUpdate: vi.fn(),
      markSessionOrchestration: vi.fn(),
      isCliConnected: vi.fn(() => true),
      injectUserMessage: vi.fn(() => {
        history.push({
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "result-1",
            session_id: "child-1",
          },
        });
      }),
      getSession: vi.fn(() => ({
        messageHistory: history,
        state: { total_cost_usd: 0 },
      })),
      addSubAgentCost: vi.fn(),
    };

    const manager = new SubSessionManager(launcher as any, wsBridge as any);
    await manager.spawnSubSession("parent-1", "codex", "Use Azure OpenAI", "/tmp", {
      timeoutMs: 1000,
    });

    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
      backendType: "codex",
      env: {
        AZURE_OPENAI_API_KEY: "azure-secret",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      },
    }));
  });

  it("updates the child session and parent subagent card with generated OpenRouter title", async () => {
    // Subagents start with a provisional name, then asynchronously adopt the
    // same OpenRouter-generated title used for persisted session names.
    vi.mocked(generateSessionTitle).mockResolvedValue("Create Schema");
    const history: BrowserIncomingMessage[] = [];
    const launcher = {
      getSession: vi.fn(() => undefined),
      launch: vi.fn(() => ({ sessionId: "child-1", detectedEnvironment: undefined })),
      kill: vi.fn(async () => true),
      markSessionExited: vi.fn(() => true),
    };
    const wsBridge = {
      broadcastSubAgentUpdate: vi.fn(),
      broadcastNameUpdate: vi.fn(),
      markSessionOrchestration: vi.fn(),
      isCliConnected: vi.fn(() => true),
      injectUserMessage: vi.fn(() => {
        history.push({
          type: "user_message",
          content: "Create schema",
          timestamp: Date.now(),
        });
        history.push({
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "result-1",
            session_id: "child-1",
          },
        });
      }),
      getSession: vi.fn(() => ({
        messageHistory: history,
        state: { total_cost_usd: 0 },
      })),
      addSubAgentCost: vi.fn(),
    };

    const manager = new SubSessionManager(launcher as any, wsBridge as any);
    await manager.spawnSubSession("parent-1", "codex", "Create schema", "/tmp", {
      timeoutMs: 1000,
      toolUseId: "tool-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(generateSessionTitle).toHaveBeenCalledWith("Create schema", "codex", { timeoutMs: 15_000 });
    expect(sessionNames.setName).toHaveBeenCalledWith("child-1", "Create Schema");
    expect(wsBridge.broadcastNameUpdate).toHaveBeenCalledWith("child-1", "Create Schema");
    expect(wsBridge.broadcastSubAgentUpdate).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        toolUseId: "tool-1",
        name: "Create Schema",
        status: "completed",
      }),
    );
  });
});
