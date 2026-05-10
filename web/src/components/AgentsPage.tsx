import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { api, type AgentProfileInfo, type AgentExecutionInfo, type CampfireEnv } from "../api.js";

const CodeEditor = lazy(() => import("./CodeEditor.js").then((m) => ({ default: m.CodeEditor })));
import { getModelsForBackend, getDefaultModel, getModesForBackend, getDefaultMode } from "../utils/backends.js";
import type { BackendType } from "../types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

const BACKEND_COLORS: Record<string, string> = {
  claude: "text-[#5BA8A0] bg-[#5BA8A0]/10",
  codex: "text-blue-500 bg-blue-500/10",
  goose: "text-amber-500 bg-amber-500/10",
  aider: "text-purple-500 bg-purple-500/10",
  openhands: "text-rose-500 bg-rose-500/10",
  openclaw: "text-orange-500 bg-orange-500/10",
  opencode: "text-teal-500 bg-teal-500/10",
};

const BACKEND_OPTIONS: { value: BackendType; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "goose", label: "Goose" },
  { value: "aider", label: "Aider" },
  { value: "openhands", label: "OpenHands" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "opencode", label: "OpenCode" },
];

// ─── Form Data ──────────────────────────────────────────────────────────────

interface AgentFormData {
  name: string;
  description: string;
  icon: string;
  backendType: BackendType;
  model: string;
  permissionMode: string;
  cwd: string;
  prompt: string;
  envSlug: string;
  webhookEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleExpression: string;
  scheduleRecurring: boolean;
  codexInternetAccess: boolean;
}

const EMPTY_FORM: AgentFormData = {
  name: "",
  description: "",
  icon: "\u{1F916}",
  backendType: "claude",
  model: getDefaultModel("claude"),
  permissionMode: getDefaultMode("claude"),
  cwd: "",
  prompt: "",
  envSlug: "",
  webhookEnabled: false,
  scheduleEnabled: false,
  scheduleExpression: "0 8 * * *",
  scheduleRecurring: true,
  codexInternetAccess: false,
};

const CRON_PRESETS = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Daily at 8am", value: "0 8 * * *" },
  { label: "Every 2 hours", value: "0 */2 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
];

const ICON_OPTIONS = ["\u{1F916}", "\u{1F525}", "\u{26A1}", "\u{1F680}", "\u{1F9EA}", "\u{1F527}", "\u{1F4CB}", "\u{1F50D}", "\u{1F3AF}", "\u{1F4E6}"];

// ─── Component ──────────────────────────────────────────────────────────────

export function AgentsPage({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const [agents, setAgents] = useState<AgentProfileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<AgentFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [runInputAgent, setRunInputAgent] = useState<AgentProfileInfo | null>(null);
  const [runInput, setRunInput] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<AgentExecutionInfo[]>([]);
  const [filter, setFilter] = useState<"all" | "enabled" | "scheduled" | "webhook">("all");
  const [envs, setEnvs] = useState<CampfireEnv[]>([]);

  const refresh = useCallback(() => {
    api.listAgents().then(setAgents).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    api.listEnvs().then(setEnvs).catch(() => {});
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Load executions when expanding
  useEffect(() => {
    if (!expandedId) return;
    api.getAgentExecutions(expandedId).then(setExecutions).catch(() => setExecutions([]));
  }, [expandedId]);

  // ─── CRUD Handlers ────────────────────────────────────────────────────

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError("");
  }

  function openEdit(agent: AgentProfileInfo) {
    setEditingId(agent.id);
    setForm({
      name: agent.name,
      description: agent.description,
      icon: agent.icon || "\u{1F916}",
      backendType: agent.backendType as BackendType,
      model: agent.model,
      permissionMode: agent.permissionMode,
      cwd: agent.cwd,
      prompt: agent.prompt,
      envSlug: agent.envSlug || "",
      webhookEnabled: agent.triggers?.webhook?.enabled || false,
      scheduleEnabled: agent.triggers?.schedule?.enabled || false,
      scheduleExpression: agent.triggers?.schedule?.expression || "0 8 * * *",
      scheduleRecurring: agent.triggers?.schedule?.recurring ?? true,
      codexInternetAccess: agent.codexInternetAccess || false,
    });
    setShowForm(true);
    setError("");
  }

  async function handleSave() {
    if (!form.name.trim() || !form.prompt.trim() || !form.cwd.trim()) {
      setError("Name, prompt, and working directory are required");
      return;
    }
    setSaving(true);
    setError("");

    const payload: Partial<AgentProfileInfo> = {
      name: form.name,
      description: form.description,
      icon: form.icon,
      backendType: form.backendType,
      model: form.backendType === "codex" ? "" : form.model,
      permissionMode: form.permissionMode,
      cwd: form.cwd,
      prompt: form.prompt,
      envSlug: form.envSlug || undefined,
      codexInternetAccess: form.backendType === "codex" ? form.codexInternetAccess : undefined,
      triggers: {
        webhook: { enabled: form.webhookEnabled },
        schedule: form.scheduleEnabled ? {
          enabled: true,
          expression: form.scheduleExpression,
          recurring: form.scheduleRecurring,
        } : { enabled: false, expression: "", recurring: true },
      },
    };

    try {
      if (editingId) {
        await api.updateAgentProfile(editingId, payload);
      } else {
        await api.createAgent(payload);
      }
      setShowForm(false);
      setEditingId(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteAgent(id);
      refresh();
    } catch { /* ignore */ }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleAgent(id);
      refresh();
    } catch { /* ignore */ }
  }

  async function handleRun(agent: AgentProfileInfo) {
    if (agent.prompt.includes("{{input}}")) {
      setRunInputAgent(agent);
      setRunInput("");
    } else {
      try {
        await api.runAgent(agent.id);
        refresh();
      } catch { /* ignore */ }
    }
  }

  async function handleRunWithInput() {
    if (!runInputAgent) return;
    try {
      await api.runAgent(runInputAgent.id, runInput);
      setRunInputAgent(null);
      refresh();
    } catch { /* ignore */ }
  }

  // ─── Filtering ────────────────────────────────────────────────────────

  const filteredAgents = agents.filter((a) => {
    if (filter === "enabled") return a.enabled;
    if (filter === "scheduled") return a.triggers?.schedule?.enabled;
    if (filter === "webhook") return a.triggers?.webhook?.enabled;
    return true;
  });

  const counts = {
    all: agents.length,
    enabled: agents.filter((a) => a.enabled).length,
    scheduled: agents.filter((a) => a.triggers?.schedule?.enabled).length,
    webhook: agents.filter((a) => a.triggers?.webhook?.enabled).length,
  };

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className={embedded ? "px-4 py-6 max-w-4xl mx-auto" : "p-6 max-w-4xl mx-auto"}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-cc-fg">Agents</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">Persistent agent profiles with automated triggers</p>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer"
        >
          + Create Agent
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4">
        {(["all", "enabled", "scheduled", "webhook"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
              filter === f
                ? "bg-cc-primary/10 text-cc-primary"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1 text-[10px] opacity-60 tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>

      {/* Agent list */}
      {loading && <p className="text-cc-muted text-sm">Loading...</p>}
      {!loading && filteredAgents.length === 0 && (
        <div className="text-center py-12 text-cc-muted">
          <p className="text-sm">No agents yet</p>
          <p className="text-xs mt-1">Create your first agent to automate tasks across any backend</p>
        </div>
      )}

      <div className="space-y-2">
        {filteredAgents.map((agent) => (
          <div key={agent.id}>
            <AgentCard
              agent={agent}
              onEdit={() => openEdit(agent)}
              onDelete={() => handleDelete(agent.id)}
              onToggle={() => handleToggle(agent.id)}
              onRun={() => handleRun(agent)}
              expanded={expandedId === agent.id}
              onExpand={() => setExpandedId(expandedId === agent.id ? null : agent.id)}
            />
            {expandedId === agent.id && (
              <div className="ml-8 mt-1 mb-3 space-y-1">
                {executions.length === 0 && <p className="text-[11px] text-cc-muted">No executions yet</p>}
                {executions.slice(0, 10).map((ex) => (
                  <div key={ex.executionId} className="flex items-center gap-2 text-[11px] text-cc-muted px-2 py-1 rounded bg-cc-hover/50">
                    <span className={`w-1.5 h-1.5 rounded-full ${executionDotClass(ex)}`} />
                    <span className="font-mono-code">{ex.trigger}</span>
                    <span className="flex-1 truncate">{ex.input ? `"${ex.input.slice(0, 40)}"` : ""}</span>
                    <span className="font-mono-code tabular-nums">{timeAgo(ex.startedAt)}</span>
                    {ex.error && <span className="text-cc-error truncate max-w-[120px]">{ex.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ─── Create/Edit Form ──────────────────────────────────────── */}
      {showForm && (
        <dialog open className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm w-full h-full m-0 p-0 border-none">
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-cc-card border border-cc-border rounded-xl shadow-float p-5 m-auto">
            <h2 className="text-sm font-semibold text-cc-fg mb-4">{editingId ? "Edit Agent" : "Create Agent"}</h2>

            {error && <p className="text-[11px] text-cc-error mb-3 bg-cc-error/5 px-3 py-1.5 rounded">{error}</p>}

            <div className="space-y-3">
              {/* Icon + Name */}
              <div className="flex gap-2">
                <select
                  value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })}
                  className="w-12 h-9 rounded-lg border border-cc-border bg-cc-input-bg text-center text-base cursor-pointer"
                >
                  {ICON_OPTIONS.map((ic) => <option key={ic} value={ic}>{ic}</option>)}
                </select>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Agent name"
                  className="flex-1 h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg"
                />
              </div>

              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Short description (optional)"
                className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg"
              />

              {/* Backend + Model */}
              <div className="flex gap-2">
                <select
                  value={form.backendType}
                  onChange={(e) => {
                    const bt = e.target.value as BackendType;
                    setForm({ ...form, backendType: bt, model: getDefaultModel(bt), permissionMode: getDefaultMode(bt) });
                  }}
                  className="h-9 px-2 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg cursor-pointer"
                >
                  {BACKEND_OPTIONS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </select>
                {form.backendType === "codex" ? (
                  <div className="flex-1 h-9 px-2 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-muted flex items-center">
                    Codex default
                  </div>
                ) : (
                  <select
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    className="flex-1 h-9 px-2 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg cursor-pointer"
                  >
                    {getModelsForBackend(form.backendType).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                )}
              </div>

              {/* Permission mode */}
              <select
                value={form.permissionMode}
                onChange={(e) => setForm({ ...form, permissionMode: e.target.value })}
                className="w-full h-9 px-2 rounded-lg border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg cursor-pointer"
              >
                {getModesForBackend(form.backendType).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>

              {/* Working directory */}
              <input
                value={form.cwd}
                onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                placeholder="Working directory (absolute path)"
                className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg font-mono-code"
              />

              {/* Environment profile — important for Codex (API keys), useful for all backends */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label htmlFor="agent-env-select" className="text-[11px] text-cc-muted font-medium">Environment</label>
                  {form.backendType === "codex" && !form.envSlug && (
                    <span className="text-[9px] text-cc-warning font-medium px-1.5 rounded-full bg-cc-warning/10">
                      Codex requires OPENAI_API_KEY
                    </span>
                  )}
                </div>
                <select
                  id="agent-env-select"
                  value={form.envSlug}
                  onChange={(e) => setForm({ ...form, envSlug: e.target.value })}
                  className={`w-full h-9 px-2 rounded-lg border bg-cc-input-bg text-[12px] text-cc-fg cursor-pointer ${
                    form.backendType === "codex" && !form.envSlug
                      ? "border-cc-warning/50"
                      : "border-cc-border"
                  }`}
                >
                  <option value="">No environment profile</option>
                  {envs.map((env) => (
                    <option key={env.slug} value={env.slug}>
                      {env.name} ({Object.keys(env.variables).length} vars)
                    </option>
                  ))}
                </select>
                {form.envSlug && envs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {Object.keys(envs.find((e) => e.slug === form.envSlug)?.variables || {}).map((key) => (
                      <span key={key} className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
                        {key}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Prompt (Monaco Editor) */}
              <div>
                <label className="text-[11px] font-medium text-cc-muted block mb-1">Prompt</label>
                <Suspense fallback={<div className="h-[180px] rounded-xl border border-cc-border flex items-center justify-center text-cc-muted text-[12px]">Loading editor...</div>}>
                  <CodeEditor
                    value={form.prompt}
                    onChange={(val) => setForm({ ...form, prompt: val })}
                    language="markdown"
                    height="180px"
                    minimap={false}
                    wordWrap
                    ariaLabel="Agent prompt editor. Use {{input}} as a placeholder for trigger input."
                  />
                </Suspense>
              </div>

              {/* Codex internet access */}
              {form.backendType === "codex" && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.codexInternetAccess}
                    onChange={(e) => setForm({ ...form, codexInternetAccess: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-[12px] text-cc-fg">Enable internet access (Codex)</span>
                </label>
              )}

              {/* Triggers */}
              <div className="border border-cc-border/50 rounded-lg p-3 space-y-2.5">
                <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider">Triggers</span>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.webhookEnabled}
                    onChange={(e) => setForm({ ...form, webhookEnabled: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-[12px] text-cc-fg">Webhook</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.scheduleEnabled}
                    onChange={(e) => setForm({ ...form, scheduleEnabled: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-[12px] text-cc-fg">Schedule</span>
                </label>

                {form.scheduleEnabled && (
                  <div className="ml-5 space-y-2">
                    <div className="flex gap-1.5 flex-wrap">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.value}
                          type="button"
                          onClick={() => setForm({ ...form, scheduleExpression: p.value })}
                          className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
                            form.scheduleExpression === p.value
                              ? "bg-cc-primary/10 text-cc-primary"
                              : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <input
                      value={form.scheduleExpression}
                      onChange={(e) => setForm({ ...form, scheduleExpression: e.target.value })}
                      placeholder="Cron expression"
                      className="w-full h-8 px-2 rounded border border-cc-border bg-cc-input-bg text-[12px] text-cc-fg font-mono-code"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowForm(false)}
                className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-40"
              >
                {saveButtonLabel(saving, editingId)}
              </button>
            </div>
          </div>
        </dialog>
      )}

      {/* ─── Run Input Modal ───────────────────────────────────────── */}
      {runInputAgent && (
        <dialog open className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm w-full h-full m-0 p-0 border-none">
          <div className="w-full max-w-md bg-cc-card border border-cc-border rounded-xl shadow-float p-5 m-auto">
            <h2 className="text-sm font-semibold text-cc-fg mb-1">Run {runInputAgent.name}</h2>
            <p className="text-[11px] text-cc-muted mb-3">This agent uses {"{{input}}"} in its prompt. Provide the input below.</p>
            <textarea
              value={runInput}
              onChange={(e) => setRunInput(e.target.value)}
              placeholder="Enter input..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg resize-y"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRunInputAgent(null)} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer">Cancel</button>
              <button
                onClick={handleRunWithInput}
                className="px-4 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer"
              >
                Run
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}

function executionDotClass(ex: AgentExecutionInfo): string {
  if (ex.success === false) return "bg-cc-error";
  if (ex.completedAt) return "bg-cc-success";
  return "bg-cc-primary animate-breathing";
}

function saveButtonLabel(saving: boolean, editingId: string | null): string {
  if (saving) return "Saving...";
  if (editingId) return "Update";
  return "Create";
}

function agentStatusDotClass(agent: AgentProfileInfo): string {
  if (agent.isRunning) return "bg-cc-primary animate-breathing";
  if (agent.enabled) return "bg-cc-success";
  return "bg-cc-muted/40";
}

// ─── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({
  agent, onEdit, onDelete, onToggle, onRun, expanded, onExpand,
}: Readonly<{
  agent: AgentProfileInfo;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  expanded: boolean;
  onExpand: () => void;
}>) {
  const backendColor = BACKEND_COLORS[agent.backendType] || "text-cc-muted bg-cc-hover";

  return (
    <div className={`border rounded-lg transition-all ${
      agent.enabled
        ? "border-cc-border bg-cc-card hover:shadow-panel"
        : "border-cc-border/50 bg-cc-card/60 opacity-70"
    }`}>
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Icon + status */}
        <button onClick={onExpand} className="relative text-lg shrink-0 cursor-pointer" title="Show executions">
          {agent.icon || "\u{1F916}"}
          <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-cc-card ${
            agentStatusDotClass(agent)
          }`} />
        </button>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-cc-fg truncate">{agent.name}</span>
            <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] ${backendColor}`}>
              {agent.backendType}
            </span>
            {agent.isRunning && (
              <span className="text-[9px] text-cc-primary font-mono-code">running</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-cc-muted">
            {agent.description && <span className="truncate max-w-[200px]">{agent.description}</span>}
            {agent.triggers?.schedule?.enabled && <span className="font-mono-code">scheduled</span>}
            {agent.triggers?.webhook?.enabled && <span className="font-mono-code">webhook</span>}
            {agent.totalRuns > 0 && <span className="tabular-nums">{agent.totalRuns} runs</span>}
            {agent.lastRunAt != null && <span className="tabular-nums">{timeAgo(agent.lastRunAt)}</span>}
            {agent.nextRunAt != null && <span className="tabular-nums">next {timeUntil(agent.nextRunAt)}</span>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onRun}
            title="Run now"
            className="p-1.5 rounded-md hover:bg-cc-hover transition-colors cursor-pointer text-cc-primary"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M4 2l10 6-10 6V2z" />
            </svg>
          </button>
          <button onClick={onToggle} title={agent.enabled ? "Disable" : "Enable"} className="p-1.5 rounded-md hover:bg-cc-hover transition-colors cursor-pointer text-cc-muted">
            {agent.enabled ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-success">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm3.22 4.78l-4 4a.75.75 0 01-1.06 0l-2-2a.75.75 0 011.06-1.06L6.5 9l3.47-3.47a.75.75 0 011.06 1.06z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z" />
              </svg>
            )}
          </button>
          <button onClick={onEdit} title="Edit" className="p-1.5 rounded-md hover:bg-cc-hover transition-colors cursor-pointer text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61z" />
            </svg>
          </button>
          <button onClick={onDelete} title="Delete" className="p-1.5 rounded-md hover:bg-cc-hover transition-colors cursor-pointer text-cc-muted hover:text-cc-error">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.928l.856 10.268A1.75 1.75 0 006.282 16h3.436a1.75 1.75 0 001.748-1.632l.856-10.268h.928a.75.75 0 000-1.5H11z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
