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

export interface CompanionSettings {
  openrouterApiKey: string;
  openrouterModel: string;
  moltbookApiKey: string;
  linearApiKey: string;
  // Collective Intelligence: embedding provider for semantic memory
  embeddingProvider: EmbeddingProvider;
  embeddingApiKey: string;    // OpenAI API key (if provider = "openai")
  embeddingModel: string;     // e.g. "text-embedding-3-small" or "nomic-embed-text"
  embeddingBaseUrl: string;   // Ollama base URL (if provider = "ollama"), default http://localhost:11434
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let settings: CompanionSettings = {
  openrouterApiKey: "",
  openrouterModel: DEFAULT_OPENROUTER_MODEL,
  moltbookApiKey: "",
  linearApiKey: "",
  embeddingProvider: "none",
  embeddingApiKey: "",
  embeddingModel: "",
  embeddingBaseUrl: "http://localhost:11434",
  updatedAt: 0,
};

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    openrouterApiKey: typeof raw?.openrouterApiKey === "string" ? raw.openrouterApiKey : "",
    openrouterModel:
      typeof raw?.openrouterModel === "string" && raw.openrouterModel.trim()
        ? raw.openrouterModel
        : DEFAULT_OPENROUTER_MODEL,
    moltbookApiKey: typeof raw?.moltbookApiKey === "string" ? raw.moltbookApiKey : "",
    linearApiKey: typeof raw?.linearApiKey === "string" ? raw.linearApiKey : "",
    embeddingProvider: (raw?.embeddingProvider === "openai" || raw?.embeddingProvider === "ollama") ? raw.embeddingProvider : "none",
    embeddingApiKey: typeof raw?.embeddingApiKey === "string" ? raw.embeddingApiKey : "",
    embeddingModel: typeof raw?.embeddingModel === "string" ? raw.embeddingModel : "",
    embeddingBaseUrl: typeof raw?.embeddingBaseUrl === "string" && raw.embeddingBaseUrl.trim()
      ? raw.embeddingBaseUrl
      : "http://localhost:11434",
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      settings = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
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

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CompanionSettings, "openrouterApiKey" | "openrouterModel" | "moltbookApiKey" | "linearApiKey" | "embeddingProvider" | "embeddingApiKey" | "embeddingModel" | "embeddingBaseUrl">>,
): CompanionSettings {
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
