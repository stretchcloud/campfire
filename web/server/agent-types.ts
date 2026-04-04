import type { BackendType, McpServerConfig } from "./session-types.js";

// ─── Agent Profile ─────────────────────────────────────────────────────────

export interface AgentProfile {
  /** Unique slug-based ID (derived from name) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description of purpose */
  description: string;
  /** Emoji or short string icon */
  icon?: string;
  /** Which AI backend to use */
  backendType: BackendType;
  /** Model identifier (e.g. "claude-sonnet-4-6") */
  model: string;
  /** Permission level — defaults to "bypassPermissions" for autonomy */
  permissionMode: string;
  /** Working directory path */
  cwd: string;
  /** Prompt template — supports {{input}} placeholder for trigger input */
  prompt: string;

  // ── Triggers ──
  triggers?: {
    webhook?: { enabled: boolean };
    schedule?: {
      enabled: boolean;
      expression: string;
      recurring: boolean;
    };
  };

  // ── Environment ──
  /** Reference to ~/.campfire/envs/ profile */
  envSlug?: string;
  /** Inline environment variable overrides */
  env?: Record<string, string>;

  // ── MCP ──
  mcpServers?: Record<string, McpServerConfig>;

  // ── Backend-specific ──
  codexInternetAccess?: boolean;

  // ── State ──
  enabled: boolean;

  // ── Tracking ──
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  totalRuns: number;
  consecutiveFailures: number;
}

// ─── Execution Record ──────────────────────────────────────────────────────

export interface AgentExecution {
  executionId: string;
  agentId: string;
  sessionId: string;
  input?: string;
  trigger: "manual" | "webhook" | "schedule";
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  costUsd?: number;
}

// ─── Input Types ───────────────────────────────────────────────────────────

export type AgentProfileCreateInput = Omit<
  AgentProfile,
  "id" | "createdAt" | "updatedAt" | "consecutiveFailures" | "totalRuns" | "lastRunAt" | "lastSessionId"
>;
