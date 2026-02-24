import { useState, useEffect, useCallback } from "react";
import { api, type GalleryEntryInfo } from "../api.js";
import { GalleryCard } from "./GalleryCard.js";

interface Props {
  embedded?: boolean;
  prefillSessionId?: string;
  prefillName?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GalleryPage({ embedded = false, prefillSessionId, prefillName }: Props) {
  const [entries, setEntries] = useState<GalleryEntryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filter state
  const [filterBackend, setFilterBackend] = useState("");
  const [filterFeatured, setFilterFeatured] = useState(false);
  const [filterTags, setFilterTags] = useState("");
  const [sortBy, setSortBy] = useState<"votes" | "cost" | "recent" | "duration">("votes");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // ClawHub state
  const [clawHubAvailable, setClawHubAvailable] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  // Moltbook state
  const [moltbookAvailable, setMoltbookAvailable] = useState(false);

  // Create form state
  const [createCollapsed, setCreateCollapsed] = useState(!prefillSessionId);
  const [createForm, setCreateForm] = useState({
    sessionId: prefillSessionId || "",
    name: prefillName || "",
    description: "",
    tags: "",
  });
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    const filter: Record<string, unknown> = {};
    if (filterBackend) filter.backend = filterBackend;
    if (filterFeatured) filter.featured = true;
    if (filterTags.trim()) filter.tags = filterTags.split(",").map((t) => t.trim()).filter(Boolean);
    if (sortBy) filter.sortBy = sortBy;
    if (sortOrder) filter.sortOrder = sortOrder;

    api.listGalleryEntries(filter as Parameters<typeof api.listGalleryEntries>[0])
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filterBackend, filterFeatured, filterTags, sortBy, sortOrder]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Check ClawHub and Moltbook availability on mount
  useEffect(() => {
    api.getClawHubStatus().then((s) => setClawHubAvailable(s.available)).catch(() => {});
    api.getMoltbookStatus().then((s) => setMoltbookAvailable(s.available)).catch(() => {});
  }, []);

  // ─── Handlers ───────────────────────────────────────────────────────

  async function handleVote(id: string, direction: 1 | -1) {
    // Optimistic update
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id ? { ...e, votes: e.votes + direction } : e,
      ),
    );
    try {
      const { votes } = await api.voteGalleryEntry(id, direction);
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, votes } : e)),
      );
    } catch {
      refresh(); // Revert on failure
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteGalleryEntry(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleFeature(id: string) {
    try {
      await api.featureGalleryEntry(id);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExportClawHub(id: string) {
    if (exportingId) return;
    setExportingId(id);
    setError("");
    try {
      const result = await api.exportToClawHub(id);
      if (result.ok) {
        setError(""); // Clear any previous error
        // Briefly show success — reuse error banner style
        setError(`Exported to ClawHub: ${result.output || "success"}`);
        setTimeout(() => setError(""), 5000);
      } else {
        setError(`ClawHub export failed: ${result.error}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportingId(null);
    }
  }

  async function handlePostMoltbook(id: string) {
    setError("");
    try {
      const result = await api.postToMoltbook(id);
      if (result.ok) {
        const link = result.postUrl ? ` — ${result.postUrl}` : "";
        setError(`Posted to Moltbook${link}`);
        setTimeout(() => setError(""), 5000);
      } else {
        setError(`Moltbook post failed: ${result.error}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreatePublicLink(id: string) {
    setError("");
    try {
      const result = await api.createPublicReplayLink(id);
      const fullUrl = `${window.location.origin}/${result.url}`;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullUrl);
        setError(`Public replay link copied to clipboard`);
      } else {
        // Fallback for non-secure contexts (HTTP)
        const textarea = document.createElement("textarea");
        textarea.value = fullUrl;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setError(`Public replay link copied to clipboard`);
      }
      setTimeout(() => setError(""), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreate() {
    const name = createForm.name.trim();
    const sessionId = createForm.sessionId.trim();
    if (!name || !sessionId) return;

    setCreating(true);
    setError("");

    try {
      await api.createGalleryEntry({
        sessionId,
        name,
        description: createForm.description.trim(),
        tags: createForm.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setCreateForm({ sessionId: "", name: "", description: "", tags: "" });
      setCreateCollapsed(true);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // ─── Renderers ───────────────────────────────────────────────────────

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error mb-4">
      {error}
      <button onClick={() => setError("")} className="ml-2 underline cursor-pointer">dismiss</button>
    </div>
  );

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {/* Backend filter */}
      <select
        value={filterBackend}
        onChange={(e) => setFilterBackend(e.target.value)}
        className="px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
      >
        <option value="">All Backends</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
        <option value="goose">Goose</option>
        <option value="aider">Aider</option>
        <option value="openhands">OpenHands</option>
        <option value="openclaw">OpenClaw</option>
      </select>

      {/* Sort */}
      <select
        value={sortBy}
        onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
        className="px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/50"
      >
        <option value="votes">Sort by Votes</option>
        <option value="recent">Sort by Recent</option>
        <option value="cost">Sort by Cost</option>
        <option value="duration">Sort by Duration</option>
      </select>

      {/* Sort order */}
      <button
        onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
        className="px-2 py-1.5 text-xs bg-cc-hover border border-cc-border rounded-lg text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
        title={sortOrder === "desc" ? "Descending" : "Ascending"}
      >
        {sortOrder === "desc" ? "Desc" : "Asc"}
      </button>

      {/* Featured toggle */}
      <button
        onClick={() => setFilterFeatured(!filterFeatured)}
        className={`px-2 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer border ${
          filterFeatured
            ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
            : "bg-cc-hover text-cc-muted border-cc-border hover:text-cc-fg"
        }`}
      >
        Featured
      </button>

      {/* Tags filter */}
      <input
        type="text"
        value={filterTags}
        onChange={(e) => setFilterTags(e.target.value)}
        placeholder="Filter by tags (comma-separated)"
        className="flex-1 min-w-[150px] px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />
    </div>
  );

  const createSection = (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
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
        <span className="text-sm font-medium text-cc-fg">Add to Gallery</span>
      </button>
      {!createCollapsed && (
        <div className="px-3 py-3 space-y-2.5">
          <input
            type="text"
            value={createForm.sessionId}
            onChange={(e) => setCreateForm({ ...createForm, sessionId: e.target.value })}
            placeholder="Session ID"
            className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 font-mono-code"
          />
          <input
            type="text"
            value={createForm.name}
            onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            placeholder="Entry name (e.g. Auth Refactor)"
            className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          />
          <textarea
            value={createForm.description}
            onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
            placeholder="Description (optional)"
            rows={2}
            className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
          />
          <input
            type="text"
            value={createForm.tags}
            onChange={(e) => setCreateForm({ ...createForm, tags: e.target.value })}
            placeholder="Tags (comma-separated, e.g. auth, refactor)"
            className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          />
          <button
            onClick={handleCreate}
            disabled={!createForm.name.trim() || !createForm.sessionId.trim() || creating}
            className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
              createForm.name.trim() && createForm.sessionId.trim() && !creating
                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                : "bg-cc-hover text-cc-muted cursor-not-allowed"
            }`}
          >
            {creating ? "Adding..." : "Add to Gallery"}
          </button>
        </div>
      )}
    </div>
  );

  const entriesGrid = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading gallery...</div>
  ) : entries.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No gallery entries yet. Add your best sessions to showcase them.
    </div>
  ) : (
    <div className="space-y-3">
      {entries.map((entry) => (
        <GalleryCard
          key={entry.id}
          entry={entry}
          onVote={handleVote}
          onDelete={handleDelete}
          onFeature={handleFeature}
          onExportClawHub={handleExportClawHub}
          clawHubAvailable={clawHubAvailable}
          onPostMoltbook={handlePostMoltbook}
          moltbookAvailable={moltbookAvailable}
          onCreatePublicLink={handleCreatePublicLink}
        />
      ))}
    </div>
  );

  // ─── Layout ───────────────────────────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Session Gallery</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Showcase your best AI coding sessions. Vote, feature, and share.
            </p>
          </div>
          {errorBanner}
          {filterBar}
          <div className="space-y-4">
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              {entriesGrid}
            </section>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              {createSection}
            </section>
          </div>
        </div>
      </div>
    );
  }

  // Fallback: standalone render
  return (
    <div className="h-full bg-cc-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <h1 className="text-xl font-semibold text-cc-fg mb-6">Session Gallery</h1>
        {errorBanner}
        {filterBar}
        {entriesGrid}
        <div className="mt-4">{createSection}</div>
      </div>
    </div>
  );
}
