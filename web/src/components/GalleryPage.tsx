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
  const [showCreate, setShowCreate] = useState(!!prefillSessionId);
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
      refresh();
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
      setShowCreate(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // ─── Stats ───────────────────────────────────────────────────────

  const totalVotes = entries.reduce((sum, e) => sum + e.votes, 0);
  const featuredCount = entries.filter((e) => e.featured).length;

  // ─── Layout ───────────────────────────────────────────────────────────

  const content = (
    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10 font-sans-ui antialiased">

      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-1">
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
          <p className="text-[11px] text-cc-fg/50 font-medium">Data</p>
          <h1 className="text-xl font-semibold text-cc-fg -mt-0.5">Session Gallery</h1>
        </div>
        <button
          onClick={() => { setShowCreate(!showCreate); }}
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
              Publish
            </>
          )}
        </button>
      </div>

      <p className="text-[13px] text-cc-fg/55 mb-5 ml-11">
        Showcase your best AI coding sessions. Vote, feature, and share.
      </p>

      {/* Stats bar */}
      <div className="flex items-center gap-4 mb-5 ml-11">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="text-cc-fg/40">Entries</span>
          <span className="font-semibold text-cc-fg">{entries.length}</span>
        </div>
        <div className="w-px h-3.5 bg-cc-border/40" />
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="text-cc-fg/40">Total Votes</span>
          <span className="font-semibold text-cc-fg">{totalVotes}</span>
        </div>
        {featuredCount > 0 && (
          <>
            <div className="w-px h-3.5 bg-cc-border/40" />
            <div className="flex items-center gap-1.5 text-[12px]">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-amber-500">
                <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
              </svg>
              <span className="font-semibold text-cc-fg">{featuredCount}</span>
            </div>
          </>
        )}
      </div>

      {/* Error/success banner */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-cc-error/8 border border-cc-error/15 text-[12px] text-cc-error flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0">
              <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 3a.75.75 0 00-.75.75v3.5a.75.75 0 001.5 0v-3.5A.75.75 0 008 4zm0 7a1 1 0 100-2 1 1 0 000 2z" />
            </svg>
            {error}
          </div>
          <button onClick={() => setError("")} className="text-cc-error/70 hover:text-cc-error text-[11px] font-medium cursor-pointer shrink-0 ml-3">
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-5 rounded-xl border border-cc-primary/30 bg-cc-card shadow-sm ring-1 ring-cc-primary/10 overflow-hidden">
          <div className="px-5 py-4 border-b border-cc-border/30">
            <h3 className="text-[13px] font-semibold text-cc-fg">Add to Gallery</h3>
            <p className="text-[11px] text-cc-fg/50 mt-0.5">Publish a session to the gallery for others to see.</p>
          </div>
          <div className="px-5 py-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5" htmlFor="gallery-session-id">Session ID</label>
                <input
                  id="gallery-session-id"
                  type="text"
                  value={createForm.sessionId}
                  onChange={(e) => setCreateForm({ ...createForm, sessionId: e.target.value })}
                  placeholder="Paste session ID"
                  className="w-full px-3.5 py-2.5 text-[12px] font-mono-code bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/35 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5" htmlFor="gallery-name">Name</label>
                <input
                  id="gallery-name"
                  type="text"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="e.g. Auth Refactor"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/35 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
                />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5" htmlFor="gallery-desc">Description</label>
              <textarea
                id="gallery-desc"
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                placeholder="What makes this session interesting? (optional)"
                rows={2}
                className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/35 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all resize-y"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-cc-fg/70 mb-1.5" htmlFor="gallery-tags">Tags</label>
              <input
                id="gallery-tags"
                type="text"
                value={createForm.tags}
                onChange={(e) => setCreateForm({ ...createForm, tags: e.target.value })}
                placeholder="auth, refactor, bug-fix (comma-separated)"
                className="w-full px-3.5 py-2.5 text-[13px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/35 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
              />
            </div>
            <div className="flex justify-end pt-1">
              <button
                onClick={handleCreate}
                disabled={!createForm.name.trim() || !createForm.sessionId.trim() || creating}
                className={`px-4 py-2 rounded-lg text-[12px] font-medium transition-all ${
                  createForm.name.trim() && createForm.sessionId.trim() && !creating
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm cursor-pointer"
                    : "bg-cc-hover text-cc-fg/35 cursor-not-allowed"
                }`}
              >
                {creating ? (
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Publishing...
                  </span>
                ) : (
                  "Publish to Gallery"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <select
          value={filterBackend}
          onChange={(e) => setFilterBackend(e.target.value)}
          className="px-3 py-2 text-[12px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 cursor-pointer transition-all"
          aria-label="Filter by backend"
        >
          <option value="">All Backends</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="goose">Goose</option>
          <option value="aider">Aider</option>
          <option value="openhands">OpenHands</option>
          <option value="openclaw">OpenClaw</option>
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="px-3 py-2 text-[12px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 cursor-pointer transition-all"
          aria-label="Sort by"
        >
          <option value="votes">Sort by Votes</option>
          <option value="recent">Sort by Recent</option>
          <option value="cost">Sort by Cost</option>
          <option value="duration">Sort by Duration</option>
        </select>

        <button
          onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
          className="px-3 py-2 text-[12px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg/60 hover:text-cc-fg transition-all cursor-pointer"
          title={sortOrder === "desc" ? "Descending" : "Ascending"}
          aria-label={`Sort order: ${sortOrder}`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3.5 h-3.5 transition-transform ${sortOrder === "asc" ? "rotate-180" : ""}`}>
            <path d="M3.5 3a.5.5 0 01.5.5v8.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 11.708-.708L3 12.293V3.5a.5.5 0 01.5-.5zM7 4.5a.5.5 0 01.5-.5h5a.5.5 0 010 1h-5a.5.5 0 01-.5-.5zM7.5 7a.5.5 0 000 1h3.5a.5.5 0 000-1H7.5zm0 3a.5.5 0 000 1h2a.5.5 0 000-1h-2z" />
          </svg>
        </button>

        <button
          onClick={() => setFilterFeatured(!filterFeatured)}
          className={`flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium rounded-lg transition-all cursor-pointer border ${
            filterFeatured
              ? "bg-amber-500/10 text-amber-600 border-amber-500/25"
              : "bg-cc-bg text-cc-fg/50 border-cc-border/60 hover:text-cc-fg hover:border-cc-border"
          }`}
          aria-pressed={filterFeatured}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
          </svg>
          Featured
        </button>

        <div className="flex-1 min-w-[120px]">
          <input
            type="text"
            value={filterTags}
            onChange={(e) => setFilterTags(e.target.value)}
            placeholder="Filter by tags..."
            className="w-full px-3 py-2 text-[12px] bg-cc-bg border border-cc-border/60 rounded-lg text-cc-fg placeholder:text-cc-fg/35 focus:outline-none focus:border-cc-primary/60 focus:ring-1 focus:ring-cc-primary/20 transition-all"
            aria-label="Filter by tags"
          />
        </div>
      </div>

      {/* Gallery entries */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16">
          <span className="w-6 h-6 border-2 border-cc-fg/10 border-t-cc-fg/50 rounded-full animate-spin mb-3" />
          <p className="text-[12px] text-cc-fg/50">Loading gallery...</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-cc-hover/70 flex items-center justify-center mb-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-fg/30">
              <path d="M2 7l10-5 10 5-10 5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3 className="text-[14px] font-semibold text-cc-fg mb-1">No gallery entries yet</h3>
          <p className="text-[12px] text-cc-fg/50 max-w-xs">
            Publish your best sessions to showcase them. Vote on entries to surface the most interesting ones.
          </p>
          {!showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 px-4 py-2 rounded-lg text-[12px] font-medium bg-cc-primary hover:bg-cc-primary-hover text-white shadow-sm transition-colors cursor-pointer"
            >
              Publish First Entry
            </button>
          )}
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
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto text-cc-fg">
        {content}
      </div>
    );
  }

  return (
    <div className="h-full bg-cc-bg overflow-y-auto text-cc-fg">
      {content}
    </div>
  );
}
