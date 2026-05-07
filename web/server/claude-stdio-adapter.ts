import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { AgentAdapter, AdapterSessionMeta } from "./adapter-types.js";
import type { RecorderManager } from "./recorder.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  McpServerDetail,
  PermissionRequest,
  SessionState,
} from "./session-types.js";

export interface ClaudeStdioAdapterOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  recorder?: RecorderManager;
}

class NdjsonTransport {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private connected = true;
  private rawInCb: ((line: string) => void) | null = null;
  private rawOutCb: ((line: string) => void) | null = null;
  private messageCb: ((msg: CLIMessage) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number | Promise<number> },
    stdout: ReadableStream<Uint8Array>,
  ) {
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      writable = new WritableStream({
        async write(chunk) {
          await (stdin as { write(data: Uint8Array): number | Promise<number> }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    this.writer = writable.getWriter();
    this.readStdout(stdout);
  }

  onRawIncoming(cb: (line: string) => void): void {
    this.rawInCb = cb;
  }

  onRawOutgoing(cb: (line: string) => void): void {
    this.rawOutCb = cb;
  }

  onMessage(cb: (msg: CLIMessage) => void): void {
    this.messageCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async write(msg: unknown): Promise<void> {
    if (!this.connected) throw new Error("Transport closed");
    const line = JSON.stringify(msg);
    this.rawOutCb?.(line);
    await this.writer.write(new TextEncoder().encode(line + "\n"));
  }

  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.writer.close();
    } catch {}
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
      console.error("[claude-stdio-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
      this.disconnectCb?.();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.rawInCb?.(trimmed);

      let msg: CLIMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        console.warn("[claude-stdio-adapter] Failed to parse NDJSON:", trimmed.substring(0, 200));
        continue;
      }
      this.messageCb?.(msg);
    }
  }
}

export class ClaudeStdioAdapter implements AgentAdapter {
  private transport: NdjsonTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: ClaudeStdioAdapterOptions;
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: AdapterSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;
  private backendSessionId: string | null = null;
  private pendingControlRequests = new Map<string, "mcp_status">();

  constructor(proc: Subprocess, sessionId: string, options: ClaudeStdioAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    if (!proc.stdin || typeof proc.stdin === "number" || !proc.stdout || typeof proc.stdout === "number") {
      throw new Error("Claude stdio adapter requires piped stdin and stdout");
    }

    this.transport = new NdjsonTransport(proc.stdin, proc.stdout);
    this.transport.onRawIncoming((line) => {
      this.options.recorder?.record(this.sessionId, "in", line, "cli", "claude", this.options.cwd ?? "");
    });
    this.transport.onRawOutgoing((line) => {
      this.options.recorder?.record(this.sessionId, "out", line, "cli", "claude", this.options.cwd ?? "");
    });
    this.transport.onMessage((msg) => this.handleCLIMessage(msg));
    this.transport.onDisconnect(() => this.disconnectCb?.());
  }

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    try {
      switch (msg.type) {
        case "user_message":
          this.sendUserMessage(msg);
          return true;
        case "permission_response":
          this.sendPermissionResponse(msg);
          return true;
        case "interrupt":
          this.sendControlRequest({ subtype: "interrupt" });
          return true;
        case "set_model":
          this.sendControlRequest({ subtype: "set_model", model: msg.model });
          return true;
        case "set_permission_mode":
          this.sendControlRequest({ subtype: "set_permission_mode", mode: msg.mode });
          return true;
        case "mcp_get_status":
          this.sendMcpStatusRequest();
          return true;
        case "mcp_toggle":
          this.sendControlRequest({ subtype: "mcp_toggle", serverName: msg.serverName, enabled: msg.enabled });
          setTimeout(() => this.sendMcpStatusRequest(), 500);
          return true;
        case "mcp_reconnect":
          this.sendControlRequest({ subtype: "mcp_reconnect", serverName: msg.serverName });
          setTimeout(() => this.sendMcpStatusRequest(), 1000);
          return true;
        case "mcp_set_servers":
          this.sendControlRequest({ subtype: "mcp_set_servers", servers: msg.servers });
          setTimeout(() => this.sendMcpStatusRequest(), 2000);
          return true;
        default:
          return false;
      }
    } catch (err) {
      console.warn("[claude-stdio-adapter] Failed to send browser message:", err);
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
    return this.transport.isConnected();
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }

  getBackendSessionId(): string | null {
    return this.backendSessionId;
  }

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  private sendRaw(msg: unknown): void {
    this.transport.write(msg).catch((err) => {
      console.warn("[claude-stdio-adapter] Failed to write NDJSON:", err);
    });
  }

  private buildUserContent(msg: Extract<BrowserOutgoingMessage, { type: "user_message" }>): string | unknown[] {
    if (!msg.images?.length) return msg.content;

    const blocks: unknown[] = msg.images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    }));
    blocks.push({ type: "text", text: msg.content });
    return blocks;
  }

  private sendUserMessage(msg: Extract<BrowserOutgoingMessage, { type: "user_message" }>): void {
    this.sendRaw({
      type: "user",
      message: { role: "user", content: this.buildUserContent(msg) },
      parent_tool_use_id: null,
      session_id: msg.session_id || this.backendSessionId || "",
    });
  }

  private sendPermissionResponse(msg: Extract<BrowserOutgoingMessage, { type: "permission_response" }>): void {
    const response: Record<string, unknown> = msg.behavior === "allow"
      ? { behavior: "allow", updatedInput: msg.updated_input ?? {} }
      : { behavior: "deny", message: msg.message || "Denied by user" };

    if (msg.behavior === "allow" && msg.updated_permissions?.length) {
      response.updatedPermissions = msg.updated_permissions;
    }

    this.sendRaw({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response,
      },
    });
  }

  private sendControlRequest(request: Record<string, unknown>, requestId = randomUUID()): string {
    this.sendRaw({
      type: "control_request",
      request_id: requestId,
      request,
    });
    return requestId;
  }

  private sendMcpStatusRequest(): void {
    const requestId = this.sendControlRequest({ subtype: "mcp_status" });
    this.pendingControlRequests.set(requestId, "mcp_status");
  }

  private handleCLIMessage(msg: CLIMessage): void {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(msg);
        break;
      case "assistant":
        this.handleAssistantMessage(msg);
        break;
      case "result":
        this.emit({ type: "result", data: msg });
        break;
      case "stream_event":
        this.handleStreamEvent(msg);
        break;
      case "control_request":
        this.handleControlRequest(msg);
        break;
      case "tool_progress":
        this.handleToolProgress(msg);
        break;
      case "tool_use_summary":
        this.handleToolUseSummary(msg);
        break;
      case "auth_status":
        this.handleAuthStatus(msg);
        break;
      case "control_response":
        this.handleControlResponse(msg);
        break;
      case "keep_alive":
        break;
    }
  }

  private handleSystemMessage(msg: CLISystemInitMessage | CLISystemStatusMessage): void {
    if (msg.subtype === "init") {
      this.backendSessionId = msg.session_id;
      this.sessionMetaCb?.({ cliSessionId: msg.session_id, model: msg.model, cwd: msg.cwd });
      this.emit({
        type: "session_init",
        session: this.toSessionState(msg),
      });
      return;
    }

    if (msg.permissionMode) {
      this.emit({ type: "session_update", session: { permissionMode: msg.permissionMode } });
    }
    this.emit({ type: "status_change", status: msg.status ?? null });
  }

  private toSessionState(msg: CLISystemInitMessage): SessionState {
    return {
      session_id: this.sessionId,
      backend_type: "claude",
      model: msg.model,
      cwd: msg.cwd,
      tools: msg.tools,
      permissionMode: msg.permissionMode,
      claude_code_version: msg.claude_code_version,
      mcp_servers: msg.mcp_servers,
      agents: msg.agents ?? [],
      slash_commands: msg.slash_commands ?? [],
      skills: msg.skills ?? [],
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
  }

  private handleAssistantMessage(msg: CLIAssistantMessage): void {
    this.emit({
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    });
  }

  private handleStreamEvent(msg: CLIStreamEventMessage): void {
    this.emit({
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(msg: CLIControlRequestMessage): void {
    if (msg.request.subtype !== "can_use_tool") return;
    const request: PermissionRequest = {
      request_id: msg.request_id,
      tool_name: msg.request.tool_name,
      input: msg.request.input,
      permission_suggestions: msg.request.permission_suggestions,
      description: msg.request.description,
      tool_use_id: msg.request.tool_use_id,
      agent_id: msg.request.agent_id,
      timestamp: Date.now(),
    };
    this.emit({ type: "permission_request", request });
  }

  private handleToolProgress(msg: CLIToolProgressMessage): void {
    this.emit({
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(msg: CLIToolUseSummaryMessage): void {
    this.emit({
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleAuthStatus(msg: CLIAuthStatusMessage): void {
    this.emit({
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  private handleControlResponse(msg: CLIControlResponseMessage): void {
    const requestId = msg.response.request_id;
    const pending = this.pendingControlRequests.get(requestId);
    if (!pending) return;
    this.pendingControlRequests.delete(requestId);

    if (msg.response.subtype === "error") {
      console.warn(`[claude-stdio-adapter] Control request ${pending} failed: ${msg.response.error}`);
      return;
    }

    if (pending === "mcp_status") {
      const servers = (msg.response.response as { mcpServers?: McpServerDetail[] } | undefined)?.mcpServers ?? [];
      this.emit({ type: "mcp_status", servers });
    }
  }
}
