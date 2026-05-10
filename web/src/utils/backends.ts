import type { BackendType } from "../types.js";
import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
  "ollama": "\u25CF",   // ● for local models
  "goose": "\u1F9AA",   // for goose models
};

function pickIcon(slug: string, index: number): string {
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["\u25C6", "\u25CF", "\u25D5", "\u2726"]; // ◆ ● ◕ ✦
  return fallback[index % fallback.length];
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-4-6", label: "Opus", icon: "\u2733" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet", icon: "\u25D5" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku", icon: "\u26A1" },
];

export const CODEX_MODELS: ModelOption[] = [
];

/** Goose supports many providers — these are common defaults.
 *  The actual model list depends on the configured GOOSE_PROVIDER. */
export const GOOSE_MODELS: ModelOption[] = [
  { value: "default", label: "Default", icon: "\u25C6" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet", icon: "\u25D5" },
  { value: "claude-opus-4-6", label: "Claude Opus", icon: "\u2733" },
  { value: "gpt-4o", label: "GPT-4o", icon: "\u25CF" },
  { value: "ollama/llama3.3", label: "Llama 3.3 (Ollama)", icon: "\u26A1" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Agent (auto-approve)" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "default", label: "Ask Every Time" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "plan", label: "Suggest" },
];

export const GOOSE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "default", label: "Prompt" },
];

/** Aider supports many models via --model flag. */
export const AIDER_MODELS: ModelOption[] = [
  { value: "gpt-4o", label: "GPT-4o", icon: "\u25CF" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet", icon: "\u25D5" },
  { value: "deepseek/deepseek-chat", label: "DeepSeek Chat", icon: "\u25C6" },
  { value: "o3-mini", label: "o3-mini", icon: "\u26A1" },
];

export const AIDER_MODES: ModeOption[] = [
  { value: "default", label: "Default" },
];

/** OpenHands models — depends on configured provider. */
export const OPENHANDS_MODELS: ModelOption[] = [
  { value: "default", label: "Default", icon: "\u25C6" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet", icon: "\u25D5" },
  { value: "gpt-4o", label: "GPT-4o", icon: "\u25CF" },
];

export const OPENHANDS_MODES: ModeOption[] = [
  { value: "default", label: "Default" },
];

/** OpenClaw models — depends on Gateway-configured provider. */
export const OPENCLAW_MODELS: ModelOption[] = [
  { value: "default", label: "Default", icon: "\u25C6" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet", icon: "\u25D5" },
  { value: "gpt-4o", label: "GPT-4o", icon: "\u25CF" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", icon: "\u25C8" },
];

export const OPENCLAW_MODES: ModeOption[] = [
  { value: "default", label: "Prompt" },
  { value: "bypassPermissions", label: "Auto" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: BackendType): ModelOption[] {
  if (backend === "codex") return CODEX_MODELS;
  if (backend === "goose") return GOOSE_MODELS;
  if (backend === "aider") return AIDER_MODELS;
  if (backend === "openhands") return OPENHANDS_MODELS;
  if (backend === "openclaw") return OPENCLAW_MODELS;
  return CLAUDE_MODELS;
}

export function getModesForBackend(backend: BackendType): ModeOption[] {
  if (backend === "codex") return CODEX_MODES;
  if (backend === "goose") return GOOSE_MODES;
  if (backend === "aider") return AIDER_MODES;
  if (backend === "openhands") return OPENHANDS_MODES;
  if (backend === "openclaw") return OPENCLAW_MODES;
  return CLAUDE_MODES;
}

export function getDefaultModel(backend: BackendType): string {
  if (backend === "codex") return "";
  if (backend === "goose") return GOOSE_MODELS[0].value;
  if (backend === "aider") return AIDER_MODELS[0].value;
  if (backend === "openhands") return OPENHANDS_MODELS[0].value;
  if (backend === "openclaw") return OPENCLAW_MODELS[0].value;
  return CLAUDE_MODELS[0].value;
}

export function getDefaultMode(backend: BackendType): string {
  if (backend === "codex") return CODEX_MODES[0].value;
  if (backend === "goose") return GOOSE_MODES[0].value;
  if (backend === "aider") return AIDER_MODES[0].value;
  if (backend === "openhands") return OPENHANDS_MODES[0].value;
  if (backend === "openclaw") return OPENCLAW_MODES[0].value;
  return CLAUDE_MODES[0].value;
}
