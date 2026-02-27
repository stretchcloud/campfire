/**
 * OpenHands ACP (Agent Client Protocol) Adapter
 *
 * OpenHands supports the same ACP protocol as Goose (`openhands acp`),
 * using JSON-RPC 2.0 over stdio. This adapter closely mirrors GooseAdapter
 * with OpenHands-specific tool name mappings and session handling.
 *
 * Protocol:
 *   - JSON-RPC 2.0 over stdio (newline-delimited)
 *   - Methods: initialize, session/new, session/prompt, session/cancel
 *   - Notifications: session/notification with SessionUpdate payloads
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
import type { AgentAdapter, AdapterSessionMeta } from "./adapter-types.js";

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

export interface OpenHandsAdapterOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  recorder?: RecorderManager;
}

// ─── JSON-RPC Transport (same as GooseAdapter) ──────────────────────────────

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
      console.error("[openhands-adapter] stdout reader error:", err);
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
        console.warn("[openhands-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
      } else {
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
    if (!this.connected) throw new Error("Transport closed");
    this.rawOutCb?.(data);
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── OpenHands Adapter ──────────────────────────────────────────────────────

export class OpenHandsAdapter implements AgentAdapter {
  private transport: JsonRpcTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: OpenHandsAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: AdapterSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // State
  private ohSessionId: string | null = null;
  private connected = false;
  private initialized = false;
  private initFailed = false;

  // Streaming
  private streamingText = "";
  private streamingActive = false;

  // Tool tracking
  private activeToolCalls = new Map<string, { toolName: string; startTime: number }>();

  // Pending outgoing messages (queued before init)
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  constructor(proc: Subprocess, sessionId: string, options: OpenHandsAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("OpenHands process must have stdio pipes");
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
        recorder.record(sessionId, "in", line, "cli", "openhands", cwd);
      });
      this.transport.onRawOutgoing((data) => {
        recorder.record(sessionId, "out", data.trimEnd(), "cli", "openhands", cwd);
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

    if (!this.initialized || !this.ohSessionId) {
      if (msg.type === "user_message" || msg.type === "permission_response") {
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
      case "interrupt":
        this.handleOutgoingInterrupt();
        return true;
      case "permission_response":
        this.handleOutgoingPermissionResponse(msg);
        return true;
      default:
        return false;
    }
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: AdapterSessionMeta) => void): void {
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
    return this.ohSessionId;
  }

  // ── Initialization ─────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      await this.transport.call("initialize", {
        protocolVersion: "v1",
        clientCapabilities: {},
        clientInfo: {
          name: "campfire",
          title: "Campfire",
          version: "1.0.0",
        },
      });

      this.connected = true;
      this.initialized = true;

      // Create session
      const newResult = await this.transport.call("session/new", {
        mcpServers: [],
        cwd: this.options.cwd || process.cwd(),
      }) as Record<string, unknown>;

      this.ohSessionId = newResult?.sessionId as string || randomUUID();

      this.sessionMetaCb?.({
        cliSessionId: this.ohSessionId,
        model: this.options.model,
        cwd: this.options.cwd,
      });

      // Emit session_init
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "openhands",
        model: this.options.model || "default",
        cwd: this.options.cwd || "",
        tools: ["bash", "edit", "read", "write"],
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
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const errorMsg = `OpenHands initialization failed: ${err}`;
      console.error(`[openhands-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      this.pendingOutgoing.length = 0;
      this.emit({ type: "error", message: errorMsg });
      this.initErrorCb?.(errorMsg);
    }
  }

  // ── Outgoing handlers ──────────────────────────────────────────────────

  private async handleOutgoingUserMessage(
    msg: { type: "user_message"; content: string; images?: { media_type: string; data: string }[] },
  ): Promise<void> {
    if (!this.ohSessionId) {
      this.emit({ type: "error", message: "No OpenHands session started yet" });
      return;
    }

    const prompt: Array<Record<string, unknown>> = [];
    if (msg.images?.length) {
      for (const img of msg.images) {
        prompt.push({ type: "image", data: img.data, media_type: img.media_type });
      }
    }
    prompt.push({ type: "text", text: msg.content });

    try {
      const result = await this.transport.call("session/prompt", {
        sessionId: this.ohSessionId,
        prompt,
      }) as Record<string, unknown>;

      this.finishTurn(result);
    } catch (err) {
      this.emit({ type: "error", message: `Failed to send prompt: ${err}` });
      this.emitResult("error_during_execution", true);
    }
  }

  private async handleOutgoingPermissionResponse(
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny" },
  ): Promise<void> {
    const permissionMap: Record<string, string> = {
      allow: "AllowOnce",
      deny: "RejectOnce",
    };
    try {
      await this.transport.notify("requestPermission", {
        id: msg.request_id,
        permission: permissionMap[msg.behavior] || "RejectOnce",
      });
    } catch (err) {
      console.warn(`[openhands-adapter] Failed to send permission response: ${err}`);
    }
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    try {
      await this.transport.notify("session/cancel", {});
    } catch (err) {
      console.warn("[openhands-adapter] Cancel failed:", err);
    }
  }

  // ── Incoming notification handlers ─────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    try {
      if (method === "session/notification") {
        this.handleSessionNotification(params);
      }
    } catch (err) {
      console.error(`[openhands-adapter] Error handling notification ${method}:`, err);
    }
  }

  private handleSessionNotification(params: Record<string, unknown>): void {
    const update = params.update as Record<string, unknown>;
    if (!update) return;

    const updateType = update.sessionUpdate as string;

    switch (updateType) {
      case "agentMessageChunk":
        this.handleAgentMessageChunk(update);
        break;
      case "agentThoughtChunk":
        this.handleAgentThoughtChunk(update);
        break;
      case "toolCall":
        this.handleToolCall(update);
        break;
      case "toolCallUpdate":
        this.handleToolCallUpdate(update);
        break;
      case "actionRequired":
        this.handleActionRequired(update);
        break;
      case "userMessageChunk":
        break; // Echo — ignore
      default:
        break;
    }
  }

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    if (method === "requestPermission") {
      const requestId = `oh-perm-${randomUUID()}`;
      const data = params.data as Record<string, unknown> || params;
      this.emitPermissionRequest(requestId, data);
    } else {
      this.transport.respond(id, {});
    }
  }

  // ── SessionUpdate handlers ─────────────────────────────────────────────

  private handleAgentMessageChunk(update: Record<string, unknown>): void {
    const content = update.content as Record<string, unknown>;
    if (!content) return;
    const text = content.text as string || "";

    if (!this.streamingActive) {
      this.streamingActive = true;
      this.streamingText = "";

      this.emit({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: `oh-msg-${randomUUID()}`,
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
    const thinking = content.thinking as string || content.text as string || "";
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

  private handleToolCall(update: Record<string, unknown>): void {
    this.flushStreaming();

    const toolName = update.toolName as string || "unknown";
    const args = update.arguments as Record<string, unknown> || {};
    const toolCallId = update.id as string || `oh-tool-${randomUUID()}`;

    this.activeToolCalls.set(toolCallId, { toolName, startTime: Date.now() });
    const mappedName = this.mapToolName(toolName);

    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolCallId, name: mappedName, input: {} },
      },
      parent_tool_use_id: null,
    });

    this.emit({
      type: "assistant",
      message: {
        id: `oh-tu-${toolCallId}`,
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [{ type: "tool_use", id: toolCallId, name: mappedName, input: args }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    this.emit({
      type: "tool_progress",
      tool_use_id: toolCallId,
      tool_name: mappedName,
      elapsed_time_seconds: 0,
    });
  }

  private handleToolCallUpdate(update: Record<string, unknown>): void {
    const toolCallId = update.id as string || "";
    const result = update.result as string || update.content as string || "";
    const status = update.status as string || "completed";
    const isError = status === "failed" || status === "error";

    this.activeToolCalls.delete(toolCallId);

    const safeContent = typeof result === "string" ? result : JSON.stringify(result);
    this.emit({
      type: "assistant",
      message: {
        id: `oh-tr-${toolCallId}`,
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

  private handleActionRequired(update: Record<string, unknown>): void {
    const data = update.data as Record<string, unknown>;
    if (!data) return;
    const actionType = data.actionType as string;
    if (actionType === "toolConfirmation") {
      const requestId = data.id as string || `oh-action-${randomUUID()}`;
      this.emitPermissionRequest(requestId, data);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  private flushStreaming(): void {
    if (!this.streamingActive) return;

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

    if (this.streamingText) {
      this.emit({
        type: "assistant",
        message: {
          id: `oh-msg-${randomUUID()}`,
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

  private finishTurn(result: Record<string, unknown>): void {
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

  private emitPermissionRequest(requestId: string, data: Record<string, unknown>): void {
    const toolName = data.toolName as string || "unknown";
    const args = data.arguments as Record<string, unknown> || {};
    const prompt = data.prompt as string || data.content as string;
    const mappedName = this.mapToolName(toolName);

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: mappedName,
      input: args,
      description: prompt || `OpenHands wants to use: ${mappedName}`,
      tool_use_id: data.toolCallId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private mapToolName(ohToolName: string): string {
    const toolMap: Record<string, string> = {
      "bash": "Bash",
      "execute_bash": "Bash",
      "str_replace_editor": "Edit",
      "edit": "Edit",
      "read": "Read",
      "write": "Write",
      "search": "Grep",
      "browser": "WebFetch",
    };
    return toolMap[ohToolName] || ohToolName;
  }
}
