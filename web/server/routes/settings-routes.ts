import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_OPENROUTER_MODEL, getSettings, updateSettings, type CampfireSettings } from "../settings-manager.js";

function settingsResponse(s: CampfireSettings) {
  return {
    openrouterApiKeyConfigured: !!s.openrouterApiKey.trim(),
    openrouterModel: s.openrouterModel || DEFAULT_OPENROUTER_MODEL,
    moltbookApiKeyConfigured: !!s.moltbookApiKey?.trim(),
    linearApiKeyConfigured: !!s.linearApiKey?.trim(),
    claudeOAuthTokenConfigured: !!s.claudeOAuthToken?.trim(),
    openaiApiKeyConfigured: !!s.openaiApiKey?.trim(),
    anthropicApiKeyConfigured: !!s.anthropicApiKey?.trim(),
    onboardingCompleted: s.onboardingCompleted,
    // Semantic memory v2: decay policies + recall depths (not secret — full values)
    memory: s.memory,
  };
}

function resolveClaudeMethod(
  credentials: boolean, oauthEnv: boolean, apiKeyEnv: boolean,
  anthropicStored: boolean, tokenStored: boolean,
): string | null {
  if (credentials) return "subscription";
  if (oauthEnv) return "oauth-token";
  if (apiKeyEnv || anthropicStored) return "api-key";
  if (tokenStored) return "oauth-token";
  return null;
}

function resolveCodexMethod(auth: boolean, apiKeyEnv: boolean, keyStored: boolean): string | null {
  if (auth) return "subscription";
  if (apiKeyEnv || keyStored) return "api-key";
  return null;
}

export function registerSettingsRoutes(api: Hono, _deps: RouteDeps): void {
  api.get("/settings", (c) => {
    const settings = getSettings();
    return c.json(settingsResponse(settings));
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Validate string fields
    const STRING_FIELDS = [
      "openrouterApiKey", "openrouterModel", "moltbookApiKey", "linearApiKey",
      "claudeOAuthToken", "openaiApiKey", "anthropicApiKey",
    ] as const;

    for (const field of STRING_FIELDS) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return c.json({ error: `${field} must be a string` }, 400);
      }
    }

    const hasOnboarding = typeof body.onboardingCompleted === "boolean";
    const hasMemory = body.memory !== undefined;
    if (hasMemory && (typeof body.memory !== "object" || body.memory === null || Array.isArray(body.memory))) {
      return c.json({ error: "memory must be an object" }, 400);
    }
    const hasAnyField = STRING_FIELDS.some((f) => body[f] !== undefined) || hasOnboarding || hasMemory;
    if (!hasAnyField) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    const patch: Record<string, string | boolean | object> = {};
    if (hasOnboarding) patch.onboardingCompleted = body.onboardingCompleted;
    // Partial memory patch — deep-merged + normalized by the settings manager
    if (hasMemory) patch.memory = body.memory;
    for (const field of STRING_FIELDS) {
      if (typeof body[field] === "string") {
        patch[field] = field === "openrouterModel"
          ? (body[field].trim() || DEFAULT_OPENROUTER_MODEL)
          : body[field].trim();
      }
    }

    const settings = updateSettings(patch);
    return c.json(settingsResponse(settings));
  });

  // ─── Auth detection: check if Claude/Codex are already authenticated ─────
  api.get("/settings/auth-status", (c) => {
    const home = homedir();
    // Claude: ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN env var
    const claudeCredentials = existsSync(join(home, ".claude", ".credentials.json"));
    const claudeOAuthEnv = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const claudeApiKeyEnv = !!process.env.ANTHROPIC_API_KEY;

    // Codex: ~/.codex/auth.json or OPENAI_API_KEY env var
    const codexAuth = existsSync(join(home, ".codex", "auth.json"));
    const openaiApiKeyEnv = !!process.env.OPENAI_API_KEY;

    // Also check global settings for stored tokens
    const settings = getSettings();
    const claudeTokenStored = !!settings.claudeOAuthToken?.trim();
    const openaiKeyStored = !!settings.openaiApiKey?.trim();
    const anthropicKeyStored = !!settings.anthropicApiKey?.trim();

    return c.json({
      claude: {
        authenticated: claudeCredentials || claudeOAuthEnv || claudeApiKeyEnv || claudeTokenStored || anthropicKeyStored,
        method: resolveClaudeMethod(claudeCredentials, claudeOAuthEnv, claudeApiKeyEnv, anthropicKeyStored, claudeTokenStored),
      },
      codex: {
        authenticated: codexAuth || openaiApiKeyEnv || openaiKeyStored,
        method: resolveCodexMethod(codexAuth, openaiApiKeyEnv, openaiKeyStored),
      },
    });
  });
}
