/**
 * Aider Adapter
 *
 * Translates between Aider's unstructured CLI output (stdout/stdin)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * Aider has no structured protocol — it's a terminal tool. We spawn it with
 * `--no-pretty --yes --no-auto-commits` and parse stdout for:
 *   - SEARCH/REPLACE edit blocks → tool_use/tool_result
 *   - "Applied edit to {file}" → success tool_result
 *   - "Tokens: ..." → usage/result message
 *   - Other non-empty lines → streaming assistant text
 *   - Aider prompt ">" → turn complete
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  CLIResultMessage,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import type { AgentAdapter, AdapterSessionMeta } from "./adapter-types.js";

// ─── Adapter Options ─────────────────────────────────────────────────────────

export interface AiderAdapterOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  recorder?: RecorderManager;
}

// ─── Edit Block Parser State ─────────────────────────────────────────────────

interface EditBlock {
  file: string;
  search: string;
  replace: string;
}

type ParseState = "idle" | "search" | "divider" | "replace";

// ─── Aider Adapter ──────────────────────────────────────────────────────────

export class AiderAdapter implements AgentAdapter {
  private proc: Subprocess;
  private sessionId: string;
  private options: AiderAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: AdapterSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;

  // State
  private _connected = false;
  private streamingText = "";
  private streamingActive = false;

  // Edit block parsing
  private parseState: ParseState = "idle";
  private currentFile = "";
  private searchLines: string[] = [];
  private replaceLines: string[] = [];
  private editCounter = 0;

  // Prompt detection
  private lastLineWasPrompt = false;

  // Buffer for incomplete lines from stdout
  private stdoutBuffer = "";

  constructor(proc: Subprocess, sessionId: string, options: AiderAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("Aider process must have stdout pipe");
    }

    // Read stdout
    this.readStdout(stdout as ReadableStream<Uint8Array>);

    // Wire stderr for debugging
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.readStderr(stderr as ReadableStream<Uint8Array>);
    }

    // Monitor process exit
    proc.exited.then(() => {
      this._connected = false;
      this.flushStreaming();
      this.disconnectCb?.();
    });

    // Emit session_init immediately
    this._connected = true;
    this.emitInit();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.sendUserMessage(msg.content);
        return true;
      case "interrupt":
        this.proc.kill("SIGINT");
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
    return this._connected;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([
        this.proc.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {}
  }

  getBackendSessionId(): string | null {
    return null; // Aider has no session concept
  }

  // ── Initialization ─────────────────────────────────────────────────────

  private emitInit(): void {
    this.sessionMetaCb?.({
      model: this.options.model,
      cwd: this.options.cwd,
    });

    const state: SessionState = {
      session_id: this.sessionId,
      backend_type: "aider",
      model: this.options.model || "default",
      cwd: this.options.cwd || "",
      tools: [],
      permissionMode: "default",
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
    };

    this.emit({ type: "session_init", session: state });
  }

  // ── Outgoing ───────────────────────────────────────────────────────────

  private sendUserMessage(content: string): void {
    const stdin = this.proc.stdin;
    if (!stdin) return;

    // Record outgoing message
    if (this.options.recorder) {
      this.options.recorder.record(
        this.sessionId,
        "out",
        content,
        "cli",
        "aider",
        this.options.cwd || "",
      );
    }

    // Write message to stdin followed by newline
    const writer = (stdin as unknown as WritableStream<Uint8Array>).getWriter();
    writer.write(new TextEncoder().encode(content + "\n")).then(() => writer.releaseLock());
  }

  // ── Stdout parsing ─────────────────────────────────────────────────────

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });

        // Record raw incoming
        if (this.options.recorder) {
          this.options.recorder.record(
            this.sessionId,
            "in",
            text.replace(/\n$/, ""),
            "cli",
            "aider",
            this.options.cwd || "",
          );
        }

        this.stdoutBuffer += text;
        this.processStdoutBuffer();
      }
    } catch (err) {
      console.error("[aider-adapter] stdout reader error:", err);
    }
  }

  private processStdoutBuffer(): void {
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || ""; // Keep incomplete last line

    for (const line of lines) {
      this.processLine(line);
    }
  }

  /** Process a single line of aider output. */
  processLine(line: string): void {
    const trimmed = line.trim();

    // Detect aider prompt (turn complete)
    if (trimmed === ">" || trimmed.endsWith("> ") || trimmed === "aider>") {
      this.lastLineWasPrompt = true;
      this.flushStreaming();
      this.emitResult("success", false);
      return;
    }

    // Edit block detection: <<<<<<< SEARCH
    if (trimmed.startsWith("<<<<<<< SEARCH")) {
      this.flushStreaming();
      this.parseState = "search";
      this.searchLines = [];
      this.replaceLines = [];
      return;
    }

    // Edit block: separator
    if (this.parseState === "search" && trimmed === "=======") {
      this.parseState = "replace";
      return;
    }

    // Edit block: end
    if (this.parseState === "replace" && trimmed.startsWith(">>>>>>> REPLACE")) {
      this.parseState = "idle";
      const editBlock: EditBlock = {
        file: this.currentFile,
        search: this.searchLines.join("\n"),
        replace: this.replaceLines.join("\n"),
      };
      this.emitEditBlock(editBlock);
      return;
    }

    // Accumulate lines within edit blocks
    if (this.parseState === "search") {
      this.searchLines.push(line);
      return;
    }
    if (this.parseState === "replace") {
      this.replaceLines.push(line);
      return;
    }

    // File reference: "> filename" (appears before edit blocks)
    if (trimmed.startsWith("> ") && !trimmed.includes(" ") === false) {
      const possibleFile = trimmed.slice(2);
      // Only treat as file reference if it looks like a path
      if (possibleFile && !possibleFile.includes("  ") && (possibleFile.includes(".") || possibleFile.includes("/"))) {
        this.currentFile = possibleFile;
        return;
      }
    }

    // "Applied edit to {file}" — success indication
    if (trimmed.startsWith("Applied edit to ")) {
      const file = trimmed.slice("Applied edit to ".length);
      this.emitAppliedEdit(file);
      return;
    }

    // Token usage lines (e.g. "Tokens: 1.2k sent, 0.5k received.")
    if (trimmed.startsWith("Tokens:") || trimmed.startsWith("Cost:")) {
      // Don't stream these to chat — they're metadata
      return;
    }

    // Empty lines — skip during idle
    if (!trimmed) return;

    // Default: accumulate as streaming text
    this.lastLineWasPrompt = false;
    this.appendStreaming(trimmed);
  }

  // ── Streaming ──────────────────────────────────────────────────────────

  private appendStreaming(text: string): void {
    if (!this.streamingActive) {
      this.streamingActive = true;
      this.streamingText = "";

      // Emit message_start
      this.emit({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: `aider-msg-${randomUUID()}`,
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

    const chunk = (this.streamingText ? "\n" : "") + text;
    this.streamingText += chunk;

    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: chunk },
      },
      parent_tool_use_id: null,
    });
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
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    if (this.streamingText) {
      this.emit({
        type: "assistant",
        message: {
          id: `aider-msg-${randomUUID()}`,
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

  // ── Edit block emission ────────────────────────────────────────────────

  private emitEditBlock(edit: EditBlock): void {
    const toolUseId = `aider-edit-${++this.editCounter}`;

    // Emit tool_use (Edit tool)
    this.emit({
      type: "assistant",
      message: {
        id: `aider-tu-${toolUseId}`,
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Edit",
            input: {
              file_path: edit.file,
              old_string: edit.search,
              new_string: edit.replace,
            },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
  }

  private emitAppliedEdit(file: string): void {
    // Find most recent edit tool use ID for this file
    const toolUseId = `aider-edit-${this.editCounter}`;
    this.emit({
      type: "assistant",
      message: {
        id: `aider-tr-${toolUseId}`,
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: `Applied edit to ${file}`,
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
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

  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (line.trim()) {
            console.log(`[aider-adapter:stderr] ${line}`);
          }
        }
      }
    } catch {}
  }
}
