import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeStdioAdapter } from "./claude-stdio-adapter.js";
import type { BrowserIncomingMessage } from "./session-types.js";

class MockWritableStream {
  chunks: string[] = [];
  private writer = {
    write: async (chunk: Uint8Array) => {
      this.chunks.push(new TextDecoder().decode(chunk));
    },
    close: async () => {},
    releaseLock: () => {},
  };
  getWriter() {
    return this.writer;
  }
}

class MockReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor() {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(data: string) {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }
}

function createMockProcess() {
  const stdin = new MockWritableStream();
  const stdout = new MockReadableStream();
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc = {
    stdin,
    stdout: stdout.stream,
    stderr: new ReadableStream<Uint8Array>(),
    pid: 123,
    exited,
    kill: vi.fn(),
  };
  return { proc, stdin, stdout, exit: resolveExit! };
}

function makeInitMsg() {
  return {
    type: "system",
    subtype: "init",
    session_id: "claude-internal-1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/repo",
    tools: ["Read", "Bash"],
    permissionMode: "default",
    claude_code_version: "2.1.132",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "default",
    uuid: "uuid-1",
    apiKeySource: "oauth",
  };
}

describe("ClaudeStdioAdapter", () => {
  let mock: ReturnType<typeof createMockProcess>;
  let messages: BrowserIncomingMessage[];
  let adapter: ClaudeStdioAdapter;

  beforeEach(() => {
    mock = createMockProcess();
    messages = [];
    adapter = new ClaudeStdioAdapter(mock.proc as never, "campfire-session-1", {
      model: "claude-sonnet-4-5-20250929",
      cwd: "/repo",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));
  });

  it("translates Claude system init to a Campfire session_init", async () => {
    mock.stdout.push(JSON.stringify(makeInitMsg()) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.getBackendSessionId()).toBe("claude-internal-1");
    expect(messages[0]).toMatchObject({
      type: "session_init",
      session: {
        session_id: "campfire-session-1",
        backend_type: "claude",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/repo",
        claude_code_version: "2.1.132",
      },
    });
  });

  it("translates assistant, stream, result, and permission messages", async () => {
    mock.stdout.push(JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "claude-internal-1",
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-3",
      session_id: "claude-internal-1",
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "control_request",
      request_id: "perm-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "pwd" },
        tool_use_id: "tool-1",
      },
    }) + "\n");
    mock.stdout.push(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 10,
      duration_api_ms: 5,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-4",
      session_id: "claude-internal-1",
    }) + "\n");
    await new Promise((r) => setTimeout(r, 20));

    expect(messages.map((msg) => msg.type)).toEqual([
      "assistant",
      "stream_event",
      "permission_request",
      "result",
    ]);
    expect(messages[2]).toMatchObject({
      type: "permission_request",
      request: { request_id: "perm-1", tool_name: "Bash", input: { command: "pwd" } },
    });
  });

  it("writes user, permission, interrupt, model, and MCP control NDJSON to stdin", async () => {
    adapter.sendBrowserMessage({ type: "user_message", content: "Run tests" });
    adapter.sendBrowserMessage({
      type: "permission_response",
      request_id: "perm-1",
      behavior: "allow",
      updated_input: { command: "pwd" },
    });
    adapter.sendBrowserMessage({ type: "interrupt" });
    adapter.sendBrowserMessage({ type: "set_model", model: "claude-opus-4-6" });
    adapter.sendBrowserMessage({ type: "mcp_get_status" });
    await new Promise((r) => setTimeout(r, 20));

    const written = mock.stdin.chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(written[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: "Run tests" },
    });
    expect(written[1]).toMatchObject({
      type: "control_response",
      response: {
        request_id: "perm-1",
        response: { behavior: "allow", updatedInput: { command: "pwd" } },
      },
    });
    expect(written[2].request).toMatchObject({ subtype: "interrupt" });
    expect(written[3].request).toMatchObject({ subtype: "set_model", model: "claude-opus-4-6" });
    expect(written[4].request).toMatchObject({ subtype: "mcp_status" });
  });
});
