import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api, type CompanionEnv } from "../api.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

interface VarRow {
  key: string;
  value: string;
}

/* ─── Helpers ──────────────────────────────────────────────────── */

function maskValue(v: string): string {
  if (v.length <= 6) return "••••••";
  return v.slice(0, 3) + "•".repeat(Math.min(v.length - 6, 20)) + v.slice(-3);
}

function varCount(n: number): string {
  return `${n} variable${n !== 1 ? "s" : ""}`;
}

/* ─── Component ────────────────────────────────────────────────── */

export function EnvManager({ onClose, embedded = false }: Props) {
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<VarRow[]>([]);
  const [error, setError] = useState("");
  const [revealedVars, setRevealedVars] = useState<Set<string>>(new Set());
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);

  // New env form
  const [newName, setNewName] = useState("");
  const [newVars, setNewVars] = useState<VarRow[]>([{ key: "", value: "" }]);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () => {
    api.listEnvs().then(setEnvs).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  function toggleReveal(slug: string) {
    setRevealedVars((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function startEdit(env: CompanionEnv) {
    setEditingSlug(env.slug);
    setEditName(env.name);
    const rows = Object.entries(env.variables).map(([key, value]) => ({ key, value }));
    if (rows.length === 0) rows.push({ key: "", value: "" });
    setEditVars(rows);
    setError("");
    setShowCreate(false);
  }

  function cancelEdit() {
    setEditingSlug(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingSlug) return;
    const variables: Record<string, string> = {};
    for (const row of editVars) {
      const k = row.key.trim();
      if (k) variables[k] = row.value;
    }
    try {
      await api.updateEnv(editingSlug, { name: editName.trim() || undefined, variables });
      setEditingSlug(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(slug: string) {
    try {
      await api.deleteEnv(slug);
      if (editingSlug === slug) setEditingSlug(null);
      setConfirmDeleteSlug(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const variables: Record<string, string> = {};
    for (const row of newVars) {
      const k = row.key.trim();
      if (k) variables[k] = row.value;
    }
    try {
      await api.createEnv(name, variables);
      setNewName("");
      setNewVars([{ key: "", value: "" }]);
      setError("");
      setShowCreate(false);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  /* ─── Profile Card ─────────────────────────────────────────────── */

  function renderProfileCard(env: CompanionEnv) {
    const isEditing = editingSlug === env.slug;
    const isRevealed = revealedVars.has(env.slug);
    const isConfirmingDelete = confirmDeleteSlug === env.slug;
    const varEntries = Object.entries(env.variables);

    return (
      <div
        key={env.slug}
        className={`rounded-xl border transition-all duration-200 overflow-hidden ${
          isEditing
            ? "border-cc-primary/40 bg-cc-card shadow-sm ring-1 ring-cc-primary/10"
            : "border-cc-border/60 bg-cc-card hover:border-cc-border"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Icon */}
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
            isEditing ? "bg-cc-primary/10" : "bg-cc-hover/70"
          }`}>
            <svg viewBox="0 0 16 16" fill="currentColor" className={`w-4 h-4 ${isEditing ? "text-cc-primary" : "text-cc-fg/50"}`}>
              <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
            </svg>
          </div>

          {/* Name + count */}
          <div className="flex-1 min-w-0">
            <h3 className="text-[13px] font-semibold text-cc-fg truncate">{env.name}</h3>
            <p className="text-[11px] text-cc-fg/50">{varCount(varEntries.length)}</p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1">
            {!isEditing && (
              <>
                {varEntries.length > 0 && (
                  <button
                    onClick={() => toggleReveal(env.slug)}
                    className="p-1.5 rounded-md text-cc-fg/40 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    title={isRevealed ? "Hide values" : "Reveal values"}
                    aria-label={isRevealed ? "Hide values" : "Reveal values"}
                  >
                    {isRevealed ? (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M2.5 2.5l11 11M6.2 6.2a2.5 2.5 0 003.6 3.6M4 4.5C2.8 5.5 1.8 7 1 8c1.5 2.5 3.8 5 7 5 .8 0 1.6-.2 2.3-.4M12 11.5c1.2-1 2.2-2.5 3-3.5-1.5-2.5-3.8-5-7-5-.8 0-1.6.2-2.3.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                        <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="8" cy="8" r="2.5" />
                      </svg>
                    )}
                  </button>
                )}
                <button
                  onClick={() => startEdit(env)}
                  className="p-1.5 rounded-md text-cc-fg/40 hover:text-cc-primary hover:bg-cc-primary/5 transition-colors cursor-pointer"
                  title="Edit profile"
                  aria-label="Edit profile"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  onClick={() => setConfirmDeleteSlug(env.slug)}
                  className="p-1.5 rounded-md text-cc-fg/40 hover:text-cc-error hover:bg-cc-error/5 transition-colors cursor-pointer"
                  title="Delete profile"
                  aria-label="Delete profile"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <path d="M3 4h10M5.5 4V2.5h5V4M6 6.5v5M10 6.5v5M4.5 4l.5 9.5h6l.5-9.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            {isEditing && (
              <button
                onClick={cancelEdit}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium text-cc-fg/60 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Delete confirmation */}
        {isConfirmingDelete && (
          <div className="px-4 py-3 bg-cc-error/5 border-t border-cc-error/10">
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-cc-error font-medium">Delete "{env.name}"?</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirmDeleteSlug(null)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium text-cc-fg/60 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(env.slug)}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-cc-error text-white hover:bg-cc-error/90 transition-colors cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit form */}
        {isEditing && (
          <div className="px-4 py-4 border-t border-cc-border/40 space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5">Profile name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Environment name"
                className="w-full px-3 py-2 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5">Variables</label>
              <VarEditor rows={editVars} onChange={setEditVars} />
            </div>
            <div className="flex justify-end pt-1">
              <button
                onClick={saveEdit}
                className="px-4 py-2 text-[12px] font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                Save Changes
              </button>
            </div>
          </div>
        )}

        {/* Variable preview (collapsed) */}
        {!isEditing && varEntries.length > 0 && (
          <div className="px-4 py-3 border-t border-cc-border/30 bg-cc-bg/50">
            <div className="space-y-1.5">
              {varEntries.map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono-code text-cc-fg font-medium shrink-0">{k}</span>
                  <span className="text-cc-fg/30">=</span>
                  <span className="font-mono-code text-cc-fg/50 truncate">
                    {isRevealed ? v : maskValue(v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ─── Embedded Layout ──────────────────────────────────────────── */

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto font-sans-ui antialiased">
        <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10">

          {/* Header with back button */}
          <div className="flex items-center gap-3 mb-6">
            <button
              onClick={() => { window.location.hash = ""; }}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-fg/60 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              aria-label="Go back"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-4 h-4">
                <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex-1">
              <p className="text-[11px] text-cc-fg/50 font-medium">Settings</p>
              <h1 className="text-xl font-semibold text-cc-fg -mt-0.5">Environments</h1>
            </div>
            <button
              onClick={() => { setShowCreate(!showCreate); setEditingSlug(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all cursor-pointer ${
                showCreate
                  ? "bg-cc-hover text-cc-fg"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm"
              }`}
            >
              {showCreate ? (
                <>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                  Cancel
                </>
              ) : (
                <>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                  New Profile
                </>
              )}
            </button>
          </div>

          <p className="text-[13px] text-cc-fg/60 mb-6">
            Create and manage reusable environment profiles. Variables are injected when starting new sessions.
          </p>

          {/* Error banner */}
          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-cc-error/8 border border-cc-error/15 text-[12px] text-cc-error flex items-center gap-2">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0">
                <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 3a.75.75 0 00-.75.75v3.5a.75.75 0 001.5 0v-3.5A.75.75 0 008 4zm0 7a1 1 0 100-2 1 1 0 000 2z" />
              </svg>
              {error}
            </div>
          )}

          {/* Create form (expandable) */}
          {showCreate && (
            <div className="mb-5 rounded-xl border border-cc-primary/30 bg-cc-card shadow-sm ring-1 ring-cc-primary/10 overflow-hidden">
              <div className="px-5 py-4 border-b border-cc-border/30">
                <h3 className="text-[13px] font-semibold text-cc-fg">New Environment Profile</h3>
                <p className="text-[11px] text-cc-fg/50 mt-0.5">Define a name and key-value pairs for this profile.</p>
              </div>
              <div className="px-5 py-4 space-y-4">
                <div>
                  <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5" htmlFor="new-env-name">
                    Profile name
                  </label>
                  <input
                    id="new-env-name"
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. production, staging, local"
                    className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newName.trim()) handleCreate();
                    }}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5">
                    Variables
                  </label>
                  <VarEditor rows={newVars} onChange={setNewVars} />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <p className="text-[11px] text-cc-fg/40">
                    {newVars.filter((r) => r.key.trim()).length} variable{newVars.filter((r) => r.key.trim()).length !== 1 ? "s" : ""} defined
                  </p>
                  <button
                    onClick={handleCreate}
                    disabled={!newName.trim() || creating}
                    className={`px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${
                      newName.trim() && !creating
                        ? "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm cursor-pointer"
                        : "bg-cc-hover text-cc-fg/35 cursor-not-allowed"
                    }`}
                  >
                    {creating ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Creating...
                      </span>
                    ) : (
                      "Create Profile"
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Profiles list */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <span className="w-6 h-6 border-2 border-cc-fg/10 border-t-cc-fg/50 rounded-full animate-spin mb-3" />
              <p className="text-[12px] text-cc-fg/50">Loading profiles...</p>
            </div>
          ) : envs.length === 0 && !showCreate ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-2xl bg-cc-hover/70 flex items-center justify-center mb-4">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-6 h-6 text-cc-fg/30">
                  <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
                </svg>
              </div>
              <h3 className="text-[14px] font-semibold text-cc-fg mb-1">No environment profiles</h3>
              <p className="text-[12px] text-cc-fg/50 max-w-xs">
                Create your first profile to store environment variables for session creation.
              </p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 px-4 py-2 rounded-lg text-[12px] font-medium bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm transition-colors cursor-pointer"
              >
                Create First Profile
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {envs.map((env) => renderProfileCard(env))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ─── Modal Layout (non-embedded) ──────────────────────────────── */

  const panel = (
    <div
      className="w-full max-w-lg max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-xl sm:rounded-xl shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border">
        <h2 className="text-sm font-semibold text-cc-fg">Manage Environments</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-fg/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-3">
        {error && (
          <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}
        {envs.map((env) => renderProfileCard(env))}

        {/* Inline create form for modal */}
        <div className="rounded-xl border border-cc-border/60 bg-cc-card overflow-hidden">
          <div className="px-4 py-3 border-b border-cc-border/30">
            <h3 className="text-[13px] font-semibold text-cc-fg">New Profile</h3>
          </div>
          <div className="px-4 py-3 space-y-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Profile name (e.g. production)"
              className="w-full px-3 py-2 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/40 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) handleCreate();
              }}
            />
            <VarEditor rows={newVars} onChange={setNewVars} />
            <div className="flex justify-end">
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className={`px-4 py-2 text-[12px] font-medium rounded-lg transition-all ${
                  newName.trim() && !creating
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm cursor-pointer"
                    : "bg-cc-hover text-cc-fg/35 cursor-not-allowed"
                }`}
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      {panel}
    </div>,
    document.body,
  );
}

/* ─── Key-Value Editor ─────────────────────────────────────────── */

function VarEditor({ rows, onChange }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void }) {
  function updateRow(i: number, field: "key" | "value", val: string) {
    const next = [...rows];
    next[i] = { ...next[i], [field]: val };
    onChange(next);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (next.length === 0) next.push({ key: "", value: "" });
    onChange(next);
  }

  function addRow() {
    onChange([...rows, { key: "", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={row.key}
            onChange={(e) => updateRow(i, "key", e.target.value)}
            placeholder="KEY"
            className="flex-1 min-w-0 px-3 py-2 text-[12px] font-mono-code bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/30 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
          />
          <span className="text-[11px] text-cc-fg/30 font-mono-code">=</span>
          <input
            type="text"
            value={row.value}
            onChange={(e) => updateRow(i, "value", e.target.value)}
            placeholder="value"
            className="flex-[1.5] min-w-0 px-3 py-2 text-[12px] font-mono-code bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/30 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
          />
          <button
            onClick={() => removeRow(i)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-fg/30 hover:text-cc-error hover:bg-cc-error/5 transition-colors cursor-pointer shrink-0"
            aria-label="Remove variable"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        className="flex items-center gap-1.5 text-[11px] font-medium text-cc-fg/45 hover:text-cc-primary transition-colors cursor-pointer pt-0.5"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
        Add variable
      </button>
    </div>
  );
}
