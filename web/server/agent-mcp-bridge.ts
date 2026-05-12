import { randomUUID } from "node:crypto";
import type { BackendType, BrowserOutgoingMessage, CLIControlRequestMessage, PermissionRequest } from "./session-types.js";
import type { WsBridge } from "./ws-bridge.js";
import { backendFromAskTool, createAgentMcpServerConfig } from "./agent-mcp-tools.js";
import type { SubSessionManager, SubSessionResult } from "./sub-session-manager.js";

export interface AgentMcpBridgeOptions {
  port: number;
  packageRoot: string;
  token?: string;
  backends?: BackendType[];
}

type PermissionResponseMessage = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;
type PermissionResponder = (msg: PermissionResponseMessage) => void;

function backendFromCampfireMcpTool(toolName: string): BackendType | null {
  const parts = toolName.split(":");
  if (parts.length !== 3 || parts[0] !== "mcp") return null;
  const [, serverName, mcpToolName] = parts;
  if (serverName !== "campfire_agents" && serverName !== "campfire-agents") return null;
  return backendFromAskTool(mcpToolName);
}

export class AgentMcpBridge {
  readonly token: string;
  private readonly injectedSessions = new Set<string>();
  private readonly backends: BackendType[];

  constructor(
    private readonly wsBridge: WsBridge,
    private readonly subSessionManager: SubSessionManager,
    private readonly options: AgentMcpBridgeOptions,
  ) {
    this.token = options.token ?? randomUUID();
    this.backends = options.backends ?? ["codex", "goose", "aider", "openhands", "claude"];
    process.env.CAMPFIRE_INTERNAL_AGENT_MCP_TOKEN = this.token;
  }

  onSessionReady(sessionId: string, backendType: BackendType, cwd: string): void {
    if (!cwd || this.injectedSessions.has(sessionId)) return;
    const session = this.wsBridge.getSession(sessionId);
    if (session?.state.parent_session_id || session?.state.orchestration_role === "subagent" || session?.state.orchestration_role === "race_entry") return;
    if (!this.supportsRuntimeMcp(backendType)) return;
    if (process.env.CAMPFIRE_ENABLE_AGENT_MCP === "0") return;

    const config = createAgentMcpServerConfig({
      port: this.options.port,
      token: this.token,
      packageRoot: this.options.packageRoot,
      parentSessionId: sessionId,
      backends: this.backends.filter((backend) => backend !== backendType),
    });
    this.injectedSessions.add(sessionId);
    this.wsBridge.setMcpServers(sessionId, { campfire_agents: config });
  }

  handlePermissionRequest(sessionId: string, msg: CLIControlRequestMessage): boolean {
    const backend = backendFromAskTool(msg.request.tool_name);
    if (!backend) return false;

    const session = this.wsBridge.getSession(sessionId);
    if (!session) return false;
    session.pendingPermissions.delete(msg.request_id);
    const response = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: {
          behavior: "allow",
          updatedInput: msg.request.input,
        },
      },
    };
    (this.wsBridge as unknown as { sendToCLI?: (s: unknown, ndjson: string) => void }).sendToCLI?.(session, JSON.stringify(response));
    return true;
  }

  handleAdapterPermissionRequest(_sessionId: string, request: PermissionRequest, respond: PermissionResponder): boolean {
    const backend = backendFromCampfireMcpTool(request.tool_name);
    if (!backend) return false;

    respond({
      type: "permission_response",
      request_id: request.request_id,
      behavior: "allow",
      updated_input: request.input,
    });
    return true;
  }

  async callTool(parentSessionId: string, toolName: string, input: Record<string, unknown>): Promise<SubSessionResult> {
    const backendType = backendFromAskTool(toolName);
    if (!backendType) {
      return {
        sessionId: "",
        backendType: "claude",
        text: "",
        filesChanged: [],
        costUsd: 0,
        durationMs: 0,
        error: `Unknown agent tool: ${toolName}`,
      };
    }

    const parent = this.wsBridge.getSession(parentSessionId);
    if (!parent?.state.cwd) {
      return {
        sessionId: "",
        backendType,
        text: "",
        filesChanged: [],
        costUsd: 0,
        durationMs: 0,
        error: `Parent session ${parentSessionId} is not available.`,
      };
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) {
      return {
        sessionId: "",
        backendType,
        text: "",
        filesChanged: [],
        costUsd: 0,
        durationMs: 0,
        error: "prompt is required.",
      };
    }

    const timeoutSeconds = typeof input.timeout_seconds === "number" && Number.isFinite(input.timeout_seconds)
      ? Math.max(1, Math.min(3600, input.timeout_seconds))
      : 300;

    return this.subSessionManager.spawnSubSession(parentSessionId, backendType, prompt, parent.state.cwd, {
      timeoutMs: timeoutSeconds * 1000,
      toolUseId: `ask-${backendType}-${randomUUID().slice(0, 8)}`,
      name: `Ask ${backendType}`,
      description: prompt.slice(0, 160),
    });
  }

  private supportsRuntimeMcp(backendType: BackendType): boolean {
    return backendType === "claude" || backendType === "codex";
  }
}
