import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

export type EmbeddingProvider = "openai" | "ollama" | "none";

export interface CampfireSettings {
  openrouterApiKey: string;
  openrouterModel: string;
  moltbookApiKey: string;
  linearApiKey: string;
  // Provider tokens — auto-injected into sessions for matching backends
  /** Claude Code OAuth token (injected as CLAUDE_CODE_OAUTH_TOKEN for Claude sessions) */
  claudeOAuthToken: string;
  /** OpenAI API key (injected as OPENAI_API_KEY for Codex sessions) */
  openaiApiKey: string;
  /** Anthropic API key (injected as ANTHROPIC_API_KEY — used by Claude, Goose, Aider, etc.) */
  anthropicApiKey: string;
  // Collective Intelligence: embedding provider for semantic memory
  embeddingProvider: EmbeddingProvider;
  embeddingApiKey: string;    // OpenAI API key (if provider = "openai")
  embeddingModel: string;     // e.g. "text-embedding-3-small" or "nomic-embed-text"
  embeddingBaseUrl: string;   // Ollama base URL (if provider = "ollama"), default http://localhost:11434
  /** Whether the onboarding wizard has been completed or skipped */
  onboardingCompleted: boolean;
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".campfire", "settings.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let settings: CampfireSettings = {
  openrouterApiKey: "",
  openrouterModel: DEFAULT_OPENROUTER_MODEL,
  moltbookApiKey: "",
  linearApiKey: "",
  claudeOAuthToken: "",
  openaiApiKey: "",
  anthropicApiKey: "",
  embeddingProvider: "none",
  embeddingApiKey: "",
  embeddingModel: "",
  embeddingBaseUrl: "http://localhost:11434",
  onboardingCompleted: false,
  updatedAt: 0,
};

function normalize(raw: Partial<CampfireSettings> | null | undefined): CampfireSettings {
  return {
    openrouterApiKey: typeof raw?.openrouterApiKey === "string" ? raw.openrouterApiKey : "",
    openrouterModel:
      typeof raw?.openrouterModel === "string" && raw.openrouterModel.trim()
        ? raw.openrouterModel
        : DEFAULT_OPENROUTER_MODEL,
    moltbookApiKey: typeof raw?.moltbookApiKey === "string" ? raw.moltbookApiKey : "",
    linearApiKey: typeof raw?.linearApiKey === "string" ? raw.linearApiKey : "",
    claudeOAuthToken: typeof raw?.claudeOAuthToken === "string" ? raw.claudeOAuthToken : "",
    openaiApiKey: typeof raw?.openaiApiKey === "string" ? raw.openaiApiKey : "",
    anthropicApiKey: typeof raw?.anthropicApiKey === "string" ? raw.anthropicApiKey : "",
    embeddingProvider: (raw?.embeddingProvider === "openai" || raw?.embeddingProvider === "ollama") ? raw.embeddingProvider : "none",
    embeddingApiKey: typeof raw?.embeddingApiKey === "string" ? raw.embeddingApiKey : "",
    embeddingModel: typeof raw?.embeddingModel === "string" ? raw.embeddingModel : "",
    embeddingBaseUrl: typeof raw?.embeddingBaseUrl === "string" && raw.embeddingBaseUrl.trim()
      ? raw.embeddingBaseUrl
      : "http://localhost:11434",
    onboardingCompleted: raw?.onboardingCompleted === true,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      settings = normalize(JSON.parse(raw) as Partial<CampfireSettings>);
    }
  } catch {
    settings = normalize(null);
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

export function getSettings(): CampfireSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CampfireSettings, "openrouterApiKey" | "openrouterModel" | "moltbookApiKey" | "linearApiKey" | "claudeOAuthToken" | "openaiApiKey" | "anthropicApiKey" | "embeddingProvider" | "embeddingApiKey" | "embeddingModel" | "embeddingBaseUrl" | "onboardingCompleted">>,
): CampfireSettings {
  ensureLoaded();
  settings = {
    ...settings,
    ...patch,
    openrouterModel: (patch.openrouterModel && patch.openrouterModel.trim()) || settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    updatedAt: Date.now(),
  };
  persist();
  return { ...settings };
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
}
