import { useState, useEffect } from "react";
import { api } from "../api.js";
import type { DmuxConfigFile } from "../api.js";

interface DmuxConfigEditorProps {
  cwd: string;
  onClose: () => void;
  onSaved?: () => void;
}

export function DmuxConfigEditor({ cwd, onClose, onSaved }: DmuxConfigEditorProps) {
  const [config, setConfig] = useState<DmuxConfigFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Editable fields
  const [sessionName, setSessionName] = useState("");
  const [branchPrefix, setBranchPrefix] = useState("");
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [autoRestart, setAutoRestart] = useState(false);

  useEffect(() => {
    api.getDmuxConfig(cwd)
      .then((cfg) => {
        setConfig(cfg);
        setSessionName(cfg?.session_name ?? "");
        setBranchPrefix(cfg?.branch_prefix ?? "");
        setDefaultPrompt(cfg?.default_prompt ?? "");
        setAutoRestart(cfg?.auto_restart ?? false);
        setRawJson(JSON.stringify(cfg, null, 2));
      })
      .catch((err) => setError(err.message || "Failed to load config"))
      .finally(() => setLoading(false));
  }, [cwd]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      if (rawMode) {
        // Validate JSON first
        let parsed: DmuxConfigFile;
        try {
          parsed = JSON.parse(rawJson);
        } catch {
          setJsonError("Invalid JSON");
          setSaving(false);
          return;
        }
        await api.replaceDmuxConfig(cwd, parsed);
      } else {
        const updates: Partial<DmuxConfigFile> = {};
        if (sessionName !== (config?.session_name ?? "")) updates.session_name = sessionName;
        if (branchPrefix !== (config?.branch_prefix ?? "")) updates.branch_prefix = branchPrefix;
        if (defaultPrompt !== (config?.default_prompt ?? "")) updates.default_prompt = defaultPrompt;
        if (autoRestart !== (config?.auto_restart ?? false)) updates.auto_restart = autoRestart;

        if (Object.keys(updates).length > 0) {
          await api.updateDmuxConfig(cwd, updates);
        }
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save config");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="bg-cc-card border border-cc-border rounded-xl p-6 max-w-lg w-full mx-4" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-cc-muted">Loading config...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-cc-card border border-cc-border rounded-xl p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-cc-fg">dmux Config</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setRawMode(!rawMode);
                if (!rawMode) {
                  // Sync form values to raw JSON
                  const current = {
                    ...config,
                    session_name: sessionName || undefined,
                    branch_prefix: branchPrefix || undefined,
                    default_prompt: defaultPrompt || undefined,
                    auto_restart: autoRestart,
                  };
                  setRawJson(JSON.stringify(current, null, 2));
                }
                setJsonError(null);
              }}
              className="text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              {rawMode ? "Form View" : "Raw JSON"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
            >
              &times;
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-2 rounded bg-red-500/10 border border-red-500/30 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto space-y-4">
          {rawMode ? (
            <div>
              <textarea
                value={rawJson}
                onChange={(e) => {
                  setRawJson(e.target.value);
                  setJsonError(null);
                }}
                className="w-full h-64 bg-cc-bg border border-cc-border rounded-lg p-3 text-sm font-mono text-cc-fg resize-none focus:outline-none focus:border-cc-primary"
                spellCheck={false}
              />
              {jsonError && (
                <p className="mt-1 text-xs text-red-400">{jsonError}</p>
              )}
            </div>
          ) : (
            <>
              {/* Session Name */}
              <div>
                <label className="block text-xs font-medium text-cc-muted mb-1">Session Name</label>
                <input
                  type="text"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  className="w-full bg-cc-bg border border-cc-border rounded-lg px-3 py-2 text-sm text-cc-fg focus:outline-none focus:border-cc-primary"
                  placeholder="e.g., dmux-myproject"
                />
              </div>

              {/* Branch Prefix */}
              <div>
                <label className="block text-xs font-medium text-cc-muted mb-1">Branch Prefix</label>
                <input
                  type="text"
                  value={branchPrefix}
                  onChange={(e) => setBranchPrefix(e.target.value)}
                  className="w-full bg-cc-bg border border-cc-border rounded-lg px-3 py-2 text-sm text-cc-fg focus:outline-none focus:border-cc-primary"
                  placeholder="e.g., dmux/"
                />
              </div>

              {/* Default Prompt */}
              <div>
                <label className="block text-xs font-medium text-cc-muted mb-1">Default Prompt</label>
                <textarea
                  value={defaultPrompt}
                  onChange={(e) => setDefaultPrompt(e.target.value)}
                  className="w-full bg-cc-bg border border-cc-border rounded-lg px-3 py-2 text-sm text-cc-fg resize-none focus:outline-none focus:border-cc-primary"
                  rows={3}
                  placeholder="Default prompt for new panes..."
                />
              </div>

              {/* Auto Restart */}
              <div className="flex items-center justify-between">
                <label className="text-sm text-cc-fg">Auto Restart</label>
                <button
                  type="button"
                  onClick={() => setAutoRestart(!autoRestart)}
                  className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${
                    autoRestart ? "bg-cc-primary" : "bg-cc-border"
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full bg-white transition-transform ${
                      autoRestart ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Read-only pane list */}
              {config?.panes && config.panes.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-cc-muted mb-1">
                    Panes <span className="text-cc-muted/50">(read-only, managed by dmux)</span>
                  </label>
                  <div className="space-y-1">
                    {config.panes.map((p, i) => (
                      <div
                        key={p.id || i}
                        className="text-xs font-mono text-cc-muted bg-cc-bg rounded px-2 py-1 border border-cc-border"
                      >
                        {p.slug || p.id || `pane-${i}`} — {p.agent || "unknown"}{" "}
                        {p.branch ? `(${p.branch})` : ""}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-cc-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
