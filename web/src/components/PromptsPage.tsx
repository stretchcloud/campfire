import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";
import type { Prompt } from "../types.js";

interface PromptFormState {
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath: string;
}

const EMPTY_FORM: PromptFormState = {
  name: "",
  content: "",
  scope: "global",
  projectPath: "",
};

export function PromptsPage({ embedded }: { embedded?: boolean }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PromptFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadPrompts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listPrompts();
      setPrompts(list);
    } catch (e) {
      setError("Failed to load prompts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  const filteredPrompts = prompts.filter(
    (p) =>
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.content.toLowerCase().includes(search.toLowerCase()),
  );

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowForm(true);
  }

  function startEdit(prompt: Prompt) {
    setEditingId(prompt.id);
    setForm({
      name: prompt.name,
      content: prompt.content,
      scope: prompt.scope,
      projectPath: prompt.projectPath ?? "",
    });
    setFormError(null);
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.content.trim()) {
      setFormError("Name and content are required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await api.updatePrompt(editingId, {
          name: form.name.trim(),
          content: form.content.trim(),
          scope: form.scope,
          projectPath: form.scope === "project" ? form.projectPath.trim() || undefined : undefined,
        });
      } else {
        await api.createPrompt({
          name: form.name.trim(),
          content: form.content.trim(),
          scope: form.scope,
          projectPath: form.scope === "project" ? form.projectPath.trim() || undefined : undefined,
        });
      }
      cancelForm();
      await loadPrompts();
    } catch (e) {
      setFormError("Failed to save prompt.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this prompt?")) return;
    try {
      await api.deletePrompt(id);
      setPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch {
      setError("Failed to delete prompt.");
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-cc-fg">Prompt Library</h2>
            <p className="text-sm text-cc-muted mt-0.5">
              Save reusable prompts and insert them with @ in the composer.
            </p>
          </div>
          <button
            onClick={startCreate}
            className="px-3 py-1.5 rounded-lg bg-cc-primary text-white text-sm font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer"
          >
            + New Prompt
          </button>
        </div>

        {/* Search */}
        <div className="mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts..."
            className="w-full px-3 py-2 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-sm focus:outline-none focus:border-cc-primary/50"
          />
        </div>

        {/* Inline form */}
        {showForm && (
          <div className="mb-6 p-4 rounded-lg border border-cc-border bg-cc-card">
            <h3 className="text-sm font-medium text-cc-fg mb-3">
              {editingId ? "Edit Prompt" : "New Prompt"}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-cc-muted mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Code review checklist"
                  className="w-full px-3 py-1.5 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-sm focus:outline-none focus:border-cc-primary/50"
                />
              </div>
              <div>
                <label className="block text-xs text-cc-muted mb-1">Content</label>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="The prompt text..."
                  rows={5}
                  className="w-full px-3 py-1.5 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-sm font-mono-code resize-y focus:outline-none focus:border-cc-primary/50"
                />
              </div>
              <div className="flex gap-4">
                <div>
                  <label className="block text-xs text-cc-muted mb-1">Scope</label>
                  <select
                    value={form.scope}
                    onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as "global" | "project" }))}
                    className="px-2 py-1.5 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-sm focus:outline-none focus:border-cc-primary/50"
                  >
                    <option value="global">Global</option>
                    <option value="project">Project</option>
                  </select>
                </div>
                {form.scope === "project" && (
                  <div className="flex-1">
                    <label className="block text-xs text-cc-muted mb-1">Project path</label>
                    <input
                      type="text"
                      value={form.projectPath}
                      onChange={(e) => setForm((f) => ({ ...f, projectPath: e.target.value }))}
                      placeholder="/home/user/my-project"
                      className="w-full px-3 py-1.5 rounded-lg border border-cc-border bg-cc-input-bg text-cc-fg text-sm font-mono-code focus:outline-none focus:border-cc-primary/50"
                    />
                  </div>
                )}
              </div>
              {formError && (
                <p className="text-xs text-cc-error">{formError}</p>
              )}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={cancelForm}
                  className="px-3 py-1.5 rounded-lg border border-cc-border text-cc-muted text-sm hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                    saving
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-cc-primary text-white hover:bg-cc-primary-hover"
                  }`}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="text-sm text-cc-muted">Loading...</div>
        ) : error ? (
          <div className="text-sm text-cc-error">{error}</div>
        ) : filteredPrompts.length === 0 ? (
          <div className="text-center py-12 text-cc-muted">
            {search ? (
              <p className="text-sm">No prompts match "{search}"</p>
            ) : (
              <>
                <p className="text-sm mb-2">No prompts yet.</p>
                <button
                  onClick={startCreate}
                  className="text-sm text-cc-primary hover:text-cc-primary-hover transition-colors cursor-pointer"
                >
                  Create your first prompt
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredPrompts.map((prompt) => (
              <div
                key={prompt.id}
                className="p-4 rounded-lg border border-cc-border bg-cc-card group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-cc-fg">{prompt.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted border border-cc-border capitalize">
                        {prompt.scope}
                      </span>
                    </div>
                    {prompt.scope === "project" && prompt.projectPath && (
                      <p className="text-xs text-cc-muted font-mono-code mt-0.5">{prompt.projectPath}</p>
                    )}
                    <p className="text-xs text-cc-muted mt-1 line-clamp-2 whitespace-pre-line">
                      {prompt.content}
                    </p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => startEdit(prompt)}
                      className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(prompt.id)}
                      className="px-2 py-1 rounded text-xs text-cc-error hover:text-cc-error/80 transition-colors cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
