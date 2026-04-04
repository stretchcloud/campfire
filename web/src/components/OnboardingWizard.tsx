import { useState, useEffect, useRef, useCallback } from "react";
import { api, type AuthStatus } from "../api.js";

/**
 * OnboardingWizard — premium first-run experience.
 *
 * 5 steps: Welcome → Providers → Workspace → Tour → Launch
 * Supports both subscription login (claude auth login / codex login)
 * and API key entry. Auto-detects existing authentication.
 *
 * Accessibility: native <dialog>, focus management, ARIA labels,
 * keyboard navigation (Enter/Escape), step announcements.
 */

type Step = "welcome" | "providers" | "workspace" | "tour" | "launch";
const ORDERED_STEPS: Step[] = ["welcome", "providers", "workspace", "tour", "launch"];

function stepNumber(s: Step): number {
  return ORDERED_STEPS.indexOf(s);
}

function stepDotStyle(isDone: boolean, isActive: boolean): string {
  if (isDone) return "bg-cc-primary text-white";
  if (isActive) return "bg-cc-primary/15 text-cc-primary ring-2 ring-cc-primary/30";
  return "bg-cc-hover text-cc-muted/50";
}

function methodLabel(m: string | null): string {
  if (m === "subscription") return "Logged in";
  if (m === "oauth-token") return "Token set";
  if (m === "api-key") return "API key set";
  return "";
}

// ─── Main Wizard ────────────────────────────────────────────────────────────

export function OnboardingWizard({ onComplete }: Readonly<{ onComplete: () => void }>) {
  const [step, setStep] = useState<Step>("welcome");
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [claudeToken, setClaudeToken] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [cwd, setCwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  const currentStep = stepNumber(step);

  // Focus dialog on mount
  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  // Fetch auth status
  useEffect(() => {
    api.getProviderAuthStatus().then(setAuthStatus).catch(() => {});
  }, [step]);

  const finishOnboarding = useCallback(async () => {
    try { await api.updateSettings({ onboardingCompleted: true }); } catch { /* non-fatal */ }
    onComplete();
  }, [onComplete]);

  async function saveProviders() {
    setSaving(true);
    setError("");
    try {
      const patch: Record<string, string> = {};
      if (claudeToken.trim()) patch.claudeOAuthToken = claudeToken.trim();
      if (openaiKey.trim()) patch.openaiApiKey = openaiKey.trim();
      if (Object.keys(patch).length > 0) await api.updateSettings(patch);
      setStep("workspace");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function refreshAuth() {
    api.getProviderAuthStatus().then(setAuthStatus).catch(() => {});
  }

  return (
    <dialog
      ref={dialogRef}
      open
      aria-label="Campfire setup wizard"
      className="fixed inset-0 z-50 flex items-center justify-center w-full h-full m-0 p-0 bg-black/50 backdrop-blur-md border-none outline-none"
    >
      <div className="w-full max-w-[520px] mx-5 bg-cc-card rounded-2xl shadow-float border border-cc-border/60 overflow-hidden animate-slide-up">
        {/* ── Step Indicator ──────────────────────────────── */}
        <StepIndicator current={currentStep} total={4} />

        {/* ── Step Content ────────────────────────────────── */}
        <div className="px-7 pb-7 pt-5">
          {step === "welcome" && (
            <WelcomeContent onNext={() => setStep("providers")} onSkip={finishOnboarding} />
          )}
          {step === "providers" && (
            <ProvidersContent
              authStatus={authStatus}
              claudeToken={claudeToken}
              openaiKey={openaiKey}
              onClaudeTokenChange={setClaudeToken}
              onOpenaiKeyChange={setOpenaiKey}
              saving={saving}
              error={error}
              onSave={saveProviders}
              onSkip={() => setStep("workspace")}
              onRefreshAuth={refreshAuth}
            />
          )}
          {step === "workspace" && (
            <WorkspaceContent cwd={cwd} onCwdChange={setCwd} onNext={() => setStep("tour")} onSkip={() => setStep("tour")} />
          )}
          {step === "tour" && (
            <TourContent onNext={() => setStep("launch")} />
          )}
          {step === "launch" && (
            <LaunchContent cwd={cwd} onComplete={finishOnboarding} />
          )}
        </div>
      </div>
    </dialog>
  );
}

// ─── Step Indicator ─────────────────────────────────────────────────────────

const STEP_LABELS = ["Welcome", "Providers", "Workspace", "Features"];

function StepIndicator({ current, total }: Readonly<{ current: number; total: number }>) {
  if (current >= total) return null; // Hide on final "launch" step
  return (
    <output className="block px-7 pt-6 pb-1" aria-label={`Step ${current + 1} of ${total}: ${STEP_LABELS[current]}`}>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, i) => {
          const isDone = i < current;
          const isActive = i === current;
          return (
            <div key={i} className="flex items-center gap-1.5 flex-1">
              {/* Dot / number */}
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 transition-all duration-300 ${
                stepDotStyle(isDone, isActive)
              }`}>
                {isDone ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {/* Connector line */}
              {i < total - 1 && (
                <div className={`flex-1 h-[2px] rounded-full transition-colors duration-300 ${
                  i < current ? "bg-cc-primary" : "bg-cc-border"
                }`} />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-cc-muted mt-2 font-medium">{STEP_LABELS[current]}</p>
    </output>
  );
}

// ─── Step 1: Welcome ────────────────────────────────────────────────────────

function WelcomeContent({ onNext, onSkip }: Readonly<{ onNext: () => void; onSkip: () => void }>) {
  return (
    <div className="text-center">
      {/* Logo area */}
      <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-cc-primary/20 to-cc-primary/5 flex items-center justify-center border border-cc-primary/10">
        <span className="text-3xl" role="img" aria-label="Campfire">{"\u{1F525}"}</span>
      </div>

      <h1 className="text-[22px] font-bold text-cc-fg tracking-tight">Welcome to Campfire</h1>
      <p className="text-[14px] text-cc-muted mt-2 leading-relaxed max-w-[380px] mx-auto">
        A unified web interface for AI coding agents. Run Claude, Codex, Goose, Aider and more from your browser.
      </p>

      <div className="mt-8 space-y-3">
        <button
          onClick={onNext}
          autoFocus
          className="w-full h-11 rounded-xl bg-cc-primary text-white text-[14px] font-semibold hover:bg-cc-primary-hover active:scale-[0.98] transition-all cursor-pointer shadow-sm"
        >
          Get Started
        </button>
        <button
          onClick={onSkip}
          className="w-full text-[12px] text-cc-muted/60 hover:text-cc-muted transition-colors cursor-pointer py-1"
        >
          Skip setup — I'll configure later in Settings
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Providers ──────────────────────────────────────────────────────

function ProvidersContent({
  authStatus, claudeToken, openaiKey, onClaudeTokenChange, onOpenaiKeyChange,
  saving, error, onSave, onSkip, onRefreshAuth,
}: Readonly<{
  authStatus: AuthStatus | null;
  claudeToken: string;
  openaiKey: string;
  onClaudeTokenChange: (v: string) => void;
  onOpenaiKeyChange: (v: string) => void;
  saving: boolean;
  error: string;
  onSave: () => void;
  onSkip: () => void;
  onRefreshAuth: () => void;
}>) {
  return (
    <div>
      <h2 className="text-[18px] font-bold text-cc-fg tracking-tight">Connect Providers</h2>
      <p className="text-[13px] text-cc-muted mt-1 mb-5">
        Set up one or both. You can add more anytime in Settings.
      </p>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-cc-error/8 border border-cc-error/15" role="alert">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error shrink-0" aria-hidden>
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
          <p className="text-[12px] text-cc-error">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        <ProviderSetupCard
          name="Claude Code"
          description="Anthropic's coding agent"
          accentColor="bg-[#5BA8A0]"
          authenticated={authStatus?.claude.authenticated ?? false}
          method={authStatus?.claude.method ?? null}
          loginCommand="claude auth login"
          loginHint="Signs in with your Claude Pro, Max, or Team subscription"
          tokenLabel="OAuth token or API key"
          tokenPlaceholder="sk-ant-... or paste from claude setup-token"
          tokenValue={claudeToken}
          onTokenChange={onClaudeTokenChange}
          onRefresh={onRefreshAuth}
        />
        <ProviderSetupCard
          name="Codex"
          description="OpenAI's coding agent"
          accentColor="bg-blue-500"
          authenticated={authStatus?.codex.authenticated ?? false}
          method={authStatus?.codex.method ?? null}
          loginCommand="codex login"
          loginHint="Signs in with your ChatGPT Plus or Pro subscription"
          tokenLabel="OpenAI API key"
          tokenPlaceholder="sk-..."
          tokenValue={openaiKey}
          onTokenChange={onOpenaiKeyChange}
          onRefresh={onRefreshAuth}
        />
      </div>

      <div className="flex items-center gap-3 mt-6">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex-1 h-11 rounded-xl bg-cc-primary text-white text-[14px] font-semibold hover:bg-cc-primary-hover active:scale-[0.98] transition-all cursor-pointer disabled:opacity-40 shadow-sm"
        >
          {saving ? "Saving..." : "Continue"}
        </button>
        <button
          onClick={onSkip}
          className="h-11 px-5 rounded-xl text-[13px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ─── Provider Setup Card ────────────────────────────────────────────────────

function ProviderSetupCard({
  name, description, accentColor, authenticated, method, loginCommand,
  loginHint, tokenLabel, tokenPlaceholder, tokenValue, onTokenChange, onRefresh,
}: Readonly<{
  name: string;
  description: string;
  accentColor: string;
  authenticated: boolean;
  method: string | null;
  loginCommand: string;
  loginHint: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenValue: string;
  onTokenChange: (v: string) => void;
  onRefresh: () => void;
}>) {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(loginCommand).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`rounded-xl border transition-colors ${
      authenticated
        ? "border-cc-success/30 bg-cc-success/[0.03]"
        : "border-cc-border hover:border-cc-border/80"
    }`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`w-8 h-8 rounded-lg ${accentColor} flex items-center justify-center`}>
          <span className="text-white text-sm font-bold">{name.charAt(0)}</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[13px] font-semibold text-cc-fg">{name}</h3>
          <p className="text-[11px] text-cc-muted">{description}</p>
        </div>
        {authenticated && (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-cc-success bg-cc-success/10 px-2.5 py-1 rounded-full">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
              <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
            </svg>
            {methodLabel(method)}
          </span>
        )}
      </div>

      {/* Setup area (only when not authenticated) */}
      {!authenticated && (
        <div className="px-4 pb-4 space-y-3">
          {/* Terminal command */}
          <div>
            <p className="text-[11px] text-cc-muted mb-1.5">Run in your terminal:</p>
            <div className="flex items-center bg-cc-code-bg rounded-lg border border-cc-border/30 overflow-hidden">
              <div className="flex-1 flex items-center gap-2 px-3 py-2.5 min-w-0">
                <span className="text-cc-code-fg/40 text-[12px] font-mono-code select-none" aria-hidden>$</span>
                <code className="text-[12px] font-mono-code text-cc-code-fg truncate">{loginCommand}</code>
              </div>
              <button
                onClick={handleCopy}
                className="px-3 py-2.5 text-[10px] font-medium text-cc-code-fg/50 hover:text-cc-code-fg/80 hover:bg-white/5 transition-colors cursor-pointer border-l border-cc-border/20"
                aria-label={`Copy command: ${loginCommand}`}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="text-[10px] text-cc-muted/70 mt-1.5">{loginHint}</p>
          </div>

          {/* Check auth button */}
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 text-[11px] font-medium text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3" aria-hidden>
              <path d="M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.002 7.002 0 011.05 8.84a.75.75 0 01.656-.834zM8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.002 7.002 0 0114.95 7.16a.75.75 0 11-1.49.178A5.5 5.5 0 008 2.5z" />
            </svg>
            I've logged in — check again
          </button>

          {/* Divider + API key option */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-cc-border/50" />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="text-[10px] text-cc-muted/50 hover:text-cc-muted transition-colors cursor-pointer shrink-0"
            >
              {showKey ? "Hide API key" : "Or use an API key"}
            </button>
            <div className="flex-1 h-px bg-cc-border/50" />
          </div>

          {showKey && (
            <div>
              <label htmlFor={`key-${name}`} className="text-[11px] font-medium text-cc-muted block mb-1">{tokenLabel}</label>
              <input
                id={`key-${name}`}
                type="password"
                value={tokenValue}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder={tokenPlaceholder}
                className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code placeholder:text-cc-muted/30 focus:outline-none focus:ring-2 focus:ring-cc-primary/20 focus:border-cc-primary/40 transition-all"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Workspace ──────────────────────────────────────────────────────

function WorkspaceContent({ cwd, onCwdChange, onNext, onSkip }: Readonly<{
  cwd: string;
  onCwdChange: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}>) {
  return (
    <div>
      <h2 className="text-[18px] font-bold text-cc-fg tracking-tight">Your Workspace</h2>
      <p className="text-[13px] text-cc-muted mt-1 mb-5">
        Set a default working directory for new sessions. You can always change this per session.
      </p>

      <div className="mb-6">
        <label htmlFor="onboarding-cwd" className="text-[12px] font-medium text-cc-fg block mb-2">
          Project directory
        </label>
        <div className="relative">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-cc-muted/40" aria-hidden>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
            </svg>
          </div>
          <input
            id="onboarding-cwd"
            value={cwd}
            onChange={(e) => onCwdChange(e.target.value)}
            placeholder="/home/user/my-project"
            autoFocus
            className="w-full h-11 pl-10 pr-3 rounded-xl border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg font-mono-code placeholder:text-cc-muted/30 focus:outline-none focus:ring-2 focus:ring-cc-primary/20 focus:border-cc-primary/40 transition-all"
          />
        </div>
        <p className="text-[11px] text-cc-muted/60 mt-2">Use the absolute path to your project root, e.g. <code className="font-mono-code bg-cc-hover px-1 rounded text-[10px]">~/projects/my-app</code></p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onNext}
          className="flex-1 h-11 rounded-xl bg-cc-primary text-white text-[14px] font-semibold hover:bg-cc-primary-hover active:scale-[0.98] transition-all cursor-pointer shadow-sm"
        >
          Continue
        </button>
        <button
          onClick={onSkip}
          className="h-11 px-5 rounded-xl text-[13px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Tour ───────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5"><path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4M20 12v4H6a2 2 0 00-2 2c0 1.1.9 2 2 2h12v-4M20 12H9" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    title: "Multi-Session",
    desc: "Run multiple agents in parallel across different projects and backends",
    color: "text-cc-primary bg-cc-primary/10",
  },
  {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    title: "Permission Control",
    desc: "Approve or deny tool calls before they execute — full visibility and safety",
    color: "text-cc-success bg-cc-success/10",
  },
  {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5"><path d="M12 8V4H8M2 12h4M20 12h2M12 20v-4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" /></svg>,
    title: "Agent Profiles",
    desc: "Create persistent agents with custom prompts, webhooks, and cron schedules",
    color: "text-amber-500 bg-amber-500/10",
  },
  {
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" strokeLinejoin="round" /></svg>,
    title: "Collaboration",
    desc: "Share sessions with teammates and vote on permissions together",
    color: "text-purple-500 bg-purple-500/10",
  },
];

function TourContent({ onNext }: Readonly<{ onNext: () => void }>) {
  return (
    <div>
      <h2 className="text-[18px] font-bold text-cc-fg tracking-tight">What you can do</h2>
      <p className="text-[13px] text-cc-muted mt-1 mb-5">A quick look at Campfire's key capabilities.</p>

      <div className="grid grid-cols-2 gap-3 mb-6">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-xl border border-cc-border/50 p-4 hover:border-cc-border transition-colors">
            <div className={`w-9 h-9 rounded-lg ${f.color} flex items-center justify-center mb-3`}>
              {f.icon}
            </div>
            <h3 className="text-[13px] font-semibold text-cc-fg">{f.title}</h3>
            <p className="text-[11px] text-cc-muted leading-relaxed mt-1">{f.desc}</p>
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        autoFocus
        className="w-full h-11 rounded-xl bg-cc-primary text-white text-[14px] font-semibold hover:bg-cc-primary-hover active:scale-[0.98] transition-all cursor-pointer shadow-sm"
      >
        Let's Go
      </button>
    </div>
  );
}

// ─── Step 5: Launch ─────────────────────────────────────────────────────────

function LaunchContent({ cwd, onComplete }: Readonly<{ cwd: string; onComplete: () => void }>) {
  return (
    <div className="text-center py-4">
      {/* Success animation */}
      <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-cc-success/10 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-8 h-8 text-cc-success" aria-hidden>
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <h2 className="text-[22px] font-bold text-cc-fg tracking-tight">You're all set!</h2>
      <p className="text-[14px] text-cc-muted mt-2 max-w-[360px] mx-auto leading-relaxed">
        {cwd
          ? <>Your workspace is set to <code className="font-mono-code text-[12px] bg-cc-hover px-1.5 py-0.5 rounded">{cwd}</code></>
          : "Start your first session from the home page"
        }
      </p>
      <p className="text-[12px] text-cc-muted/50 mt-2">Providers and settings can be updated anytime.</p>

      <button
        onClick={onComplete}
        autoFocus
        className="w-full h-11 mt-8 rounded-xl bg-cc-primary text-white text-[14px] font-semibold hover:bg-cc-primary-hover active:scale-[0.98] transition-all cursor-pointer shadow-sm"
      >
        Open Campfire
      </button>
    </div>
  );
}
