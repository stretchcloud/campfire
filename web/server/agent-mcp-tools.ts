import type { BackendType, McpServerConfig } from "./session-types.js";

export interface AgentToolDefinition {
  name: string;
  backendType: BackendType;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOL_BACKENDS: Array<{ backendType: BackendType; label: string; strengths: string }> = [
  { backendType: "codex", label: "Codex", strengths: "focused code generation, scripts, tests, and small refactors" },
  { backendType: "goose", label: "Goose", strengths: "local development workflows and shell-oriented implementation tasks" },
  { backendType: "aider", label: "Aider", strengths: "direct repository patching and concise file edits" },
  { backendType: "openhands", label: "OpenHands", strengths: "autonomous implementation work in a project workspace" },
  { backendType: "claude", label: "Claude Code", strengths: "architecture, review, broad refactors, and high-context reasoning" },
];

export function toolNameForBackend(backendType: BackendType): string {
  return `ask_${backendType}`;
}

export function backendFromAskTool(toolName: string): BackendType | null {
  if (!toolName.startsWith("ask_")) return null;
  const backend = toolName.slice(4) as BackendType;
  return TOOL_BACKENDS.some((entry) => entry.backendType === backend) ? backend : null;
}

export function generateAgentToolDefinitions(backends: BackendType[] = TOOL_BACKENDS.map((entry) => entry.backendType)): AgentToolDefinition[] {
  const enabled = new Set(backends);
  return TOOL_BACKENDS
    .filter((entry) => enabled.has(entry.backendType))
    .map((entry) => ({
      name: toolNameForBackend(entry.backendType),
      backendType: entry.backendType,
      description: `Delegate a one-turn coding subtask to ${entry.label}. Best for ${entry.strengths}. Runs in the same working directory as the lead session.`,
      input_schema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: `Clear, specific task description for ${entry.label}.`,
          },
          timeout_seconds: {
            type: "number",
            description: "Maximum seconds to wait for the sub-agent. Defaults to 300.",
            default: 300,
          },
        },
        required: ["prompt"],
      },
    }));
}

/**
 * Resolve the Bun executable to launch the stdio MCP server with. When the
 * server itself runs under Bun (always in production, including the desktop
 * app where Bun is bundled inside the .app and not on PATH), use the absolute
 * path of the current runtime so the agent CLI can spawn it without needing
 * a global `bun` install.
 */
function resolveBunCommand(): string {
  return typeof Bun !== "undefined" && process.execPath ? process.execPath : "bun";
}

export function createAgentMcpServerConfig(options: {
  port: number;
  token: string;
  packageRoot: string;
  parentSessionId: string;
  backends?: BackendType[];
}): McpServerConfig {
  return {
    type: "stdio",
    command: resolveBunCommand(),
    args: [`${options.packageRoot}/server/agent-mcp-stdio.ts`],
    env: {
      CAMPFIRE_AGENT_MCP_URL: `http://127.0.0.1:${options.port}/api/internal/agent-mcp`,
      CAMPFIRE_AGENT_MCP_TOKEN: options.token,
      CAMPFIRE_PARENT_SESSION_ID: options.parentSessionId,
      CAMPFIRE_AGENT_MCP_BACKENDS: (options.backends ?? TOOL_BACKENDS.map((entry) => entry.backendType)).join(","),
    },
  };
}
