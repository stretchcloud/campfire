/**
 * OpenCode ACP (Agent Client Protocol) Adapter
 *
 * Translates between the OpenCode ACP JSON-RPC protocol (stdin/stdout)
 * and Campfire's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code, Codex, Goose,
 * or OpenCode is the backend.
 *
 * Protocol reference:
 *   - OpenCode ACP uses JSON-RPC 2.0 over stdio (newline-delimited)
 *   - Methods: initialize, session/new, session/load, session/prompt,
 *     session/cancel, session/set_mode
 *   - Notifications: session/update with SessionUpdate payloads (kind field)
 *   - Permission: session/request_permission (JSON-RPC request, not notification)
 *     Client responds via JSON-RPC respond() with outcome field
 *
 * Key differences from Goose:
 *   - Notification method is "session/update" (not "session/notification")
 *   - Update kind field is update.kind (not update.sessionUpdate)
 *   - Update type strings use snake_case: agent_message_chunk, tool_call, etc.
 *   - Permissions use JSON-RPC request/response (not notification-based)
 *   - protocolVersion is numeric (1) not string ("v1")
 *   - clientCapabilities includes fs and terminal capabilities
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  PermissionRequest,
  CLIResultMessage,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import type { AgentAdapter } from "./adapter-types.js";

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── Adapter Options ─────────────────────────────────────────────────────────

export interface OpenCodeAdapterOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  /** If provided, resume an existing session instead of starting a new one. */
  opencodeSessionId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
}

// ─── JSON-RPC Transport ──────────────────────────────────────────────────────
// Same transport pattern as GooseAdapter and CodexAdapter.

class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;
  private rawInCb: ((line: string) => void) | null = null;
  private rawOutCb: ((data: string) => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  private buffer = "";

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
  ) {
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    this.writer = writable.getWriter();
    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (err) {
      console.error("[opencode-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
      for (const [, { reject }] of this.pending) {
        reject(new Error("Transport closed"));
      }
      this.pending.clear();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      this.rawInCb?.(trimmed);

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        console.warn("[opencode-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
        continue;
      }

      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        // Request FROM the server (needs a response)
        this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
      } else {
        // Response to one of our requests
        const pending = this.pending.get(msg.id as number);
        if (pending) {
          this.pending.delete(msg.id as number);
          const resp = msg as JsonRpcResponse;
          if (resp.error) {
            pending.reject(new Error(resp.error.message));
          } else {
            pending.resolve(resp.result);
          }
        }
      }
    } else if ("method" in msg) {
      this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
    }
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request = JSON.stringify({ jsonrpc: "2.0", method, id, params });
      try {
        await this.writeRaw(request + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const notification = JSON.stringify({ jsonrpc: "2.0", method, params });
    await this.writeRaw(notification + "\n");
  }

  async respond(id: number, result: unknown): Promise<void> {
    const response = JSON.stringify({ jsonrpc: "2.0", id, result });
    await this.writeRaw(response + "\n");
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void {
    this.requestHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onRawIncoming(cb: (line: string) => void): void {
    this.rawInCb = cb;
  }

  onRawOutgoing(cb: (data: string) => void): void {
    this.rawOutCb = cb;
  }

  private async writeRaw(data: string): Promise<void> {
    if (!this.connected) {
      throw new Error("Transport closed");
    }
    this.rawOutCb?.(data);
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── OpenCode Adapter ────────────────────────────────────────────────────────

export class OpenCodeAdapter implements AgentAdapter {
  private transport: JsonRpcTransport;
  private proc: Subprocess;
  private sessionId: string; // Campfire session ID
  private options: OpenCodeAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // State
  private opencodeSessionId: string | null = null; // OpenCode's internal session ID
  private connected = false;
  private initialized = false;
  private initFailed = false;

  // Streaming accumulator
  private streamingText = "";
  private streamingActive = false;

  // Tool call tracking
  private activeToolCalls = new Map<string, { toolName: string; startTime: number }>();

  // Permission request tracking (request_id → JSON-RPC id for respond())
  private pendingPermissions = new Map<string, number>();

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  constructor(proc: Subprocess, sessionId: string, options: OpenCodeAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("OpenCode process must have stdio pipes");
    }

    this.transport = new JsonRpcTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
    );
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Wire raw message recording
    if (options.recorder) {
      const recorder = options.recorder;
      const cwd = options.cwd || "";
      this.transport.onRawIncoming((line) => {
        recorder.record(sessionId, "in", line, "cli", "opencode", cwd);
      });
      this.transport.onRawOutgoing((data) => {
        recorder.record(sessionId, "out", data.trimEnd(), "cli", "opencode", cwd);
      });
    }

    // Monitor process exit
    proc.exited.then(() => {
      this.connected = false;
      this.disconnectCb?.();
    });

    // Start initialization
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    if (this.initFailed) return false;

    // Queue messages if not yet initialized
    if (!this.initialized || !this.opencodeSessionId) {
      if (
        msg.type === "user_message"
        || msg.type === "permission_response"
      ) {
        console.log(`[opencode-adapter] Queuing ${msg.type} — adapter not yet initialized`);
        this.pendingOutgoing.push(msg);
        return true;
      }
      if (!this.connected) return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.handleOutgoingUserMessage(msg);
        return true;
      case "permission_response":
        this.handleOutgoingPermissionResponse(msg);
        return true;
      case "interrupt":
        this.handleOutgoingInterrupt();
        return true;
      case "set_model":
        this.handleOutgoingSetModel(msg.model);
        return true;
      case "set_permission_mode":
        console.warn("[opencode-adapter] Runtime permission mode switching not yet supported for OpenCode");
        return false;
      case "mcp_get_status":
      case "mcp_toggle":
      case "mcp_reconnect":
      case "mcp_set_servers":
        console.warn(`[opencode-adapter] MCP management (${msg.type}) not yet supported for OpenCode`);
        return false;
      default:
        return false;
    }
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([
        this.proc.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {}
  }

  getBackendSessionId(): string | null {
    return this.opencodeSessionId;
  }

  // ── Initialization ─────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      // Step 1: ACP initialize handshake
      // OpenCode uses numeric protocolVersion (1) and richer clientCapabilities
      const initResult = await this.transport.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: true,
        },
        clientInfo: {
          name: "campfire",
          title: "Campfire",
          version: "1.0.0",
        },
      }) as Record<string, unknown>;

      this.connected = true;
      this.initialized = true;

      // Extract capabilities
      const capabilities = initResult?.agentCapabilities as Record<string, unknown> || {};
      const hasLoadSession = capabilities.loadSession === true;

      // Step 2: Create or load a session
      if (this.options.opencodeSessionId && hasLoadSession) {
        // Resume existing session
        await this.transport.call("session/load", {
          sessionId: this.options.opencodeSessionId,
          cwd: this.options.cwd || process.cwd(),
        });
        this.opencodeSessionId = this.options.opencodeSessionId;
      } else {
        // Create new session
        const newResult = await this.transport.call("session/new", {
          cwd: this.options.cwd || process.cwd(),
          mcpServers: [],
        }) as Record<string, unknown>;
        this.opencodeSessionId = newResult?.sessionId as string || randomUUID();
      }

      // Notify session metadata
      this.sessionMetaCb?.({
        cliSessionId: this.opencodeSessionId,
        model: this.options.model,
        cwd: this.options.cwd,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "opencode",
        model: this.options.model || "default",
        cwd: this.options.cwd || "",
        tools: ["bash", "file_read", "file_write", "file_edit"],
        permissionMode: this.options.permissionMode || "default",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      total_duration_api_ms: 0,
      };

      this.emit({ type: "session_init", session: state });

      // Flush queued messages
      if (this.pendingOutgoing.length > 0) {
        console.log(`[opencode-adapter] Flushing ${this.pendingOutgoing.length} queued message(s)`);
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const errorMsg = `OpenCode initialization failed: ${err}`;
      console.error(`[opencode-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      this.pendingOutgoing.length = 0;
      this.emit({ type: "error", message: errorMsg });
      this.initErrorCb?.(errorMsg);
    }
  }

  // ── Outgoing message handlers ──────────────────────────────────────────

  private async handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; images?: { media_type: string; data: string }[] },
  ): Promise<void> {
    if (!this.opencodeSessionId) {
      this.emit({ type: "error", message: "No OpenCode session started yet" });
      return;
    }

    const content: Array<Record<string, unknown>> = [];

    // Add images if present
    if (msg.images?.length) {
      for (const img of msg.images) {
        content.push({
          type: "image",
          data: img.data,
          media_type: img.media_type,
        });
      }
    }

    // Add text
    content.push({ type: "text", text: msg.content });

    try {
      // session/prompt is async — OpenCode streams notifications then returns
      const result = await this.transport.call("session/prompt", {
        sessionId: this.opencodeSessionId,
        content,
      }) as Record<string, unknown>;

      // The response comes after all streaming is done
      this.finishTurn(result);
    } catch (err) {
      this.emit({ type: "error", message: `Failed to send prompt: ${err}` });
      this.emitResult("error_during_execution", true);
    }
  }

  private async handleOutgoingPermissionResponse(
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny" },
  ): Promise<void> {
    // OpenCode uses JSON-RPC request/response (not notification-based like Goose).
    // We stored the rpc id when the permission request arrived, and now respond to it.
    const rpcId = this.pendingPermissions.get(msg.request_id);
    if (rpcId !== undefined) {
      try {
        await this.transport.respond(rpcId, {
          outcome: msg.behavior === "allow" ? "allow_once" : "reject_once",
        });
        this.pendingPermissions.delete(msg.request_id);
      } catch (err) {
        console.warn(`[opencode-adapter] Failed to send permission response: ${err}`);
      }
    } else {
      console.warn(`[opencode-adapter] No pending permission for request_id: ${msg.request_id}`);
    }
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    try {
      await this.transport.notify("session/cancel", {});
    } catch (err) {
      console.warn("[opencode-adapter] Cancel failed:", err);
    }
  }

  private async handleOutgoingSetModel(_model: string): Promise<void> {
    // OpenCode model selection is typically done at session creation via config.
    // Runtime model switching is not standardized in ACP for OpenCode.
    console.warn("[opencode-adapter] Runtime model switching not yet supported for OpenCode");
  }

  // ── Incoming notification handlers ─────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case "session/update":
          // OpenCode uses "session/update" (vs Goose's "session/notification")
          this.handleSessionUpdate(params);
          break;
        default:
          console.log(`[opencode-adapter] Unhandled notification: ${method}`);
          break;
      }
    } catch (err) {
      console.error(`[opencode-adapter] Error handling notification ${method}:`, err);
    }
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const update = params.update as Record<string, unknown>;
    if (!update) return;

    // OpenCode uses "kind" field (vs Goose's "sessionUpdate")
    const kind = update.kind as string;
    console.log(`[opencode-adapter] ← session/update: ${kind}`);

    switch (kind) {
      case "agent_message_chunk":
        this.handleAgentMessageChunk(update);
        break;
      case "agent_thought_chunk":
        this.handleAgentThoughtChunk(update);
        break;
      case "tool_call":
        this.handleToolCall(update);
        break;
      case "tool_call_update":
        this.handleToolCallUpdate(update);
        break;
      case "plan":
        // Planning steps — treat as thought chunks
        this.handlePlan(update);
        break;
      default:
        console.log(`[opencode-adapter] Unhandled session update kind: ${kind}`);
        break;
    }
  }

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    console.log(`[opencode-adapter] Received request: ${method}`);
    try {
      switch (method) {
        case "session/request_permission": {
          // OpenCode uses a proper JSON-RPC request for permissions (unlike Goose's notification).
          // We store the rpc id so we can respond when the browser sends a permission_response.
          const requestId = `opencode-perm-${randomUUID()}`;
          this.pendingPermissions.set(requestId, id);
          this.emitPermissionRequest(requestId, params);
          break;
        }
        case "fs/read_text_file": {
          // OpenCode may request file reads — respond with not-supported (it has its own file tools)
          this.transport.respond(id, { error: "fs/read_text_file not delegated to client" });
          break;
        }
        case "fs/write_text_file": {
          this.transport.respond(id, { error: "fs/write_text_file not delegated to client" });
          break;
        }
        default:
          console.log(`[opencode-adapter] Unhandled request: ${method}`);
          this.transport.respond(id, {});
          break;
      }
    } catch (err) {
      console.error(`[opencode-adapter] Error handling request ${method}:`, err);
    }
  }

  // ── SessionUpdate handlers ─────────────────────────────────────────────

  private handleAgentMessageChunk(update: Record<string, unknown>): void {
    const content = update.content as Record<string, unknown>;
    if (!content) return;

    const text = content.text as string || "";

    // Start streaming if not already active
    if (!this.streamingActive) {
      this.streamingActive = true;
      this.streamingText = "";

      // Emit message_start
      this.emit({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: this.makeMessageId("agent"),
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
        parent_tool_use_id: null,
      });

      // Emit content_block_start
      this.emit({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        parent_tool_use_id: null,
      });
    }

    this.streamingText += text;

    // Emit content_block_delta (matches Claude's streaming format)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      parent_tool_use_id: null,
    });
  }

  private handleAgentThoughtChunk(update: Record<string, unknown>): void {
    const content = update.content as Record<string, unknown>;
    if (!content) return;

    const thinking = content.thinking as string || content.text as string || content.thought as string || "";
    if (!thinking) return;

    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking },
      },
      parent_tool_use_id: null,
    });
  }

  private handlePlan(update: Record<string, unknown>): void {
    // OpenCode planning steps — emit as thinking block
    const steps = update.steps as unknown[];
    if (!steps?.length) return;

    const planText = Array.isArray(steps)
      ? steps.map((s: unknown) => {
          if (typeof s === "string") return `- ${s}`;
          if (typeof s === "object" && s !== null) return `- ${(s as Record<string, unknown>).description || JSON.stringify(s)}`;
          return `- ${String(s)}`;
        }).join("\n")
      : "";

    if (!planText) return;

    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: `Plan:\n${planText}` },
      },
      parent_tool_use_id: null,
    });
  }

  private handleToolCall(update: Record<string, unknown>): void {
    // Flush any active text streaming before tool call
    this.flushStreaming();

    const toolName = update.toolName as string || update.tool_name as string || "unknown";
    const args = update.arguments as Record<string, unknown> || update.args as Record<string, unknown> || {};
    const toolCallId = update.id as string || update.tool_call_id as string || `opencode-tool-${randomUUID()}`;

    this.activeToolCalls.set(toolCallId, { toolName, startTime: Date.now() });

    // Map OpenCode tool names to Campfire-compatible names
    const mappedName = this.mapToolName(toolName);

    // Emit stream event for tool_use start
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolCallId, name: mappedName, input: {} },
      },
      parent_tool_use_id: null,
    });

    // Emit the tool_use assistant message
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_use", toolCallId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolCallId,
            name: mappedName,
            input: args,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    // Emit tool_progress
    this.emit({
      type: "tool_progress",
      tool_use_id: toolCallId,
      tool_name: mappedName,
      elapsed_time_seconds: 0,
    });
  }

  private handleToolCallUpdate(update: Record<string, unknown>): void {
    const toolCallId = update.id as string || update.tool_call_id as string || "";
    const result = update.result as string || update.content as string || update.output as string || "";
    const status = update.status as string || "completed";
    const isError = status === "failed" || status === "error";

    // Clean up tracking
    this.activeToolCalls.delete(toolCallId);

    // Emit tool result
    const safeContent = typeof result === "string" ? result : JSON.stringify(result);
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_result", toolCallId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: safeContent || (isError ? "Tool call failed" : "Tool call completed"),
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  /** Flush any in-progress text streaming (emit stop events). */
  private flushStreaming(): void {
    if (!this.streamingActive) return;

    // Emit content_block_stop + message_delta
    this.emit({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
    });
    this.emit({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: null },
        usage: { output_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    // Emit full assistant message if there's accumulated text
    if (this.streamingText) {
      this.emit({
        type: "assistant",
        message: {
          id: this.makeMessageId("agent"),
          type: "message",
          role: "assistant",
          model: this.options.model || "",
          content: [{ type: "text", text: this.streamingText }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
    }

    this.streamingText = "";
    this.streamingActive = false;
  }

  /** Called when session/prompt returns (turn completed). */
  private finishTurn(result: Record<string, unknown>): void {
    // Flush any remaining streaming
    this.flushStreaming();

    const stopReason = result?.stopReason as string || result?.stop_reason as string || "end_turn";

    this.emitResult(
      stopReason === "cancelled" ? "error_during_execution" : "success",
      stopReason === "cancelled",
    );
  }

  private emitResult(subtype: CLIResultMessage["subtype"], isError: boolean): void {
    const result: CLIResultMessage = {
      type: "result",
      subtype,
      is_error: isError,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: subtype === "success" ? "end_turn" : "error",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    this.emit({ type: "result", data: result });
  }

  private emitPermissionRequest(requestId: string, params: Record<string, unknown>): void {
    // ACP session/request_permission params contain toolCall info
    const toolCall = params.toolCall as Record<string, unknown> || params;
    const toolName = toolCall.toolName as string || toolCall.tool_name as string || "unknown";
    const args = toolCall.arguments as Record<string, unknown> || {};
    const description = toolCall.description as string || params.description as string;

    const mappedName = this.mapToolName(toolName);

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: mappedName,
      input: args,
      description: description || `OpenCode wants to use: ${mappedName}`,
      tool_use_id: (toolCall.id as string) || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  /** Map OpenCode tool names to Campfire-compatible tool names. */
  private mapToolName(toolName: string): string {
    // OpenCode tool names (may vary; pass-through for unknown tools)
    const toolMap: Record<string, string> = {
      "bash": "Bash",
      "file_read": "Read",
      "file_write": "Write",
      "file_edit": "Edit",
      "glob": "Glob",
      "grep": "Grep",
      // LSP-based tool names
      "lsp_diagnostics": "Diagnostics",
      "lsp_hover": "Hover",
      "lsp_definition": "Definition",
      "lsp_references": "References",
    };

    return toolMap[toolName] || toolName;
  }

  private makeMessageId(kind: string, sourceId?: string): string {
    if (sourceId) return `opencode-${kind}-${sourceId}`;
    return `opencode-${kind}-${randomUUID()}`;
  }
}
