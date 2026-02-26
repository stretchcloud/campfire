import { useState, useEffect, useCallback } from "react";
import { api, type WebhookInfo } from "../api.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

const ALL_EVENTS = [
  { value: "session.created", label: "Session Created" },
  { value: "session.completed", label: "Session Completed" },
  { value: "session.failed", label: "Session Failed" },
  { value: "permission.requested", label: "Permission Requested" },
  { value: "permission.resolved", label: "Permission Resolved" },
  { value: "turn.completed", label: "Turn Completed" },
  { value: "cost.threshold", label: "Cost Threshold" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface WebhookFormData {
  name: string;
  url: string;
  events: string[];
  secret: string;
  format: string;
  backendFilter: string;
  cwdFilter: string;
}

const EMPTY_FORM: WebhookFormData = {
  name: "",
  url: "",
  events: ["session.completed"],
  secret: "",
  format: "generic",
  backendFilter: "",
  cwdFilter: "",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function WebhookManager({ onClose, embedded = false }: Props) {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<WebhookFormData>(EMPTY_FORM);
  const [createForm, setCreateForm] = useState<WebhookFormData>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createCollapsed, setCreateCollapsed] = useState(true);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Map<string, boolean>>(new Map());

  const refresh = useCallback(() => {
    api.listWebhooks().then(setWebhooks).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // ─── Create ──────────────────────────────────────────────────────────

  async function handleCreate() {
    const name = createForm.name.trim();
    const url = createForm.url.trim();
    if (!name || !url || createForm.events.length === 0) return;

    setCreating(true);
    setError("");

    try {
      const sessionFilter: { backendType?: string; cwd?: string } = {};
      if (createForm.backendFilter) sessionFilter.backendType = createForm.backendFilter;
      if (createForm.cwdFilter.trim()) sessionFilter.cwd = createForm.cwdFilter.trim();

      await api.createWebhook({
        name,
        url,
        events: createForm.events,
        secret: createForm.secret.trim() || undefined,
        format: createForm.format || undefined,
        sessionFilter: Object.keys(sessionFilter).length > 0 ? sessionFilter : undefined,
      });
      setCreateForm(EMPTY_FORM);
      setCreateCollapsed(true);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────

  function startEdit(wh: WebhookInfo) {
    setEditingId(wh.id);
    setEditForm({
      name: wh.name,
      url: wh.url,
      events: [...wh.events],
      secret: wh.secret || "",
      format: wh.format || "generic",
      backendFilter: wh.sessionFilter?.backendType || "",
      cwdFilter: wh.sessionFilter?.cwd || "",
    });
    setError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingId) return;
    const name = editForm.name.trim();
    const url = editForm.url.trim();
    if (!name || !url || editForm.events.length === 0) return;

    try {
      const sessionFilter: { backendType?: string; cwd?: string } = {};
      if (editForm.backendFilter) sessionFilter.backendType = editForm.backendFilter;
      if (editForm.cwdFilter.trim()) sessionFilter.cwd = editForm.cwdFilter.trim();

      await api.updateWebhook(editingId, {
        name,
        url,
        events: editForm.events,
        secret: editForm.secret.trim() || undefined,
        format: editForm.format || undefined,
        sessionFilter: Object.keys(sessionFilter).length > 0 ? sessionFilter : undefined,
      });
      setEditingId(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Actions ─────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await api.deleteWebhook(id);
      if (editingId === id) setEditingId(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleWebhook(id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTest(id: string) {
    setTestingIds((prev) => new Set(prev).add(id));
    setTestResults((prev) => { const n = new Map(prev); n.delete(id); return n; });
    try {
      const res = await api.testWebhook(id);
      setTestResults((prev) => new Map(prev).set(id, res.ok));
      refresh();
    } catch {
      setTestResults((prev) => new Map(prev).set(id, false));
    } finally {
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ─── Renderers ───────────────────────────────────────────────────────

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
      {error}
    </div>
  );

  const webhooksList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading webhooks...</div>
  ) : webhooks.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No webhooks configured. Create one below.
    </div>
  ) : (
    <div className="space-y-3">
      {webhooks.map((wh) => (
        <div key={wh.id} className="border border-cc-border rounded-lg overflow-hidden bg-cc-card">
          {/* Webhook header */}
          <div className="flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border">
            <span className="text-sm font-medium text-cc-fg flex-1 truncate">{wh.name}</span>

            {/* Delivery stats */}
            {wh.totalDeliveries > 0 && (
              <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${
                wh.failedDeliveries > 0
                  ? "text-cc-error bg-cc-error/10"
                  : "text-cc-success bg-cc-success/10"
              }`}>
                {wh.totalDeliveries - wh.failedDeliveries}/{wh.totalDeliveries}
              </span>
            )}

            {/* Toggle */}
            <button
              onClick={() => handleToggle(wh.id)}
              className={`relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0 ${
                wh.enabled ? "bg-cc-primary" : "bg-cc-border"
              }`}
              title={wh.enabled ? "Disable" : "Enable"}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                  wh.enabled ? "left-[16px]" : "left-[2px]"
                }`}
              />
            </button>

            {/* Action buttons */}
            {editingId === wh.id ? (
              <button
                onClick={cancelEdit}
                className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                Cancel
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleTest(wh.id)}
                  disabled={testingIds.has(wh.id)}
                  className={`text-xs cursor-pointer ${
                    testingIds.has(wh.id)
                      ? "text-cc-muted cursor-not-allowed"
                      : "text-cc-primary hover:text-cc-primary-hover"
                  }`}
                >
                  {testingIds.has(wh.id) ? "Testing..." : "Test"}
                </button>
                {testResults.has(wh.id) && (
                  <span className={`text-[10px] ${testResults.get(wh.id) ? "text-cc-success" : "text-cc-error"}`}>
                    {testResults.get(wh.id) ? "OK" : "Failed"}
                  </span>
                )}
                <button
                  onClick={() => startEdit(wh)}
                  className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(wh.id)}
                  className="text-xs text-cc-muted hover:text-cc-error cursor-pointer"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {/* Edit form (inline) */}
          {editingId === wh.id && (
            <div className="px-3 py-3 space-y-2.5">
              <WebhookForm form={editForm} onChange={setEditForm} />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveEdit}
                  className="px-3 py-2 text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Webhook details (collapsed) */}
          {editingId !== wh.id && (
            <div className="px-3 py-2.5 space-y-1.5">
              {/* URL */}
              <div className="text-xs text-cc-muted font-mono-code truncate" title={wh.url}>
                {wh.url}
              </div>

              {/* Event badges + info row */}
              <div className="flex flex-wrap items-center gap-1.5">
                {wh.events.map((ev) => (
                  <span
                    key={ev}
                    className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted"
                  >
                    {ev}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cc-muted">
                {wh.secret && (
                  <span className="flex items-center gap-1">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                      <path d="M8 1a3.5 3.5 0 00-3.5 3.5V7H4a1 1 0 00-1 1v5a1 1 0 001 1h8a1 1 0 001-1V8a1 1 0 00-1-1h-.5V4.5A3.5 3.5 0 008 1zm2 6H6V4.5a2 2 0 114 0V7z" />
                    </svg>
                    Signed
                  </span>
                )}

                {wh.lastDeliveryAt && (
                  <span className="flex items-center gap-1">
                    Last: {timeAgo(wh.lastDeliveryAt)}
                    {wh.lastDeliverySuccess ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-success">
                        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2.5-2.5a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-error">
                        <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                      </svg>
                    )}
                  </span>
                )}

                {wh.sessionFilter?.backendType && (
                  <span>Filter: {wh.sessionFilter.backendType}</span>
                )}
                {wh.sessionFilter?.cwd && (
                  <span className="font-mono-code truncate max-w-[200px]" title={wh.sessionFilter.cwd}>
                    {wh.sessionFilter.cwd}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const createSection = (
    <div className="border border-cc-border rounded-lg overflow-hidden bg-cc-card">
      <button
        onClick={() => setCreateCollapsed(!createCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border cursor-pointer hover:bg-cc-hover transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`w-3 h-3 text-cc-muted transition-transform ${createCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-medium text-cc-fg">New Webhook</span>
      </button>
      {!createCollapsed && (
        <div className="px-3 py-3 space-y-2.5">
          <WebhookForm form={createForm} onChange={setCreateForm} />
          <button
            onClick={handleCreate}
            disabled={!createForm.name.trim() || !createForm.url.trim() || createForm.events.length === 0 || creating}
            className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
              createForm.name.trim() && createForm.url.trim() && createForm.events.length > 0 && !creating
                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                : "bg-cc-hover text-cc-muted cursor-not-allowed"
            }`}
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      )}
    </div>
  );

  // ─── Layout ──────────────────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Webhooks</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Receive HTTP notifications when session events occur.
            </p>
          </div>
          {errorBanner}
          <div className="mt-4 space-y-4">
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-cc-fg">Configured Webhooks</h2>
              {webhooksList}
            </section>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              {createSection}
            </section>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Shared Webhook Form ─────────────────────────────────────────────────────

function WebhookForm({
  form,
  onChange,
}: {
  form: WebhookFormData;
  onChange: (form: WebhookFormData) => void;
}) {
  const update = (partial: Partial<WebhookFormData>) =>
    onChange({ ...form, ...partial });

  function toggleEvent(event: string) {
    const events = form.events.includes(event)
      ? form.events.filter((e) => e !== event)
      : [...form.events, event];
    update({ events });
  }

  return (
    <div className="space-y-2.5">
      {/* Name */}
      <input
        type="text"
        value={form.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Webhook name (e.g. Slack notifications)"
        className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />

      {/* URL */}
      <input
        type="text"
        value={form.url}
        onChange={(e) => update({ url: e.target.value })}
        placeholder="https://hooks.slack.com/services/..."
        className="w-full px-3 py-2 text-sm font-mono-code bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />

      {/* Format */}
      <div>
        <div className="text-[11px] font-medium text-cc-muted mb-1.5">Payload Format</div>
        <div className="flex gap-1.5">
          {[
            { value: "generic", label: "Generic" },
            { value: "slack", label: "Slack" },
            { value: "openclaw", label: "OpenClaw" },
          ].map((fmt) => (
            <button
              key={fmt.value}
              onClick={() => update({ format: fmt.value })}
              className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors cursor-pointer ${
                form.format === fmt.value
                  ? "bg-cc-primary/20 text-cc-primary border border-cc-primary/30"
                  : "bg-cc-hover text-cc-muted hover:text-cc-fg border border-transparent"
              }`}
            >
              {fmt.label}
            </button>
          ))}
        </div>
        {form.format === "openclaw" && (
          <div className="mt-1 text-[10px] text-cc-muted">
            Posts to OpenClaw /hooks/agent endpoint. Use the signing secret field for the Bearer token.
          </div>
        )}
      </div>

      {/* Events */}
      <div>
        <div className="text-[11px] font-medium text-cc-muted mb-1.5">Events</div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_EVENTS.map((ev) => (
            <button
              key={ev.value}
              onClick={() => toggleEvent(ev.value)}
              className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors cursor-pointer ${
                form.events.includes(ev.value)
                  ? "bg-cc-primary/20 text-cc-primary border border-cc-primary/30"
                  : "bg-cc-hover text-cc-muted hover:text-cc-fg border border-transparent"
              }`}
            >
              {ev.label}
            </button>
          ))}
        </div>
      </div>

      {/* Secret (optional) */}
      <input
        type="password"
        value={form.secret}
        onChange={(e) => update({ secret: e.target.value })}
        placeholder="Signing secret (optional, for HMAC-SHA256)"
        className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />

      {/* Session filter (optional) */}
      <div className="flex items-center gap-1.5">
        <select
          value={form.backendFilter}
          onChange={(e) => update({ backendFilter: e.target.value })}
          className="px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
        >
          <option value="">All backends</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="goose">Goose</option>
          <option value="aider">Aider</option>
          <option value="openhands">OpenHands</option>
          <option value="openclaw">OpenClaw</option>
        </select>
        <input
          type="text"
          value={form.cwdFilter}
          onChange={(e) => update({ cwdFilter: e.target.value })}
          placeholder="Filter by path prefix (optional)"
          className="flex-1 px-2 py-1.5 text-xs font-mono-code bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
        />
      </div>
    </div>
  );
}
