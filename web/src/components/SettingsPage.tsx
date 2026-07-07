import { useEffect, useState } from "react";
import { api, setAuthToken, DEFAULT_MEMORY_SETTINGS } from "../api.js";
import type { MemorySettings, MemoryNamespaceClass } from "../api.js";
import { useStore } from "../store.js";
import { getTelemetryPreferenceEnabled, setTelemetryPreferenceEnabled } from "../analytics.js";

/* ─── Tab Types ─────────────────────────────────────────────────── */

type SettingsTab = "general" | "providers" | "api-keys" | "memory" | "security" | "notifications" | "appearance" | "updates";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "api-keys", label: "API Keys" },
  { id: "memory", label: "Memory" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "updates", label: "Updates" },
];

/* ─── Helpers ───────────────────────────────────────────────────── */

function authStatusDescription(enabled: boolean, sessions: number): string {
  if (!enabled) return "Anyone with the URL can access this instance";
  return `${sessions} active session${sessions === 1 ? "" : "s"}`;
}

function updateVersionText(info: import("../api.js").UpdateInfo | null): string {
  if (!info?.latestVersion) return "Check for updates to see the latest version";
  if (info.updateAvailable) return `v${info.latestVersion} available`;
  return "You're on the latest version";
}

function authBadgeClass(enabled: boolean): string {
  return enabled ? "text-cc-success bg-cc-success/10" : "text-cc-warning bg-cc-warning/10";
}

/* ─── Toggle Switch ─────────────────────────────────────────────── */

function Toggle({ enabled, onToggle, label }: Readonly<{ enabled: boolean; onToggle: () => void; label: string }>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 cursor-pointer shrink-0 ${
        enabled ? "bg-cc-primary" : "bg-cc-border"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          enabled ? "translate-x-[18px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}

/* ─── Section Card ──────────────────────────────────────────────── */

function SettingsCard({ title, description, children }: Readonly<{ title: string; description?: string; children: React.ReactNode }>) {
  return (
    <div className="bg-cc-card border border-cc-border/60 rounded-xl">
      <div className="px-5 py-4 border-b border-cc-border/40">
        <h3 className="text-[13px] font-semibold text-cc-fg">{title}</h3>
        {description && <p className="mt-0.5 text-[12px] text-cc-fg/60">{description}</p>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </div>
  );
}

/* ─── Row ───────────────────────────────────────────────────────── */

function SettingsRow({ label, description, children }: Readonly<{ label: string; description?: string; children: React.ReactNode }>) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0 border-b border-cc-border/20 last:border-0">
      <div className="min-w-0">
        <span className="text-[13px] font-medium text-cc-fg">{label}</span>
        {description && <p className="text-[11px] text-cc-fg/55 mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ─── Tab Sub-Components ───────────────────────────────────────── */

function GeneralTab({ telemetryEnabled, setTelemetryEnabled }: Readonly<{
  telemetryEnabled: boolean;
  setTelemetryEnabled: (v: boolean) => void;
}>) {
  return (
    <>
      <SettingsCard title="Telemetry" description="Help improve Campfire with anonymous usage data">
        <SettingsRow
          label="Usage analytics and crash reports"
          description="Anonymous product analytics via PostHog. Browser Do Not Track is respected automatically."
        >
          <Toggle
            enabled={telemetryEnabled}
            label="Toggle telemetry"
            onToggle={() => {
              const next = !telemetryEnabled;
              setTelemetryPreferenceEnabled(next);
              setTelemetryEnabled(next);
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Environments" description="Manage reusable environment profiles for sessions">
        <div className="flex items-center justify-between">
          <p className="text-[12px] text-cc-fg/60">
            Configure named sets of environment variables to use when creating sessions.
          </p>
          <button
            type="button"
            onClick={() => { globalThis.location.hash = "#/environments"; }}
            className="px-3.5 py-2 rounded-lg text-[12px] font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer shrink-0 ml-4"
          >
            Manage
          </button>
        </div>
      </SettingsCard>
    </>
  );
}

function ProvidersTab({ claudeOAuthToken, setClaudeOAuthToken, claudeConfigured, setClaudeConfigured, openaiApiKey, setOpenaiApiKey, openaiConfigured, setOpenaiConfigured, anthropicApiKey, setAnthropicApiKey, anthropicConfigured, setAnthropicConfigured, providerSaving, setProviderSaving, providerSaved, setProviderSaved, error, setError }: Readonly<{
  claudeOAuthToken: string; setClaudeOAuthToken: (v: string) => void;
  claudeConfigured: boolean; setClaudeConfigured: (v: boolean) => void;
  openaiApiKey: string; setOpenaiApiKey: (v: string) => void;
  openaiConfigured: boolean; setOpenaiConfigured: (v: boolean) => void;
  anthropicApiKey: string; setAnthropicApiKey: (v: string) => void;
  anthropicConfigured: boolean; setAnthropicConfigured: (v: boolean) => void;
  providerSaving: boolean; setProviderSaving: (v: boolean) => void;
  providerSaved: boolean; setProviderSaved: (v: boolean) => void;
  error: string; setError: (v: string) => void;
}>) {
  return (
    <div className="space-y-5">
      <SettingsCard title="AI Provider Tokens" description="Tokens are auto-injected into sessions for matching backends. Environment profiles take precedence.">
        <div className="space-y-4">
          {/* Claude Code OAuth Token */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="claude-oauth" className="text-[12px] font-medium text-cc-fg">Claude Code OAuth Token</label>
              <span className={`text-[10px] font-medium px-1.5 rounded-full ${claudeConfigured ? "text-cc-success bg-cc-success/10" : "text-cc-muted bg-cc-hover"}`}>
                {claudeConfigured ? "Configured" : "Not set"}
              </span>
            </div>
            <p className="text-[11px] text-cc-muted mb-1.5">Injected as <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">CLAUDE_CODE_OAUTH_TOKEN</code> for Claude sessions</p>
            <input
              id="claude-oauth"
              type="password"
              value={claudeOAuthToken}
              onChange={(e) => setClaudeOAuthToken(e.target.value)}
              placeholder={claudeConfigured ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (configured)" : "Paste token from claude setup-token"}
              className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
            />
          </div>

          {/* OpenAI API Key */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="openai-key" className="text-[12px] font-medium text-cc-fg">OpenAI API Key</label>
              <span className={`text-[10px] font-medium px-1.5 rounded-full ${openaiConfigured ? "text-cc-success bg-cc-success/10" : "text-cc-muted bg-cc-hover"}`}>
                {openaiConfigured ? "Configured" : "Not set"}
              </span>
            </div>
            <p className="text-[11px] text-cc-muted mb-1.5">Injected as <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">OPENAI_API_KEY</code> for Codex sessions</p>
            <input
              id="openai-key"
              type="password"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              placeholder={openaiConfigured ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (configured)" : "sk-..."}
              className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
            />
          </div>

          {/* Anthropic API Key */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="anthropic-key" className="text-[12px] font-medium text-cc-fg">Anthropic API Key</label>
              <span className={`text-[10px] font-medium px-1.5 rounded-full ${anthropicConfigured ? "text-cc-success bg-cc-success/10" : "text-cc-muted bg-cc-hover"}`}>
                {anthropicConfigured ? "Configured" : "Not set"}
              </span>
            </div>
            <p className="text-[11px] text-cc-muted mb-1.5">Injected as <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">ANTHROPIC_API_KEY</code> for all sessions (Goose, Aider, etc.)</p>
            <input
              id="anthropic-key"
              type="password"
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              placeholder={anthropicConfigured ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (configured)" : "sk-ant-api03-..."}
              className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
            />
          </div>
        </div>
      </SettingsCard>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={async () => {
            setProviderSaving(true);
            setError("");
            try {
              const patch: Record<string, string> = {};
              if (claudeOAuthToken.trim()) patch.claudeOAuthToken = claudeOAuthToken.trim();
              if (openaiApiKey.trim()) patch.openaiApiKey = openaiApiKey.trim();
              if (anthropicApiKey.trim()) patch.anthropicApiKey = anthropicApiKey.trim();
              if (Object.keys(patch).length === 0) return;
              const res = await api.updateSettings(patch);
              setClaudeConfigured(res.claudeOAuthTokenConfigured ?? false);
              setOpenaiConfigured(res.openaiApiKeyConfigured ?? false);
              setAnthropicConfigured(res.anthropicApiKeyConfigured ?? false);
              setClaudeOAuthToken("");
              setOpenaiApiKey("");
              setAnthropicApiKey("");
              setProviderSaved(true);
              setTimeout(() => setProviderSaved(false), 1800);
            } catch (err: unknown) {
              setError(err instanceof Error ? err.message : "Save failed");
            } finally {
              setProviderSaving(false);
            }
          }}
          disabled={providerSaving}
          className="px-4 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {providerSaving ? "Saving..." : "Save Providers"}
        </button>
        {providerSaved && <span className="text-[11px] text-cc-success">Saved</span>}
        {error && <span className="text-[11px] text-cc-error">{error}</span>}
      </div>

      {/* Info note */}
      <div className="rounded-lg border border-cc-border/40 bg-cc-hover/30 px-4 py-3">
        <p className="text-[11px] text-cc-muted leading-relaxed">
          Provider tokens are automatically injected into new sessions for the matching backend.
          If an environment profile already sets the same variable, the profile value takes precedence.
          Tokens are stored in <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">~/.campfire/settings.json</code>.
        </p>
      </div>
    </div>
  );
}

function ApiKeysTab({ openrouterApiKey, setOpenrouterApiKey, openrouterModel, setOpenrouterModel, configured, moltbookApiKey, setMoltbookApiKey, moltbookConfigured, loading, saving, error, saved, onSave }: Readonly<{
  openrouterApiKey: string; setOpenrouterApiKey: (v: string) => void;
  openrouterModel: string; setOpenrouterModel: (v: string) => void;
  configured: boolean;
  moltbookApiKey: string; setMoltbookApiKey: (v: string) => void;
  moltbookConfigured: boolean;
  loading: boolean; saving: boolean; error: string; saved: boolean;
  onSave: (e: React.FormEvent) => void;
}>) {
  return (
    <form onSubmit={onSave} className="space-y-5">
      <SettingsCard title="OpenRouter" description="Used for auto-naming sessions after the first turn">
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] font-medium text-cc-fg mb-1.5" htmlFor="openrouter-key">
              API Key
            </label>
            <input
              id="openrouter-key"
              type="password"
              value={openrouterApiKey}
              onChange={(e) => setOpenrouterApiKey(e.target.value)}
              placeholder={configured ? "Configured — enter a new key to replace" : "sk-or-v1-..."}
              className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
            />
            <div className="flex items-center gap-2 mt-2">
              {configured ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-cc-success font-medium">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 4.97a.75.75 0 00-1.06 0L7 8.69 5.28 6.97a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25a.75.75 0 000-1.06z" />
                  </svg>
                  Configured
                </span>
              ) : (
                <span className="text-[11px] text-cc-fg/50">Not configured — auto-naming is disabled</span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-cc-fg mb-1.5" htmlFor="openrouter-model">
              Model
            </label>
            <input
              id="openrouter-model"
              type="text"
              value={openrouterModel}
              onChange={(e) => setOpenrouterModel(e.target.value)}
              placeholder="openrouter/free"
              className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Moltbook" description="Required to post gallery sessions to Moltbook">
        <div>
          <label className="block text-[12px] font-medium text-cc-fg mb-1.5" htmlFor="moltbook-key">
            API Key
          </label>
          <input
            id="moltbook-key"
            type="password"
            value={moltbookApiKey}
            onChange={(e) => setMoltbookApiKey(e.target.value)}
            placeholder={moltbookConfigured ? "Configured — enter a new key to replace" : "Paste your Moltbook API key"}
            className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
          />
          <div className="flex items-center gap-2 mt-2">
            {moltbookConfigured ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-cc-success font-medium">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 4.97a.75.75 0 00-1.06 0L7 8.69 5.28 6.97a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25a.75.75 0 000-1.06z" />
                </svg>
                Configured
              </span>
            ) : (
              <span className="text-[11px] text-cc-fg/50">
                Get a key at moltbook.com by registering an agent
              </span>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* Save bar */}
      <div className="flex items-center justify-between bg-cc-card border border-cc-border/60 rounded-xl px-5 py-3.5">
        <div className="text-[12px]">
          {error && (
            <span className="text-cc-error">{error}</span>
          )}
          {saved && (
            <span className="text-cc-success font-medium">Settings saved successfully</span>
          )}
          {!error && !saved && (
            <span className="text-cc-fg/50">
              {loading ? "Loading..." : "Changes are saved immediately"}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={saving || loading}
          className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
            saving || loading
              ? "bg-cc-hover text-cc-fg/40 cursor-not-allowed"
              : "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm cursor-pointer"
          }`}
        >
          {saving ? "Saving..." : "Save API Keys"}
        </button>
      </div>
    </form>
  );
}

/* ─── Memory Tab ────────────────────────────────────────────────── */

const MEMORY_NAMESPACES: { key: MemoryNamespaceClass; label: string; description: string }[] = [
  { key: "global", label: "Global", description: "Cross-repo conventions, user preferences, tool quirks" },
  { key: "repo", label: "Repository", description: "Architecture, conventions, distilled patterns per repo" },
  { key: "session", label: "Session", description: "Episodic fragments of one session (pre-consolidation)" },
  { key: "agent", label: "Agent", description: "Backend-specific behavior notes" },
];

/** String-typed draft so inputs can be empty while editing (empty half-life = never decays). */
interface MemoryDraft {
  decay: Record<MemoryNamespaceClass, { halfLifeDays: string; reinforceMultiplier: string }>;
  recallDepth: Record<MemoryNamespaceClass, string>;
}

function memorySettingsToDraft(s: MemorySettings): MemoryDraft {
  const decay = {} as MemoryDraft["decay"];
  const recallDepth = {} as MemoryDraft["recallDepth"];
  for (const { key } of MEMORY_NAMESPACES) {
    const policy = s.decay[key] ?? DEFAULT_MEMORY_SETTINGS.decay[key];
    decay[key] = {
      halfLifeDays: policy.halfLifeHours == null ? "" : String(policy.halfLifeHours / 24),
      reinforceMultiplier: String(policy.reinforceMultiplier),
    };
    recallDepth[key] = String(s.recallDepth?.[key] ?? DEFAULT_MEMORY_SETTINGS.recallDepth[key]);
  }
  return { decay, recallDepth };
}

/** Convert the draft back to MemorySettings. Returns an error string on invalid input. */
function draftToMemorySettings(draft: MemoryDraft): { settings?: MemorySettings; error?: string } {
  const decay = {} as MemorySettings["decay"];
  const recallDepth = {} as MemorySettings["recallDepth"];
  for (const { key, label } of MEMORY_NAMESPACES) {
    const days = draft.decay[key].halfLifeDays.trim();
    let halfLifeHours: number | null = null;
    if (days !== "") {
      const n = Number(days);
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `${label}: half-life must be a positive number of days (leave empty to never decay)` };
      }
      halfLifeHours = Math.round(n * 24);
    }
    const mult = Number(draft.decay[key].reinforceMultiplier);
    if (!Number.isFinite(mult) || mult < 1) {
      return { error: `${label}: reinforce multiplier must be a number ≥ 1` };
    }
    const depth = Number(draft.recallDepth[key]);
    if (!Number.isInteger(depth) || depth < 0) {
      return { error: `${label}: recall depth must be a whole number ≥ 0` };
    }
    decay[key] = { halfLifeHours, reinforceMultiplier: mult };
    recallDepth[key] = depth;
  }
  return { settings: { decay, recallDepth } };
}

function MemoryTab({ initial }: Readonly<{ initial: MemorySettings }>) {
  const [draft, setDraft] = useState<MemoryDraft>(() => memorySettingsToDraft(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Re-sync the draft when settings finish loading from the server
  useEffect(() => {
    setDraft(memorySettingsToDraft(initial));
  }, [initial]);

  function setDecayField(key: MemoryNamespaceClass, field: "halfLifeDays" | "reinforceMultiplier", value: string) {
    setDraft((d) => ({ ...d, decay: { ...d.decay, [key]: { ...d.decay[key], [field]: value } } }));
  }

  function setDepthField(key: MemoryNamespaceClass, value: string) {
    setDraft((d) => ({ ...d, recallDepth: { ...d.recallDepth, [key]: value } }));
  }

  async function onSave() {
    setError("");
    setSaved(false);
    const { settings, error: validationError } = draftToMemorySettings(draft);
    if (!settings) {
      setError(validationError || "Invalid memory settings");
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateSettings({ memory: settings });
      if (res.memory) setDraft(memorySettingsToDraft(res.memory));
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Memory Decay"
        description="Per-namespace half-life for recalled memories. Leave half-life empty to never decay. Reinforcement extends the half-life each time a memory is actually used."
      >
        <div className="space-y-4">
          {MEMORY_NAMESPACES.map(({ key, label, description }) => (
            <div key={key} className="flex flex-wrap items-end gap-3 py-1 border-b border-cc-border/20 last:border-0 pb-3 last:pb-0">
              <div className="min-w-[160px] flex-1">
                <span className="text-[13px] font-medium text-cc-fg">{label}</span>
                <p className="text-[11px] text-cc-fg/55 mt-0.5">{description}</p>
              </div>
              <div>
                <label htmlFor={`memory-halflife-${key}`} className="block text-[11px] text-cc-fg/60 mb-1">
                  Half-life (days)
                </label>
                <input
                  id={`memory-halflife-${key}`}
                  type="number"
                  min="0"
                  step="1"
                  value={draft.decay[key].halfLifeDays}
                  onChange={(e) => setDecayField(key, "halfLifeDays", e.target.value)}
                  placeholder="never"
                  className="w-24 h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
                />
              </div>
              <div>
                <label htmlFor={`memory-reinforce-${key}`} className="block text-[11px] text-cc-fg/60 mb-1">
                  Reinforce ×
                </label>
                <input
                  id={`memory-reinforce-${key}`}
                  type="number"
                  min="1"
                  step="0.1"
                  value={draft.decay[key].reinforceMultiplier}
                  onChange={(e) => setDecayField(key, "reinforceMultiplier", e.target.value)}
                  className="w-20 h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
                />
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Recall Depth"
        description="How many memories each namespace contributes when enriching a prompt with recalled context."
      >
        <div className="flex flex-wrap gap-4">
          {MEMORY_NAMESPACES.map(({ key, label }) => (
            <div key={key}>
              <label htmlFor={`memory-depth-${key}`} className="block text-[11px] text-cc-fg/60 mb-1">
                {label}
              </label>
              <input
                id={`memory-depth-${key}`}
                type="number"
                min="0"
                step="1"
                value={draft.recallDepth[key]}
                onChange={(e) => setDepthField(key, e.target.value)}
                className="w-20 h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
              />
            </div>
          ))}
        </div>
      </SettingsCard>

      {/* Save bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save Memory Settings"}
        </button>
        {saved && <span className="text-[11px] text-cc-success">Saved</span>}
        {error && <span className="text-[11px] text-cc-error">{error}</span>}
      </div>

      <div className="rounded-lg border border-cc-border/40 bg-cc-hover/30 px-4 py-3">
        <p className="text-[11px] text-cc-muted leading-relaxed">
          Pinned memories never decay regardless of half-life. Defaults: Global 90d, Repository 30d,
          Session 7d, Agent 60d. Settings are stored in <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">~/.campfire/settings.json</code>.
        </p>
      </div>
    </div>
  );
}

function SecurityTab({ authEnabled, setAuthEnabled, authPassword, setAuthPassword, authSaving, setAuthSaving, authSaved, setAuthSaved, authError, setAuthError, authSessions }: Readonly<{
  authEnabled: boolean; setAuthEnabled: (v: boolean) => void;
  authPassword: string; setAuthPassword: (v: string) => void;
  authSaving: boolean; setAuthSaving: (v: boolean) => void;
  authSaved: boolean; setAuthSaved: (v: boolean) => void;
  authError: string; setAuthError: (v: string) => void;
  authSessions: number;
}>) {
  return (
    <div className="space-y-5">
      <SettingsCard title="Authentication" description="Protect your Campfire instance with a password. When enabled, all API and WebSocket connections require a valid session token.">
        {/* Status indicator */}
        <div className="flex items-center gap-3 mb-4 pb-4 border-b border-cc-border/30">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${authEnabled ? "bg-cc-success/10" : "bg-cc-hover"}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`w-5 h-5 ${authEnabled ? "text-cc-success" : "text-cc-muted"}`} aria-hidden>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-[13px] font-medium text-cc-fg">
              Authentication is {authEnabled ? "enabled" : "disabled"}
            </p>
            <p className="text-[11px] text-cc-muted">
              {authStatusDescription(authEnabled, authSessions)}
            </p>
          </div>
          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${authBadgeClass(authEnabled)}`}>
            {authEnabled ? "Protected" : "Open"}
          </span>
        </div>

        {authError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-cc-error/8 border border-cc-error/15" role="alert">
            <p className="text-[11px] text-cc-error">{authError}</p>
          </div>
        )}

        {authEnabled ? (
          <DisableAuthSection saving={authSaving} onDisable={async () => {
            setAuthSaving(true); setAuthError("");
            try { await api.disableAuth(); setAuthEnabled(false); setAuthSaved(true); setTimeout(() => setAuthSaved(false), 2000); }
            catch (e: unknown) { setAuthError(e instanceof Error ? e.message : "Failed to disable auth"); }
            finally { setAuthSaving(false); }
          }} />
        ) : (
          <EnableAuthSection password={authPassword} saving={authSaving}
            onPasswordChange={setAuthPassword}
            onEnable={async () => {
              setAuthSaving(true); setAuthError("");
              try {
                await api.setupAuth(authPassword);
                const { token } = await api.login(authPassword);
                setAuthToken(token);
                setAuthEnabled(true);
                setAuthPassword("");
                setAuthSaved(true);
                setTimeout(() => setAuthSaved(false), 2000);
              }
              catch (e: unknown) { setAuthError(e instanceof Error ? e.message : "Failed to enable auth"); }
              finally { setAuthSaving(false); }
            }}
          />
        )}

        {authSaved && <p className="text-[11px] text-cc-success mt-2">Saved</p>}
      </SettingsCard>
    </div>
  );
}

function NotificationsTab({ notificationSound, toggleNotificationSound, notificationDesktop, setNotificationDesktop, notificationApiAvailable }: Readonly<{
  notificationSound: boolean; toggleNotificationSound: () => void;
  notificationDesktop: boolean; setNotificationDesktop: (v: boolean) => void;
  notificationApiAvailable: boolean;
}>) {
  return (
    <SettingsCard title="Notification Preferences" description="Control how Campfire alerts you">
      <SettingsRow
        label="Sound"
        description="Play a notification sound when a permission request arrives"
      >
        <Toggle
          enabled={notificationSound}
          label="Toggle notification sound"
          onToggle={toggleNotificationSound}
        />
      </SettingsRow>
      {notificationApiAvailable && (
        <SettingsRow
          label="Desktop Alerts"
          description="Show native browser notifications for permission requests"
        >
          <Toggle
            enabled={notificationDesktop}
            label="Toggle desktop notifications"
            onToggle={async () => {
              if (notificationDesktop) {
                setNotificationDesktop(false);
              } else {
                if (Notification.permission !== "granted") {
                  const result = await Notification.requestPermission();
                  if (result !== "granted") return;
                }
                setNotificationDesktop(true);
              }
            }}
          />
        </SettingsRow>
      )}
    </SettingsCard>
  );
}

function AppearanceTab({ darkMode, toggleDarkMode }: Readonly<{
  darkMode: boolean; toggleDarkMode: () => void;
}>) {
  return (
    <SettingsCard title="Theme" description="Choose your preferred color scheme">
      <SettingsRow
        label="Dark Mode"
        description="Switch between light and dark themes"
      >
        <Toggle
          enabled={darkMode}
          label="Toggle dark mode"
          onToggle={toggleDarkMode}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function UpdatesTab({ updateInfo, updateError, updateStatus, checkingUpdates, updatingApp, onCheckUpdates, onTriggerUpdate }: Readonly<{
  updateInfo: import("../api.js").UpdateInfo | null;
  updateError: string; updateStatus: string;
  checkingUpdates: boolean; updatingApp: boolean;
  onCheckUpdates: () => void; onTriggerUpdate: () => void;
}>) {
  return (
    <SettingsCard title="Software Updates" description="Keep Campfire up to date">
      <div className="space-y-4">
        {/* Version info */}
        <div className="flex items-center gap-3 py-2">
          <div className="w-10 h-10 rounded-xl bg-cc-primary/10 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5 text-cc-primary">
              <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4a.75.75 0 01.75.75v3.5h2.5a.75.75 0 010 1.5h-3.25a.75.75 0 01-.75-.75v-4.25A.75.75 0 018 4z" />
            </svg>
          </div>
          <div>
            <p className="text-[13px] font-medium text-cc-fg">
              {updateInfo ? `v${updateInfo.currentVersion}` : "Loading..."}
            </p>
            <p className="text-[11px] text-cc-fg/55">
              {updateVersionText(updateInfo)}
            </p>
          </div>
        </div>

        {/* Status messages */}
        {updateError && (
          <div className="px-3.5 py-2.5 rounded-lg bg-cc-error/8 border border-cc-error/15 text-[12px] text-cc-error">
            {updateError}
          </div>
        )}
        {updateStatus && (
          <div className="px-3.5 py-2.5 rounded-lg bg-cc-success/8 border border-cc-success/15 text-[12px] text-cc-success">
            {updateStatus}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={onCheckUpdates}
            disabled={checkingUpdates}
            className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
              checkingUpdates
                ? "bg-cc-hover text-cc-fg/40 cursor-not-allowed"
                : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
            }`}
          >
            {checkingUpdates ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-cc-fg/20 border-t-cc-fg/60 rounded-full animate-spin" />{" "}
                Checking...
              </span>
            ) : (
              "Check for Updates"
            )}
          </button>

          {updateInfo?.isServiceMode ? (
            <button
              type="button"
              onClick={onTriggerUpdate}
              disabled={updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable}
              className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
                updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable
                  ? "bg-cc-hover text-cc-fg/40 cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm cursor-pointer"
              }`}
            >
              {updatingApp || updateInfo.updateInProgress ? "Updating..." : "Update & Restart"}
            </button>
          ) : (
            <p className="text-[11px] text-cc-fg/55 self-center">
              Run <code className="font-mono-code bg-cc-code-bg px-1.5 py-0.5 rounded text-cc-code-fg text-[10px]">the-campfire install</code> to enable one-click updates
            </p>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}

/* ─── Component ─────────────────────────────────────────────────── */

interface SettingsPageProps {
  embedded?: boolean;
}

export function SettingsPage({ embedded = false }: Readonly<SettingsPageProps>) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("openrouter/free");
  const [configured, setConfigured] = useState(false);
  const [moltbookApiKey, setMoltbookApiKey] = useState("");
  const [moltbookConfigured, setMoltbookConfigured] = useState(false);
  const [claudeOAuthToken, setClaudeOAuthToken] = useState("");
  const [claudeConfigured, setClaudeConfigured] = useState(false);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authPassword, setAuthPassword] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authSaved, setAuthSaved] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authSessions, setAuthSessions] = useState(0);
  const [memorySettings, setMemorySettings] = useState<MemorySettings>(DEFAULT_MEMORY_SETTINGS);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const updateInfo = useStore((s) => s.updateInfo);
  const setUpdateInfo = useStore((s) => s.setUpdateInfo);
  const setUpdateOverlayActive = useStore((s) => s.setUpdateOverlayActive);
  const notificationApiAvailable = typeof Notification !== "undefined";
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(getTelemetryPreferenceEnabled());

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.openrouterApiKeyConfigured);
        setOpenrouterModel(s.openrouterModel || "openrouter/free");
        setMoltbookConfigured(s.moltbookApiKeyConfigured);
        setClaudeConfigured(s.claudeOAuthTokenConfigured ?? false);
        setOpenaiConfigured(s.openaiApiKeyConfigured ?? false);
        setAnthropicConfigured(s.anthropicApiKeyConfigured ?? false);
        setMemorySettings(s.memory ?? DEFAULT_MEMORY_SETTINGS);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Unknown error"))
      .finally(() => setLoading(false));
    api.getAuthStatus().then((s) => {
      setAuthEnabled(s.enabled);
      setAuthSessions(s.activeSessions);
    }).catch(() => {});
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const nextKey = openrouterApiKey.trim();
      const nextMoltbookKey = moltbookApiKey.trim();
      const payload: { openrouterApiKey?: string; openrouterModel: string; moltbookApiKey?: string } = {
        openrouterModel: openrouterModel.trim() || "openrouter/free",
      };
      if (nextKey) {
        payload.openrouterApiKey = nextKey;
      }
      if (nextMoltbookKey) {
        payload.moltbookApiKey = nextMoltbookKey;
      }

      const res = await api.updateSettings(payload);
      setConfigured(res.openrouterApiKeyConfigured);
      setMoltbookConfigured(res.moltbookApiKeyConfigured);
      setOpenrouterApiKey("");
      setMoltbookApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      const info = await api.forceCheckForUpdate();
      setUpdateInfo(info);
      if (info.updateAvailable && info.latestVersion) {
        setUpdateStatus(`Update v${info.latestVersion} is available.`);
      } else {
        setUpdateStatus("You are up to date.");
      }
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function onTriggerUpdate() {
    setUpdatingApp(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      const res = await api.triggerUpdate();
      setUpdateStatus(res.message);
      setUpdateOverlayActive(true);
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : "Unknown error");
      setUpdatingApp(false);
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10">

        {/* ── Header with back button (hidden when embedded in app chrome) ── */}
        <div className="flex items-center gap-3 mb-1">
          {!embedded && (
            <button
              onClick={() => { globalThis.location.hash = ""; }}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-fg/60 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              aria-label="Go back"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4">
                <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <div>
            <p className="text-[11px] text-cc-fg/50 font-medium">Settings</p>
            <h1 className="text-xl font-semibold text-cc-fg -mt-0.5">Settings</h1>
          </div>
        </div>

        {/* ── Tab Navigation ──────────────────────────────────────── */}
        <div className="mt-5 mb-6 border-b border-cc-border/40">
          <nav className="flex gap-0 -mb-px overflow-x-auto" aria-label="Settings tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors cursor-pointer ${
                  activeTab === tab.id
                    ? "border-cc-primary text-cc-fg"
                    : "border-transparent text-cc-fg/55 hover:text-cc-fg hover:border-cc-border/60"
                }`}
                aria-selected={activeTab === tab.id}
                role="tab"
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* ── Tab Content ─────────────────────────────────────────── */}
        <div className="space-y-5">
          {activeTab === "general" && (
            <GeneralTab telemetryEnabled={telemetryEnabled} setTelemetryEnabled={setTelemetryEnabled} />
          )}
          {activeTab === "providers" && (
            <ProvidersTab
              claudeOAuthToken={claudeOAuthToken} setClaudeOAuthToken={setClaudeOAuthToken}
              claudeConfigured={claudeConfigured} setClaudeConfigured={setClaudeConfigured}
              openaiApiKey={openaiApiKey} setOpenaiApiKey={setOpenaiApiKey}
              openaiConfigured={openaiConfigured} setOpenaiConfigured={setOpenaiConfigured}
              anthropicApiKey={anthropicApiKey} setAnthropicApiKey={setAnthropicApiKey}
              anthropicConfigured={anthropicConfigured} setAnthropicConfigured={setAnthropicConfigured}
              providerSaving={providerSaving} setProviderSaving={setProviderSaving}
              providerSaved={providerSaved} setProviderSaved={setProviderSaved}
              error={error} setError={setError}
            />
          )}
          {activeTab === "api-keys" && (
            <ApiKeysTab
              openrouterApiKey={openrouterApiKey} setOpenrouterApiKey={setOpenrouterApiKey}
              openrouterModel={openrouterModel} setOpenrouterModel={setOpenrouterModel}
              configured={configured}
              moltbookApiKey={moltbookApiKey} setMoltbookApiKey={setMoltbookApiKey}
              moltbookConfigured={moltbookConfigured}
              loading={loading} saving={saving} error={error} saved={saved}
              onSave={onSave}
            />
          )}
          {activeTab === "memory" && (
            <MemoryTab initial={memorySettings} />
          )}
          {activeTab === "security" && (
            <SecurityTab
              authEnabled={authEnabled} setAuthEnabled={setAuthEnabled}
              authPassword={authPassword} setAuthPassword={setAuthPassword}
              authSaving={authSaving} setAuthSaving={setAuthSaving}
              authSaved={authSaved} setAuthSaved={setAuthSaved}
              authError={authError} setAuthError={setAuthError}
              authSessions={authSessions}
            />
          )}
          {activeTab === "notifications" && (
            <NotificationsTab
              notificationSound={notificationSound} toggleNotificationSound={toggleNotificationSound}
              notificationDesktop={notificationDesktop} setNotificationDesktop={setNotificationDesktop}
              notificationApiAvailable={notificationApiAvailable}
            />
          )}
          {activeTab === "appearance" && (
            <AppearanceTab darkMode={darkMode} toggleDarkMode={toggleDarkMode} />
          )}
          {activeTab === "updates" && (
            <UpdatesTab
              updateInfo={updateInfo} updateError={updateError} updateStatus={updateStatus}
              checkingUpdates={checkingUpdates} updatingApp={updatingApp}
              onCheckUpdates={onCheckUpdates} onTriggerUpdate={onTriggerUpdate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Auth Sub-Components ──────────────────────────────────────────────────

function EnableAuthSection({ password, saving, onPasswordChange, onEnable }: Readonly<{
  password: string; saving: boolean; onPasswordChange: (v: string) => void; onEnable: () => void;
}>) {
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="auth-password" className="text-[12px] font-medium text-cc-fg block mb-1.5">Set a password</label>
        <input id="auth-password" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="Minimum 4 characters"
          className="w-full h-10 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg focus:outline-none focus:ring-2 focus:ring-cc-primary/20 focus:border-cc-primary/40" />
      </div>
      <button type="button" disabled={password.length < 4 || saving} onClick={onEnable}
        className="w-full h-10 rounded-lg bg-cc-primary text-white text-[13px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-40">
        {saving ? "Enabling..." : "Enable Authentication"}
      </button>
    </div>
  );
}

function DisableAuthSection({ saving, onDisable }: Readonly<{ saving: boolean; onDisable: () => void }>) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-cc-border/40 bg-cc-hover/30 px-4 py-3">
        <p className="text-[11px] text-cc-muted leading-relaxed">
          All REST API requests require a <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">Bearer</code> token.
          All WebSocket connections require an <code className="font-mono-code text-[10px] bg-cc-hover px-1 rounded">auth_token</code> parameter.
          CLI connections from localhost are allowed without a token.
        </p>
      </div>
      <button type="button" disabled={saving} onClick={onDisable}
        className="w-full h-10 rounded-lg border border-cc-error/30 text-cc-error text-[13px] font-medium hover:bg-cc-error/5 transition-colors cursor-pointer disabled:opacity-40">
        {saving ? "Disabling..." : "Disable Authentication"}
      </button>
    </div>
  );
}
