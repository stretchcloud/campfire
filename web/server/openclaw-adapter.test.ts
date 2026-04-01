/**
 * Tests for the OpenClawAdapter — validates that OpenClaw ACP JSON-RPC messages
 * are correctly translated to the Campfire's BrowserIncomingMessage types.
 *
 * OpenClaw uses the same ACP protocol as Goose, but with different tool naming
 * conventions (plain names instead of developer__ prefixed names) and different
 * session key semantics (Gateway session keys instead of local session IDs).
 *
 * These tests mock the Bun.Subprocess and verify that the adapter:
 * 1. Performs the ACP initialization handshake
 * 2. Creates/loads sessions
 * 3. Translates streaming notifications to browser messages
 * 4. Handles permission requests (ActionRequired)
 * 5. Handles tool call/result mapping with OpenClaw's naming conventions
 * 6. Handles both snake_case and camelCase update types (OpenClaw sends snake_case)
 * 7. Queues messages before init completes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

// ─── Mock Transport Layer ───────────────────────────────────────────────────

/**
 * Simulates the openclaw acp process stdin/stdout for testing.
 * Intercepts what the adapter writes to stdin and injects responses via stdout.
 */
class MockOpenClawProcess {
  private stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stdinChunks: string[] = [];
  private encoder = new TextEncoder();
  exitedResolve: ((code: number) => void) | null = null;
  pid = 54321;

  stdout: ReadableStream<Uint8Array>;
  stdin: { write: (data: Uint8Array) => number };
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;

  constructor() {
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.stdoutController = controller;
      },
    });

    this.stdin = {
      write: (data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        this.stdinChunks.push(text);
        return data.length;
      },
    };

    this.stderr = new ReadableStream({ start() {} });

    this.exited = new Promise((resolve) => {
      this.exitedResolve = resolve;
    });
  }

  /** Inject a JSON-RPC response into the adapter's stdout reader. */
  injectResponse(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj) + "\n";
    this.stdoutController?.enqueue(this.encoder.encode(line));
  }

  /** Get all messages sent by the adapter to stdin. */
  getAllSent(): Record<string, unknown>[] {
    return this.stdinChunks
      .flatMap((chunk) => chunk.split("\n").filter(Boolean))
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean) as Record<string, unknown>[];
  }

  kill(_signal?: string): void {
    // no-op
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("OpenClawAdapter", () => {
  let OpenClawAdapter: typeof import("./openclaw-adapter.js").OpenClawAdapter;

  beforeEach(async () => {
    const mod = await import("./openclaw-adapter.js");
    OpenClawAdapter = mod.OpenClawAdapter;
  });

  /**
   * Helper: create an OpenClawAdapter with a mock process and complete init.
   * Returns the adapter, mock process, and a message collector.
   */
  async function createInitializedAdapter(options?: {
    model?: string;
    cwd?: string;
  }): Promise<{
    adapter: InstanceType<typeof OpenClawAdapter>;
    proc: MockOpenClawProcess;
    messages: BrowserIncomingMessage[];
  }> {
    const proc = new MockOpenClawProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenClawAdapter(proc as any, "test-session-oc-1", {
      model: options?.model || "claude-sonnet-4-5",
      cwd: options?.cwd || "/tmp/test-project",
    });

    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Wait for the initialize() call to be sent
    await new Promise((r) => setTimeout(r, 10));

    // Respond to initialize — OpenClaw returns loadSession capability
    const initMsg = proc.getAllSent().find((m) => m.method === "initialize");
    if (initMsg) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: initMsg.id,
        result: {
          protocolVersion: "v1",
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
          },
          agentInfo: { name: "openclaw-acp", title: "OpenClaw ACP Gateway", version: "1.0.0" },
        },
      });
    }

    // Wait for session/new to be sent
    await new Promise((r) => setTimeout(r, 10));

    // Respond to session/new
    const newMsg = proc.getAllSent().find((m) => m.method === "session/new");
    if (newMsg) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: newMsg.id,
        result: { sessionId: "acp:openclaw-test-uuid" },
      });
    }

    // Wait for init to complete
    await new Promise((r) => setTimeout(r, 50));

    return { adapter, proc, messages };
  }

  it("performs ACP initialization handshake", async () => {
    const proc = new MockOpenClawProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenClawAdapter(proc as any, "test-init-1", {
      model: "default",
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 10));

    const sent = proc.getAllSent();
    const initReq = sent.find((m) => m.method === "initialize");
    expect(initReq).toBeTruthy();
    expect(initReq?.jsonrpc).toBe("2.0");
    expect((initReq?.params as any)?.clientInfo?.name).toBe("campfire");
  });

  it("emits session_init after successful initialization", async () => {
    const { messages } = await createInitializedAdapter();

    const initMsg = messages.find((m) => m.type === "session_init");
    expect(initMsg).toBeTruthy();
    if (initMsg?.type === "session_init") {
      expect(initMsg.session.backend_type).toBe("openclaw");
      expect(initMsg.session.session_id).toBe("test-session-oc-1");
      expect(initMsg.session.model).toBe("claude-sonnet-4-5");
      expect(initMsg.session.cwd).toBe("/tmp/test-project");
    }
  });

  it("translates agent_message_chunk (snake_case) to stream_event", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // OpenClaw sends snake_case update types (agent_message_chunk)
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "acp:openclaw-test-uuid",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from OpenClaw!" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should have message_start, content_block_start, and content_block_delta
    const startEvent = messages.find(
      (m) => m.type === "stream_event" && (m as any).event?.type === "message_start"
    );
    expect(startEvent).toBeTruthy();

    const deltaEvent = messages.find(
      (m) => m.type === "stream_event" && (m as any).event?.type === "content_block_delta"
    );
    expect(deltaEvent).toBeTruthy();
    if (deltaEvent?.type === "stream_event") {
      expect((deltaEvent as any).event?.delta?.text).toBe("Hello from OpenClaw!");
    }
  });

  it("translates tool_call (snake_case) to assistant message with tool_use", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // OpenClaw sends snake_case update type and plain tool names
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "acp:openclaw-test-uuid",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "oc-tool-1",
          title: "bash",
          rawInput: { command: "git status" },
          status: "in_progress",
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const toolMsg = messages.find(
      (m) => m.type === "assistant" && (m as any).message?.content?.some(
        (b: any) => b.type === "tool_use"
      )
    );
    expect(toolMsg).toBeTruthy();
    if (toolMsg?.type === "assistant") {
      const toolBlock = (toolMsg as any).message.content.find(
        (b: any) => b.type === "tool_use"
      );
      // OpenClaw "bash" maps to "Bash"
      expect(toolBlock.name).toBe("Bash");
      expect(toolBlock.input.command).toBe("git status");
    }
  });

  it("translates tool_call_update (snake_case) to tool_result", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // First inject a tool_call
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "oc-tool-2",
          title: "text_editor",
          rawInput: { path: "/tmp/test.txt" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Then inject tool_call_update with snake_case type
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "oc-tool-2",
          rawOutput: "File edited successfully",
          status: "completed",
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const resultMsg = messages.find(
      (m) => m.type === "assistant" && (m as any).message?.content?.some(
        (b: any) => b.type === "tool_result" && b.tool_use_id === "oc-tool-2"
      )
    );
    expect(resultMsg).toBeTruthy();
  });

  it("maps OpenClaw tool names to Campfire-compatible names", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // OpenClaw uses plain tool names, not prefixed like Goose
    const testCases = [
      { input: "bash", expected: "Bash" },
      { input: "shell", expected: "Bash" },
      { input: "text_editor", expected: "Edit" },
      { input: "read_file", expected: "Read" },
      { input: "write_file", expected: "Write" },
      { input: "list_directory", expected: "Glob" },
      { input: "search_files", expected: "Grep" },
      { input: "custom_skill", expected: "custom_skill" }, // unknown tools pass through
    ];

    for (const tc of testCases) {
      messages.length = 0;

      proc.injectResponse({
        jsonrpc: "2.0",
        method: "session/notification",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `map-test-${tc.input}`,
            title: tc.input,
            rawInput: {},
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      const toolMsg = messages.find(
        (m) => m.type === "assistant" && (m as any).message?.content?.some(
          (b: any) => b.type === "tool_use" && b.name === tc.expected
        )
      );
      expect(toolMsg, `Expected "${tc.input}" to map to "${tc.expected}"`).toBeTruthy();
    }
  });

  it("translates actionRequired to permission_request", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        update: {
          sessionUpdate: "actionRequired",
          data: {
            actionType: "toolConfirmation",
            id: "oc-perm-1",
            toolName: "bash",
            arguments: { command: "rm -rf node_modules" },
            prompt: "Execute this command?",
          },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const permMsg = messages.find((m) => m.type === "permission_request");
    expect(permMsg).toBeTruthy();
    if (permMsg?.type === "permission_request") {
      expect(permMsg.request.tool_name).toBe("Bash");
      expect(permMsg.request.input.command).toBe("rm -rf node_modules");
      expect(permMsg.request.description).toBe("Execute this command?");
    }
  });

  it("ignores available_commands_update (OpenClaw-specific)", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // OpenClaw sends available_commands_update after session creation
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "/help", description: "Help" }],
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should not produce any browser messages
    expect(messages.length).toBe(0);
  });

  it("queues user messages before initialization completes", async () => {
    const proc = new MockOpenClawProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenClawAdapter(proc as any, "test-queue-oc", {
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Send a message before init completes — should be accepted (queued)
    const accepted = adapter.sendBrowserMessage({
      type: "user_message",
      content: "Hello early message",
    });

    expect(accepted).toBe(true);
  });

  it("emits error on init failure", async () => {
    const proc = new MockOpenClawProcess();
    const messages: BrowserIncomingMessage[] = [];
    let initError: string | null = null;

    const adapter = new OpenClawAdapter(proc as any, "test-fail-oc", {
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onInitError((err) => { initError = err; });

    await new Promise((r) => setTimeout(r, 10));

    // Send an error response to the initialize request
    const initReq = proc.getAllSent().find((m) => m.method === "initialize");
    if (initReq) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: initReq.id,
        error: { code: -1, message: "Gateway unreachable" },
      });
    }

    await new Promise((r) => setTimeout(r, 50));

    expect(initError).toBeTruthy();
    expect(initError).toContain("OpenClaw initialization failed");

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
  });

  it("returns false for messages when init has failed", async () => {
    const proc = new MockOpenClawProcess();
    const adapter = new OpenClawAdapter(proc as any, "test-fail-oc-2", {
      cwd: "/tmp/test",
    });

    await new Promise((r) => setTimeout(r, 10));

    // Fail initialization
    const initReq = proc.getAllSent().find((m) => m.method === "initialize");
    if (initReq) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: initReq.id,
        error: { code: -1, message: "fail" },
      });
    }

    await new Promise((r) => setTimeout(r, 50));

    const result = adapter.sendBrowserMessage({
      type: "user_message",
      content: "This should be rejected",
    });

    expect(result).toBe(false);
  });

  it("reports correct backend session ID", async () => {
    const { adapter } = await createInitializedAdapter();

    // OpenClaw session IDs use the acp:<uuid> format
    expect(adapter.getBackendSessionId()).toBe("acp:openclaw-test-uuid");
  });
});
