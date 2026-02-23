/**
 * Tests for the OpenCodeAdapter — validates that OpenCode ACP JSON-RPC messages
 * are correctly translated to the Companion's BrowserIncomingMessage types.
 *
 * OpenCode differences from Goose:
 * - Notification method: "session/update" (not "session/notification")
 * - Update kind field: update.kind (not update.sessionUpdate)
 * - Update type strings: snake_case (agent_message_chunk, tool_call, etc.)
 * - Permission model: JSON-RPC request/response for session/request_permission
 *   (NOT notification-based like Goose); permission response uses transport.respond()
 * - protocolVersion is numeric (1) not string ("v1")
 * - clientCapabilities includes fs and terminal capabilities
 *
 * These tests mock the Bun.Subprocess and verify that the adapter:
 * 1. Performs the ACP initialization handshake (protocolVersion: 1)
 * 2. Creates/loads sessions
 * 3. Translates session/update notifications to browser messages
 * 4. Handles session/request_permission (request-based) correctly
 * 5. Sends JSON-RPC respond() for permissions (not notify())
 * 6. Handles tool call/result mapping
 * 7. Queues messages before init completes
 * 8. Reports errors on init failure
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";

// ─── Mock Transport Layer ───────────────────────────────────────────────────

/**
 * Simulates the OpenCode ACP process stdin/stdout for testing.
 * We intercept what the adapter writes to stdin and inject responses via stdout.
 */
class MockOpenCodeProcess {
  private stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stdinChunks: string[] = [];
  private encoder = new TextEncoder();
  exitedResolve: ((code: number) => void) | null = null;
  pid = 12345;

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

  /** Inject a JSON-RPC message into the adapter's stdout reader. */
  injectResponse(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj) + "\n";
    this.stdoutController?.enqueue(this.encoder.encode(line));
  }

  /** Get the last JSON-RPC message sent by the adapter to stdin. */
  getLastSent(): Record<string, unknown> | null {
    if (this.stdinChunks.length === 0) return null;
    const last = this.stdinChunks[this.stdinChunks.length - 1].trim();
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }

  /** Get all messages sent by the adapter. */
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

describe("OpenCodeAdapter", () => {
  // We import the adapter dynamically to avoid module-level side effects
  let OpenCodeAdapter: typeof import("./opencode-adapter.js").OpenCodeAdapter;

  beforeEach(async () => {
    const mod = await import("./opencode-adapter.js");
    OpenCodeAdapter = mod.OpenCodeAdapter;
  });

  /**
   * Helper: create an OpenCodeAdapter with a mock process and complete init.
   * Returns the adapter, mock process, and a message collector.
   */
  async function createInitializedAdapter(options?: {
    model?: string;
    cwd?: string;
  }): Promise<{
    adapter: InstanceType<typeof OpenCodeAdapter>;
    proc: MockOpenCodeProcess;
    messages: BrowserIncomingMessage[];
  }> {
    const proc = new MockOpenCodeProcess();
    const messages: BrowserIncomingMessage[] = [];

    // Create adapter — this triggers initialize() automatically
    const adapter = new OpenCodeAdapter(proc as any, "test-session-123", {
      model: options?.model || "claude-sonnet-4-5-20250929",
      cwd: options?.cwd || "/tmp/test-project",
    });

    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Wait a tick for the initialize() call to be sent
    await new Promise((r) => setTimeout(r, 10));

    // Respond to initialize
    const initMsg = proc.getAllSent().find((m) => m.method === "initialize");
    if (initMsg) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: initMsg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcp: { http: true, sse: true },
          },
          agentInfo: { name: "opencode", title: "OpenCode Agent", version: "1.2.0" },
          authMethods: [],
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
        result: { sessionId: "opencode-session-abc" },
      });
    }

    // Wait for init to complete (session_init emitted, queued messages flushed, etc.)
    await new Promise((r) => setTimeout(r, 50));

    return { adapter, proc, messages };
  }

  it("performs ACP initialization handshake with numeric protocolVersion", async () => {
    // Validates that OpenCode's ACP init uses protocolVersion: 1 (numeric, not "v1")
    // and includes fs + terminal clientCapabilities
    const proc = new MockOpenCodeProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenCodeAdapter(proc as any, "test-session-1", {
      model: "gpt-4o",
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 10));

    const sent = proc.getAllSent();
    const initReq = sent.find((m) => m.method === "initialize");
    expect(initReq).toBeTruthy();
    expect(initReq?.jsonrpc).toBe("2.0");
    // OpenCode uses numeric protocolVersion (not "v1" like Goose)
    expect((initReq?.params as any)?.protocolVersion).toBe(1);
    expect((initReq?.params as any)?.clientInfo?.name).toBe("campfire");
    // OpenCode clientCapabilities include fs and terminal
    expect((initReq?.params as any)?.clientCapabilities?.fs?.readTextFile).toBe(true);
    expect((initReq?.params as any)?.clientCapabilities?.terminal).toBe(true);
  });

  it("emits session_init with backend_type opencode after successful initialization", async () => {
    // Ensures the browser receives a session_init with correct OpenCode metadata
    const { messages } = await createInitializedAdapter();

    const initMsg = messages.find((m) => m.type === "session_init");
    expect(initMsg).toBeTruthy();
    if (initMsg?.type === "session_init") {
      expect(initMsg.session.backend_type).toBe("opencode");
      expect(initMsg.session.session_id).toBe("test-session-123");
      expect(initMsg.session.model).toBe("claude-sonnet-4-5-20250929");
      expect(initMsg.session.cwd).toBe("/tmp/test-project");
    }
  });

  it("translates session/update agent_message_chunk to stream_event", async () => {
    // OpenCode uses "session/update" with kind: "agent_message_chunk" (not "session/notification")
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // Inject an agent_message_chunk notification
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "opencode-session-abc",
        update: {
          kind: "agent_message_chunk",
          content: { type: "text", text: "Hello from OpenCode!" },
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
      expect((deltaEvent as any).event?.delta?.text).toBe("Hello from OpenCode!");
    }
  });

  it("translates session/update tool_call to assistant message with tool_use", async () => {
    // OpenCode uses kind: "tool_call" (not "toolCall" like Goose)
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "opencode-session-abc",
        update: {
          kind: "tool_call",
          id: "tool-call-1",
          toolName: "bash",
          arguments: { command: "ls -la" },
          status: "pending",
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should have an assistant message with tool_use content
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
      // "bash" maps to "Bash"
      expect(toolBlock.name).toBe("Bash");
      expect(toolBlock.input.command).toBe("ls -la");
    }
  });

  it("translates session/update tool_call_update to tool_result", async () => {
    // OpenCode uses kind: "tool_call_update" (not "toolCallUpdate" like Goose)
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // First inject tool_call
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "opencode-session-abc",
        update: {
          kind: "tool_call",
          id: "tool-call-2",
          toolName: "file_read",
          arguments: { path: "/tmp/test.txt" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Then inject tool_call_update
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "opencode-session-abc",
        update: {
          kind: "tool_call_update",
          id: "tool-call-2",
          result: "File content here",
          status: "completed",
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Should have a tool_result message
    const resultMsg = messages.find(
      (m) => m.type === "assistant" && (m as any).message?.content?.some(
        (b: any) => b.type === "tool_result" && b.tool_use_id === "tool-call-2"
      )
    );
    expect(resultMsg).toBeTruthy();
  });

  it("handles session/request_permission as JSON-RPC request and emits permission_request", async () => {
    // OpenCode uses a proper JSON-RPC REQUEST for permissions (unlike Goose's notification-based approach).
    // The adapter must store the rpc id and respond() when the browser approves/denies.
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // Inject session/request_permission as a JSON-RPC REQUEST (has id field)
    proc.injectResponse({
      jsonrpc: "2.0",
      id: 999,  // This is the rpc id we need to respond to
      method: "session/request_permission",
      params: {
        sessionId: "opencode-session-abc",
        toolCall: {
          id: "tool-999",
          toolName: "bash",
          description: "Execute shell command",
          arguments: { command: "rm -rf /tmp/test" },
        },
        options: ["allow_once", "allow_always", "reject_once", "reject_always"],
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const permMsg = messages.find((m) => m.type === "permission_request");
    expect(permMsg).toBeTruthy();
    if (permMsg?.type === "permission_request") {
      expect(permMsg.request.tool_name).toBe("Bash");
      expect(permMsg.request.input.command).toBe("rm -rf /tmp/test");
      expect(permMsg.request.description).toBe("Execute shell command");
    }
  });

  it("sends JSON-RPC respond() (not notify) when permission_response is received", async () => {
    // CRITICAL: OpenCode expects a JSON-RPC response to the permission request (not a notification).
    // The adapter must call transport.respond(rpcId, { outcome: "allow_once" })
    // rather than transport.notify("requestPermission", ...) like Goose does.
    const { proc, messages, adapter } = await createInitializedAdapter();
    messages.length = 0;

    // Inject permission request with rpc id = 777
    proc.injectResponse({
      jsonrpc: "2.0",
      id: 777,
      method: "session/request_permission",
      params: {
        sessionId: "opencode-session-abc",
        toolCall: {
          id: "perm-tool-1",
          toolName: "bash",
          description: "Run bash command",
          arguments: { command: "echo test" },
        },
        options: ["allow_once", "reject_once"],
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Find the permission_request to get the request_id
    const permMsg = messages.find((m) => m.type === "permission_request");
    expect(permMsg).toBeTruthy();

    // Clear sent messages to only capture the permission response
    const sentBefore = proc.getAllSent().length;

    // Send permission response (allow)
    if (permMsg?.type === "permission_request") {
      adapter.sendBrowserMessage({
        type: "permission_response",
        request_id: permMsg.request.request_id,
        behavior: "allow",
      });
    }

    await new Promise((r) => setTimeout(r, 10));

    // The adapter should have sent a JSON-RPC RESPONSE (with id: 777, result: { outcome: "allow_once" })
    // NOT a notification like Goose does
    const allSent = proc.getAllSent();
    const newMessages = allSent.slice(sentBefore);

    // Find the response message (has id field but no method field)
    const responseMsg = newMessages.find(
      (m) => m.id === 777 && !m.method && (m.result as any)?.outcome === "allow_once"
    );
    expect(responseMsg).toBeTruthy();
  });

  it("maps OpenCode tool names to Companion-compatible names", async () => {
    // Validates the tool name mapping for OpenCode's tool naming conventions
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // "bash" → "Bash"
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          kind: "tool_call",
          id: "t1",
          toolName: "file_write",
          arguments: { path: "/tmp/test.ts", content: "// hello" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const toolMsg = messages.find(
      (m) => m.type === "assistant" && (m as any).message?.content?.some(
        (b: any) => b.type === "tool_use" && b.name === "Write"
      )
    );
    expect(toolMsg).toBeTruthy();
  });

  it("queues user messages before initialization completes", async () => {
    // Messages sent before init completes should be queued and flushed after init
    const proc = new MockOpenCodeProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenCodeAdapter(proc as any, "test-queue", {
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    // Send a message before init completes
    const accepted = adapter.sendBrowserMessage({
      type: "user_message",
      content: "Hello early message",
    });

    // The message should be accepted (queued)
    expect(accepted).toBe(true);
  });

  it("emits error on init failure and calls onInitError callback", async () => {
    // When OpenCode fails to initialize (e.g., agent not installed), the adapter
    // should emit an error message and call the registered onInitError callback
    const proc = new MockOpenCodeProcess();
    const messages: BrowserIncomingMessage[] = [];
    let initError: string | null = null;

    const adapter = new OpenCodeAdapter(proc as any, "test-fail", {
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
        error: { code: -32601, message: "Method not found — OpenCode not configured" },
      });
    }

    await new Promise((r) => setTimeout(r, 50));

    expect(initError).toBeTruthy();
    expect(initError).toContain("OpenCode initialization failed");

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
  });

  it("returns false for messages when init has failed", async () => {
    // After init failure, the adapter should reject all outgoing messages
    const proc = new MockOpenCodeProcess();
    const adapter = new OpenCodeAdapter(proc as any, "test-fail-2", {
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

  it("resumes an existing session when opencodeSessionId is provided", async () => {
    // When an opencodeSessionId is in options and loadSession capability exists,
    // the adapter should call session/load instead of session/new
    const proc = new MockOpenCodeProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new OpenCodeAdapter(proc as any, "test-resume", {
      cwd: "/tmp/test",
      opencodeSessionId: "existing-session-xyz",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 10));

    // Respond to initialize with loadSession: true capability
    const initReq = proc.getAllSent().find((m) => m.method === "initialize");
    if (initReq) {
      proc.injectResponse({
        jsonrpc: "2.0",
        id: initReq.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        },
      });
    }

    await new Promise((r) => setTimeout(r, 10));

    // Should send session/load (not session/new) with the existing session ID
    const loadMsg = proc.getAllSent().find((m) => m.method === "session/load");
    expect(loadMsg).toBeTruthy();
    expect((loadMsg?.params as any)?.sessionId).toBe("existing-session-xyz");

    // Should NOT have sent session/new
    const newMsg = proc.getAllSent().find((m) => m.method === "session/new");
    expect(newMsg).toBeFalsy();
  });
});
