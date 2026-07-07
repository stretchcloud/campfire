import { useState, useEffect } from "react";
import { api, type MemoryOverviewResponse } from "../api.js";
import { useStore } from "../store.js";
import type { MemoryFragment, ConsolidatedKnowledge } from "../types.js";

/** v2 servers report pinned state on fragments; older servers omit it. */
type PinnableFragment = MemoryFragment & { pinned?: boolean };

export function MemoryPanel() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const [fragments, setFragments] = useState<PinnableFragment[]>([]);
  const [consolidated, setConsolidated] = useState<ConsolidatedKnowledge[]>([]);
  const [overview, setOverview] = useState<MemoryOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"fragments" | "consolidated">("fragments");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTag, setFilterTag] = useState("");

  useEffect(() => {
    if (!currentSessionId) return;
    loadMemory();
  }, [currentSessionId]);

  async function loadMemory() {
    if (!currentSessionId) return;
    setLoading(true);
    try {
      const data = await api.getSessionMemory(currentSessionId);
      setFragments(data.fragments || []);
      setConsolidated(data.consolidated || []);
    } catch (err) {
      console.error("[MemoryPanel] Failed to load memory:", err);
    } finally {
      setLoading(false);
    }
    // Overview loads independently so a missing/failing endpoint never
    // breaks the fragments/consolidated lists.
    try {
      const ov = await api.getMemoryOverview(currentSessionId);
      setOverview(ov);
    } catch (err) {
      console.error("[MemoryPanel] Failed to load memory overview:", err);
      setOverview(null);
    }
  }

  /** Optimistic pin/unpin: flip locally, revert if the API call fails. */
  async function handleTogglePin(frag: PinnableFragment) {
    const next = !frag.pinned;
    setFragments((prev) => prev.map((f) => (f.id === frag.id ? { ...f, pinned: next } : f)));
    try {
      await api.pinMemory(frag.id, next);
    } catch (err) {
      console.error("[MemoryPanel] Failed to toggle pin:", err);
      setFragments((prev) => prev.map((f) => (f.id === frag.id ? { ...f, pinned: !next } : f)));
    }
  }

  async function handleSearch() {
    if (!currentSessionId || !searchQuery.trim()) return;
    setLoading(true);
    try {
      const data = await api.queryMemory(currentSessionId, searchQuery, 20);
      setFragments(data.results || []);
      setConsolidated(data.consolidated || []);
    } catch (err) {
      console.error("[MemoryPanel] Failed to query memory:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleConsolidate() {
    if (!currentSessionId) return;
    setLoading(true);
    try {
      await api.consolidateMemory(currentSessionId);
      await loadMemory();
    } catch (err) {
      console.error("[MemoryPanel] Failed to consolidate memory:", err);
    } finally {
      setLoading(false);
    }
  }

  const allTags = Array.from(
    new Set(fragments.flatMap((f) => f.tags))
  ).sort();

  const filteredFragments = filterTag
    ? fragments.filter((f) => f.tags.includes(filterTag))
    : fragments;

  if (!currentSessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-cc-muted">
        <svg className="w-16 h-16 mb-4 opacity-20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <p className="text-sm">No session selected</p>
        <p className="text-xs text-cc-muted mt-1">Select a session to view its semantic memory</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-cc-bg">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-cc-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-cc-fg">Semantic Memory</h2>
          <button
            onClick={handleConsolidate}
            disabled={loading}
            className="px-2 py-1 text-xs font-medium text-cc-primary hover:bg-cc-active rounded cursor-pointer disabled:opacity-50"
          >
            {loading ? "Consolidating..." : "Consolidate"}
          </button>
        </div>

        {/* Search */}
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search memory..."
            className="flex-1 px-3 py-1.5 text-sm bg-cc-card border border-cc-border rounded-lg text-cc-fg placeholder-cc-muted focus:outline-none focus:border-cc-primary"
          />
          <button
            onClick={handleSearch}
            className="px-3 py-1.5 text-sm font-medium text-white bg-cc-primary hover:bg-cc-primary/90 rounded-lg cursor-pointer"
          >
            Search
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mt-3 bg-cc-hover rounded-lg p-0.5">
          <button
            onClick={() => setTab("fragments")}
            className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === "fragments"
                ? "bg-cc-card text-cc-fg shadow-sm"
                : "text-cc-muted hover:text-cc-fg"
            }`}
          >
            Fragments ({filteredFragments.length})
          </button>
          <button
            onClick={() => setTab("consolidated")}
            className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              tab === "consolidated"
                ? "bg-cc-card text-cc-fg shadow-sm"
                : "text-cc-muted hover:text-cc-fg"
            }`}
          >
            Consolidated ({consolidated.length})
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Per-namespace overview: counts, decayed-weight bars, pinned counts */}
        {overview && overview.namespaces.length > 0 && (
          <div className="px-4 pt-4">
            <h3 className="text-[10px] uppercase tracking-[0.15em] text-cc-muted/60 font-mono mb-2">
              Namespaces
            </h3>
            <div className="space-y-2">
              {overview.namespaces.map((ns) => {
                const pct = Math.round(Math.max(0, Math.min(1, ns.avgWeight)) * 100);
                return (
                  <div key={ns.namespace} className="p-2.5 bg-cc-card border border-cc-border rounded-lg">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-[11px] font-mono text-cc-fg truncate" title={ns.namespace}>
                        {ns.namespace}
                      </span>
                      <span className="text-[10px] text-cc-muted font-mono shrink-0">
                        {ns.count} {ns.count === 1 ? "item" : "items"}
                        {ns.pinnedCount > 0 && ` · ${ns.pinnedCount} pinned`}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-cc-hover overflow-hidden">
                        <div
                          data-testid={`ns-weight-${ns.namespace}`}
                          className="h-full rounded-full bg-cc-primary/50"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-cc-muted/60 font-mono tabular-nums shrink-0">
                        {pct}% avg weight
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "fragments" && (
          <div className="p-4 space-y-3">
            {/* Tag filter */}
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2 border-b border-cc-border">
                <button
                  onClick={() => setFilterTag("")}
                  className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
                    !filterTag
                      ? "bg-cc-primary text-white"
                      : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  All
                </button>
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setFilterTag(tag)}
                    className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
                      filterTag === tag
                        ? "bg-cc-primary text-white"
                        : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            {filteredFragments.length === 0 ? (
              <div className="text-center py-8 text-cc-muted text-sm">
                {loading ? "Loading..." : "No memory fragments yet"}
              </div>
            ) : (
              filteredFragments.map((frag) => (
                <div key={frag.id} className="p-3 bg-cc-card border border-cc-border rounded-lg">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${
                        frag.type === "observation" ? "bg-blue-500/20 text-blue-400" :
                        frag.type === "hypothesis" ? "bg-purple-500/20 text-purple-400" :
                        frag.type === "decision" ? "bg-green-500/20 text-green-400" :
                        "bg-yellow-500/20 text-yellow-400"
                      }`}>
                        {frag.type}
                      </span>
                      <span className="text-xs text-cc-muted">
                        {new Date(frag.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-cc-muted font-mono">
                        {(frag.confidence * 100).toFixed(0)}%
                      </span>
                      <button
                        onClick={() => handleTogglePin(frag)}
                        aria-label={frag.pinned ? "Unpin memory" : "Pin memory"}
                        title={frag.pinned ? "Unpin — resume decay" : "Pin — never decays"}
                        className={`w-5 h-5 flex items-center justify-center rounded cursor-pointer transition-colors ${
                          frag.pinned
                            ? "text-cc-primary bg-cc-primary/10 hover:bg-cc-primary/20"
                            : "text-cc-muted/40 hover:text-cc-fg hover:bg-cc-hover"
                        }`}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M9.5 1.5l5 5-1.5 1.5-.75-.25L9.5 10.5l.25 2.75L8.5 14.5 5.75 11.75 2.5 15l-1-1 3.25-3.25L2 8l1.25-1.25L6 7l2.75-2.75-.25-.75L9.5 1.5z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-cc-fg mb-2">{frag.content}</p>
                  {frag.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {frag.tags.map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 text-[10px] bg-cc-hover text-cc-muted rounded">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {frag.gitContext.files.length > 0 && (
                    <div className="mt-2 text-xs text-cc-muted font-mono">
                      {frag.gitContext.files.slice(0, 2).join(", ")}
                      {frag.gitContext.files.length > 2 && ` +${frag.gitContext.files.length - 2} more`}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === "consolidated" && (
          <div className="p-4 space-y-3">
            {consolidated.length === 0 ? (
              <div className="text-center py-8 text-cc-muted text-sm">
                {loading ? "Loading..." : "No consolidated knowledge yet"}
              </div>
            ) : (
              consolidated.map((know) => {
                const synthesisMethod = overview?.knowledge.find((k) => k.id === know.id)?.synthesisMethod;
                return (
                <div key={know.id} className="p-3 bg-cc-card border border-cc-border rounded-lg">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="px-2 py-1 text-xs font-semibold bg-cc-primary/20 text-cc-primary rounded">
                        #{know.tag}
                      </span>
                      {synthesisMethod === "concat" && (
                        <span
                          className="px-1.5 py-0.5 text-[10px] bg-cc-hover text-cc-muted rounded font-mono"
                          title="Concatenated without LLM distillation (no OpenRouter key configured)"
                        >
                          concat
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-cc-muted">
                      Updated {new Date(know.lastUpdated).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-cc-fg mb-2">{know.summary}</p>
                  <div className="text-xs text-cc-muted">
                    Synthesized from {know.sourceFragments.length} fragments
                    {" · "}
                    Confidence: {(know.confidence * 100).toFixed(0)}%
                  </div>
                </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
