/**
 * Tests for the GooseAdapter — validates that Goose ACP JSON-RPC messages
 * are correctly translated to the Campfire's BrowserIncomingMessage types.
 *
 * These tests mock the Bun.Subprocess and verify that the adapter:
 * 1. Performs the ACP initialization handshake
 * 2. Creates/loads sessions
 * 3. Translates streaming notifications to browser messages
 * 4. Handles permission requests (ActionRequired)
 * 5. Handles tool call/result mapping
 * 6. Queues messages before init completes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

// ─── Mock Transport Layer ───────────────────────────────────────────────────

/**
 * Simulates the Goose ACP process stdin/stdout for testing.
 * We intercept what the adapter writes to stdin and inject responses via stdout.
 */
class MockGooseProcess {
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

  /** Inject a JSON-RPC response into the adapter's stdout reader. */
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

describe("GooseAdapter", () => {
  // We import the adapter dynamically to avoid module-level side effects
  let GooseAdapter: typeof import("./goose-adapter.js").GooseAdapter;

  beforeEach(async () => {
    const mod = await import("./goose-adapter.js");
    GooseAdapter = mod.GooseAdapter;
  });

  /**
   * Helper: create a GooseAdapter with a mock process and complete init.
   * Returns the adapter, mock process, and a message collector.
   */
  async function createInitializedAdapter(options?: {
    model?: string;
    cwd?: string;
  }): Promise<{
    adapter: InstanceType<typeof GooseAdapter>;
    proc: MockGooseProcess;
    messages: BrowserIncomingMessage[];
  }> {
    const proc = new MockGooseProcess();
    const messages: BrowserIncomingMessage[] = [];

    // Create adapter — this triggers initialize() automatically
    const adapter = new GooseAdapter(proc as any, "test-session-123", {
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
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false },
          },
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
        result: {
          sessionId: "goose-session-abc",
          models: { current: "claude-sonnet-4-5-20250929", available: [] },
        },
      });
    }

    // Wait for init to complete (session_init emitted, model set, etc.)
    await new Promise((r) => setTimeout(r, 50));

    return { adapter, proc, messages };
  }

  it("performs ACP initialization handshake", async () => {
    const proc = new MockGooseProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new GooseAdapter(proc as any, "test-session-1", {
      model: "gpt-4o",
      cwd: "/tmp/test",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await new Promise((r) => setTimeout(r, 10));

    // Verify the initialize request was sent
    const sent = proc.getAllSent();
    const initReq = sent.find((m) => m.method === "initialize");
    expect(initReq).toBeTruthy();
    expect(initReq?.jsonrpc).toBe("2.0");
    expect((initReq?.params as any)?.clientInfo?.name).toBe("campfire");
  });

  it("emits session_init after successful initialization", async () => {
    const { messages } = await createInitializedAdapter();

    // Find session_init message
    const initMsg = messages.find((m) => m.type === "session_init");
    expect(initMsg).toBeTruthy();
    if (initMsg?.type === "session_init") {
      expect(initMsg.session.backend_type).toBe("goose");
      expect(initMsg.session.session_id).toBe("test-session-123");
      expect(initMsg.session.model).toBe("claude-sonnet-4-5-20250929");
      expect(initMsg.session.cwd).toBe("/tmp/test-project");
    }
  });

  it("translates agentMessageChunk to stream_event", async () => {
    const { proc, messages } = await createInitializedAdapter();

    // Clear init messages
    messages.length = 0;

    // Inject an agentMessageChunk notification
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "goose-session-abc",
        update: {
          sessionUpdate: "agentMessageChunk",
          content: { type: "text", text: "Hello, " },
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
      expect((deltaEvent as any).event?.delta?.text).toBe("Hello, ");
    }
  });

  it("translates toolCall to assistant message with tool_use", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // Inject a toolCall notification
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "goose-session-abc",
        update: {
          sessionUpdate: "toolCall",
          id: "tool-call-1",
          toolName: "developer__bash",
          arguments: { command: "ls -la" },
          status: "Pending",
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
      // developer__bash maps to "Bash"
      expect(toolBlock.name).toBe("Bash");
      expect(toolBlock.input.command).toBe("ls -la");
    }
  });

  it("translates toolCallUpdate to tool_result", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // First inject toolCall
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "goose-session-abc",
        update: {
          sessionUpdate: "toolCall",
          id: "tool-call-2",
          toolName: "developer__text_editor",
          arguments: { path: "/tmp/test.txt" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Then inject toolCallUpdate
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "goose-session-abc",
        update: {
          sessionUpdate: "toolCallUpdate",
          id: "tool-call-2",
          result: "File written successfully",
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

  it("translates actionRequired to permission_request", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // Inject actionRequired notification
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        sessionId: "goose-session-abc",
        update: {
          sessionUpdate: "actionRequired",
          data: {
            actionType: "toolConfirmation",
            id: "perm-req-1",
            toolName: "developer__bash",
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

  it("maps Goose tool names to Campfire-compatible names", async () => {
    const { proc, messages } = await createInitializedAdapter();
    messages.length = 0;

    // developer__bash → Bash
    proc.injectResponse({
      jsonrpc: "2.0",
      method: "session/notification",
      params: {
        update: {
          sessionUpdate: "toolCall",
          id: "t1",
          toolName: "developer__bash",
          arguments: {},
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    const toolMsg = messages.find(
      (m) => m.type === "assistant" && (m as any).message?.content?.some(
        (b: any) => b.type === "tool_use" && b.name === "Bash"
      )
    );
    expect(toolMsg).toBeTruthy();
  });

  it("queues user messages before initialization completes", async () => {
    const proc = new MockGooseProcess();
    const messages: BrowserIncomingMessage[] = [];

    const adapter = new GooseAdapter(proc as any, "test-queue", {
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

  it("emits error on init failure", async () => {
    const proc = new MockGooseProcess();
    const messages: BrowserIncomingMessage[] = [];
    let initError: string | null = null;

    const adapter = new GooseAdapter(proc as any, "test-fail", {
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
        error: { code: -1, message: "Provider not configured" },
      });
    }

    await new Promise((r) => setTimeout(r, 50));

    // Should have emitted an error
    expect(initError).toBeTruthy();
    expect(initError).toContain("Goose initialization failed");

    const errorMsg = messages.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
  });

  it("returns false for messages when init has failed", async () => {
    const proc = new MockGooseProcess();
    const adapter = new GooseAdapter(proc as any, "test-fail-2", {
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
});
