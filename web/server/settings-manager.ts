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

// ─── Semantic memory settings (design doc §3.1/§3.2) ─────────────────────────

/** Decay policy for one namespace class. halfLifeHours = null → never decays. */
export interface MemoryDecayPolicy {
  halfLifeHours: number | null;
  reinforceMultiplier: number;
}

export interface MemorySettings {
  decay: {
    global: MemoryDecayPolicy;
    repo: MemoryDecayPolicy;
    session: MemoryDecayPolicy;
    agent: MemoryDecayPolicy;
  };
  /** Per-namespace recall depth for retrieval (ADR-161's "depth is a tunable"). */
  recallDepth: {
    session: number;
    repo: number;
    agent: number;
    global: number;
  };
}

/** Defaults per §3.1: 90d/30d/7d/60d half-lives (in hours), ×1.5/1.5/1.2/1.2. */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  decay: {
    global: { halfLifeHours: 90 * 24, reinforceMultiplier: 1.5 },
    repo: { halfLifeHours: 30 * 24, reinforceMultiplier: 1.5 },
    session: { halfLifeHours: 7 * 24, reinforceMultiplier: 1.2 },
    agent: { halfLifeHours: 60 * 24, reinforceMultiplier: 1.2 },
  },
  recallDepth: { session: 4, repo: 6, agent: 2, global: 3 },
};

function normalizeDecayPolicy(raw: unknown, fallback: MemoryDecayPolicy): MemoryDecayPolicy {
  const r = (raw ?? {}) as Partial<MemoryDecayPolicy>;
  const halfLifeHours =
    r.halfLifeHours === null
      ? null
      : typeof r.halfLifeHours === "number" && Number.isFinite(r.halfLifeHours) && r.halfLifeHours > 0
        ? r.halfLifeHours
        : fallback.halfLifeHours;
  const reinforceMultiplier =
    typeof r.reinforceMultiplier === "number" &&
    Number.isFinite(r.reinforceMultiplier) &&
    r.reinforceMultiplier >= 1
      ? r.reinforceMultiplier
      : fallback.reinforceMultiplier;
  return { halfLifeHours, reinforceMultiplier };
}

function normalizeRecallDepth(raw: unknown, key: keyof MemorySettings["recallDepth"]): number {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = r[key];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return DEFAULT_MEMORY_SETTINGS.recallDepth[key];
}

/** Deep-merge a (possibly partial/invalid) saved memory section over the defaults. */
export function normalizeMemorySettings(raw: unknown): MemorySettings {
  const r = (raw ?? {}) as { decay?: Record<string, unknown>; recallDepth?: unknown };
  const decayRaw = r.decay ?? {};
  return {
    decay: {
      global: normalizeDecayPolicy(decayRaw.global, DEFAULT_MEMORY_SETTINGS.decay.global),
      repo: normalizeDecayPolicy(decayRaw.repo, DEFAULT_MEMORY_SETTINGS.decay.repo),
      session: normalizeDecayPolicy(decayRaw.session, DEFAULT_MEMORY_SETTINGS.decay.session),
      agent: normalizeDecayPolicy(decayRaw.agent, DEFAULT_MEMORY_SETTINGS.decay.agent),
    },
    recallDepth: {
      session: normalizeRecallDepth(r.recallDepth, "session"),
      repo: normalizeRecallDepth(r.recallDepth, "repo"),
      agent: normalizeRecallDepth(r.recallDepth, "agent"),
      global: normalizeRecallDepth(r.recallDepth, "global"),
    },
  };
}

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
  /**
   * Semantic memory v2: decay policies + recall depths per namespace class.
   * Always populated by normalize() at runtime — typed optional only so
   * pre-v2 CampfireSettings literals (test mocks) keep compiling. Use
   * getMemorySettings() for guaranteed-present typed access.
   */
  memory?: MemorySettings;
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
  memory: normalizeMemorySettings(null),
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
    memory: normalizeMemorySettings(raw?.memory),
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

/** Semantic memory settings with defaults guaranteed (never undefined). */
export function getMemorySettings(): MemorySettings {
  ensureLoaded();
  return settings.memory ?? normalizeMemorySettings(null);
}

/** Deep-merge a partial memory patch over the current memory settings, then normalize. */
function mergeMemoryPatch(current: MemorySettings, patch: unknown): MemorySettings {
  if (!patch || typeof patch !== "object") return current;
  const p = patch as {
    decay?: Record<string, Record<string, unknown> | undefined>;
    recallDepth?: Record<string, unknown>;
  };
  return normalizeMemorySettings({
    decay: {
      global: { ...current.decay.global, ...p.decay?.global },
      repo: { ...current.decay.repo, ...p.decay?.repo },
      session: { ...current.decay.session, ...p.decay?.session },
      agent: { ...current.decay.agent, ...p.decay?.agent },
    },
    recallDepth: { ...current.recallDepth, ...p.recallDepth },
  });
}

export function updateSettings(
  patch: Partial<Pick<CampfireSettings, "openrouterApiKey" | "openrouterModel" | "moltbookApiKey" | "linearApiKey" | "claudeOAuthToken" | "openaiApiKey" | "anthropicApiKey" | "embeddingProvider" | "embeddingApiKey" | "embeddingModel" | "embeddingBaseUrl" | "onboardingCompleted">> & {
    /** Partial memory settings — deep-merged over the current values. */
    memory?: unknown;
  },
): CampfireSettings {
  ensureLoaded();
  const { memory: memoryPatch, ...rest } = patch;
  settings = {
    ...settings,
    ...rest,
    openrouterModel: rest.openrouterModel?.trim() || settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    memory: memoryPatch !== undefined
      ? mergeMemoryPatch(settings.memory ?? normalizeMemorySettings(null), memoryPatch)
      : settings.memory,
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
