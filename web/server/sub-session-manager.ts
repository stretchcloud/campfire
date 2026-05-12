import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { BackendType, BrowserIncomingMessage, CLIResultMessage, SubAgentUpdate } from "./session-types.js";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";

export interface SubSessionOptions {
  timeoutMs?: number;
  toolUseId?: string;
  name?: string;
  description?: string;
  model?: string;
  permissionMode?: string;
}

export interface SubSessionResult {
  sessionId: string;
  backendType: BackendType;
  text: string;
  filesChanged: string[];
  costUsd: number;
  durationMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitLines(args: string[], cwd: string): string[] {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getChangedFiles(cwd: string): string[] {
  const names = new Set<string>();
  for (const file of gitLines(["diff", "--name-only"], cwd)) names.add(file);
  for (const file of gitLines(["diff", "--name-only", "--cached"], cwd)) names.add(file);
  for (const line of gitLines(["ls-files", "--others", "--exclude-standard"], cwd)) names.add(line);
  return Array.from(names).sort();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string; content?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      if (typed.type === "tool_result") return textFromContent(typed.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssistantText(messages: BrowserIncomingMessage[]): string {
  const chunks: string[] = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const text = textFromContent(msg.message.content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

function findResult(messages: BrowserIncomingMessage[], afterIndex: number): CLIResultMessage | null {
  for (const msg of messages.slice(afterIndex)) {
    if (msg.type === "result") return msg.data;
  }
  return null;
}

function inheritedEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  return { ...env };
}

export class SubSessionManager {
  private readonly childrenByParent = new Map<string, Set<string>>();

  constructor(
    private readonly launcher: CliLauncher,
    private readonly wsBridge: WsBridge,
  ) {}

  getChildSessions(parentSessionId: string): string[] {
    return Array.from(this.childrenByParent.get(parentSessionId) ?? []);
  }

  async spawnSubSession(
    parentSessionId: string,
    backendType: BackendType,
    prompt: string,
    cwd: string,
    opts: SubSessionOptions = {},
  ): Promise<SubSessionResult> {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const toolUseId = opts.toolUseId ?? `subagent-${randomUUID()}`;
    const name = opts.name ?? `Ask ${backendType}`;
    const description = opts.description ?? prompt.slice(0, 160);

    const runningUpdate: SubAgentUpdate = {
      parentSessionId,
      toolUseId,
      backendType,
      name,
      description,
      status: "running",
      startedAt,
    };
    this.wsBridge.broadcastSubAgentUpdate(parentSessionId, runningUpdate);

    const parentSession = this.launcher.getSession(parentSessionId);
    const info = this.launcher.launch({
      cwd,
      backendType,
      model: opts.model,
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      env: inheritedEnv(parentSession?.sessionEnv),
      parentSessionId,
      orchestrationRole: "subagent",
    });
    this.wsBridge.markSessionOrchestration(info.sessionId, {
      parentSessionId,
      role: "subagent",
      detectedEnvironment: info.detectedEnvironment,
    });
    this.trackChild(parentSessionId, info.sessionId);

    this.wsBridge.broadcastSubAgentUpdate(parentSessionId, {
      ...runningUpdate,
      sessionId: info.sessionId,
    });

    let error: string | undefined;
    try {
      await this.waitForConnection(info.sessionId, Math.min(15_000, timeoutMs));
      const session = this.wsBridge.getSession(info.sessionId);
      const startIndex = session?.messageHistory.length ?? 0;
      this.wsBridge.injectUserMessage(info.sessionId, prompt);

      const result = await this.waitForResult(info.sessionId, startIndex, timeoutMs - (Date.now() - startedAt));
      if (result.is_error) {
        error = result.errors?.join("\n") || result.result || "Sub-agent returned an error result.";
      }

      const resultSession = this.wsBridge.getSession(info.sessionId);
      const messages = resultSession?.messageHistory ?? [];
      const text = extractAssistantText(messages) || result.result || "";
      const filesChanged = getChangedFiles(cwd);
      const costUsd = result.total_cost_usd || resultSession?.state.total_cost_usd || 0;
      const durationMs = Date.now() - startedAt;
      if (costUsd > 0) this.wsBridge.addSubAgentCost(parentSessionId, costUsd);

      const finalResult: SubSessionResult = {
        sessionId: info.sessionId,
        backendType,
        text,
        filesChanged,
        costUsd,
        durationMs,
        error,
      };
      const completedUpdate: SubAgentUpdate = {
        ...runningUpdate,
        sessionId: info.sessionId,
        status: error ? "failed" : "completed",
        completedAt: Date.now(),
        costUsd,
        durationMs,
        filesChanged,
        summary: text.slice(0, 500),
        error,
      };
      this.wsBridge.broadcastSubAgentUpdate(parentSessionId, completedUpdate);
      void this.applyGeneratedSubAgentName(parentSessionId, info.sessionId, completedUpdate, prompt, opts.model ?? backendType);
      return finalResult;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("Timed out");
      error = err instanceof Error ? err.message : String(err);
      this.wsBridge.broadcastSubAgentUpdate(parentSessionId, {
        ...runningUpdate,
        sessionId: info.sessionId,
        status: isTimeout ? "timeout" : "failed",
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        filesChanged: getChangedFiles(cwd),
        error,
      });
      return {
        sessionId: info.sessionId,
        backendType,
        text: "",
        filesChanged: getChangedFiles(cwd),
        costUsd: 0,
        durationMs: Date.now() - startedAt,
        error,
      };
    } finally {
      await this.launcher.kill(info.sessionId).catch(() => false);
      this.launcher.markSessionExited(info.sessionId, error ? 1 : 0);
    }
  }

  private trackChild(parentSessionId: string, childSessionId: string): void {
    let children = this.childrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      this.childrenByParent.set(parentSessionId, children);
    }
    children.add(childSessionId);
  }

  private async applyGeneratedSubAgentName(
    parentSessionId: string,
    childSessionId: string,
    completedUpdate: SubAgentUpdate,
    prompt: string,
    model: string,
  ): Promise<void> {
    const existing = sessionNames.getName(childSessionId);
    const title = existing ?? await generateSessionTitle(prompt, model, { timeoutMs: 15_000 });
    if (!title) return;
    if (!existing) sessionNames.setName(childSessionId, title);
    this.wsBridge.broadcastNameUpdate(childSessionId, title);
    this.wsBridge.broadcastSubAgentUpdate(parentSessionId, {
      ...completedUpdate,
      name: title,
    });
  }

  private async waitForConnection(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.wsBridge.isCliConnected(sessionId)) return;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for sub-session ${sessionId} to connect.`);
  }

  private async waitForResult(sessionId: string, startIndex: number, timeoutMs: number): Promise<CLIResultMessage> {
    const deadline = Date.now() + Math.max(timeoutMs, 1);
    while (Date.now() < deadline) {
      const session = this.wsBridge.getSession(sessionId);
      const result = session ? findResult(session.messageHistory as BrowserIncomingMessage[], startIndex) : null;
      if (result) return result;
      await sleep(POLL_MS);
    }
    throw new Error(`Timed out waiting for sub-session ${sessionId} to finish.`);
  }
}
