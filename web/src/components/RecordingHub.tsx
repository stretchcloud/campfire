import { useState, useEffect, useCallback, useMemo } from "react";
import { api, type HubRecordingMeta, type ValidationResult, type DiagnosticsReport } from "../api.js";

/**
 * RecordingHub — a dashboard for browsing, validating, and diagnosing recordings.
 *
 * Features: auto-index existing recordings, validation badges, diagnostics
 * reports, tag management, import/upload, timeline view.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function playableFilterLabel(pf: "all" | "playable" | "metadata"): string {
  if (pf === "playable") return "Playable";
  if (pf === "metadata") return "Metadata only";
  return "All types";
}

function validationLabel(v: ValidationResult): string {
  if (v.compatible) return "Protocol Compatible";
  const n = v.diffs.length;
  return `${n} Issue${n > 1 ? "s" : ""}`;
}

const PLAYABLE_TYPES = new Set([
  "assistant", "result", "user_message", "stream_event",
  "permission_request", "permission_cancelled", "status_change",
  "session_init", "session_update", "cli_connected", "error",
  "tool_progress", "session_name_update",
]);

function hasPlayableContent(summary: Record<string, number>): boolean {
  return Object.keys(summary).some((t) => PLAYABLE_TYPES.has(t));
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

// ─── Component ──────────────────────────────────────────────────────────────

export function RecordingHub({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const [recordings, setRecordings] = useState<HubRecordingMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [indexing, setIndexing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [backendFilter, setBackendFilter] = useState<string>("all");
  const [playableFilter, setPlayableFilter] = useState<"all" | "playable" | "metadata">("all");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "longest" | "most-messages">("newest");

  const refresh = useCallback(() => {
    api.listHubRecordings().then(setRecordings).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleIndexAll() {
    setIndexing(true);
    try {
      const result = await api.indexAllRecordings();
      if (result.imported > 0) refresh();
    } catch { /* ignore */ }
    setIndexing(false);
  }

  async function handleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setValidation(null);
    setDiagnostics(null);
    setDetailLoading(true);
    try {
      const [v, d] = await Promise.all([
        api.validateRecording(id),
        api.getRecordingDiagnostics(id),
      ]);
      setValidation(v);
      setDiagnostics(d);
    } catch { /* ignore */ }
    setDetailLoading(false);
  }

  async function handleDelete(id: string) {
    await api.deleteHubRecording(id).catch(() => {});
    refresh();
  }

  const handleReplay = useCallback((filename: string) => {
    globalThis.location.hash = `#/replay/${encodeURIComponent(filename)}`;
  }, []);

  // Derive available backends from data
  const availableBackends = useMemo(() => {
    const set = new Set(recordings.map((r) => r.backendType));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [recordings]);

  // Counts for filter badges
  const backendCounts = useMemo(() => {
    const counts: Record<string, number> = { all: recordings.length };
    for (const r of recordings) {
      counts[r.backendType] = (counts[r.backendType] || 0) + 1;
    }
    return counts;
  }, [recordings]);

  // Apply all filters + sort
  const filtered = useMemo(() => {
    let result = recordings;

    // Text search
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter((r) =>
        r.filename.toLowerCase().includes(q) ||
        r.backendType.includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    // Backend filter
    if (backendFilter !== "all") {
      result = result.filter((r) => r.backendType === backendFilter);
    }

    // Playable filter
    if (playableFilter === "playable") {
      result = result.filter((r) => hasPlayableContent(r.messageTypeSummary));
    } else if (playableFilter === "metadata") {
      result = result.filter((r) => !hasPlayableContent(r.messageTypeSummary));
    }

    // Sort
    return [...result].sort((a, b) => {
      if (sortBy === "oldest") return a.startedAt - b.startedAt;
      if (sortBy === "longest") return b.duration - a.duration;
      if (sortBy === "most-messages") return b.entryCount - a.entryCount;
      return b.startedAt - a.startedAt; // newest (default)
    });
  }, [recordings, filter, backendFilter, playableFilter, sortBy]);

  return (
    <div className={embedded ? "px-4 py-6 max-w-5xl mx-auto" : "p-6 max-w-5xl mx-auto"}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-cc-fg">Recording Hub</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">Browse, validate, and diagnose session recordings</p>
        </div>
        <button
          onClick={handleIndexAll}
          disabled={indexing}
          className="px-3 py-1.5 rounded-lg bg-cc-primary text-white text-[12px] font-medium hover:bg-cc-primary-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {indexing ? "Indexing..." : "Index Recordings"}
        </button>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by filename, backend, or tag..."
          className="w-full h-9 px-3 rounded-lg border border-cc-border bg-cc-input-bg text-[13px] text-cc-fg placeholder:text-cc-muted/30 focus:outline-none focus:ring-2 focus:ring-cc-primary/20"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Backend pills */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setBackendFilter("all")}
            className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${
              backendFilter === "all" ? "bg-cc-primary/10 text-cc-primary" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            All <span className="ml-0.5 opacity-60 tabular-nums">{backendCounts.all}</span>
          </button>
          {availableBackends.map((bt) => {
            const color = BACKEND_COLORS[bt] || "text-cc-muted bg-cc-hover";
            return (
              <button
                key={bt}
                onClick={() => setBackendFilter(backendFilter === bt ? "all" : bt)}
                className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${
                  backendFilter === bt ? color : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                {bt} <span className="ml-0.5 opacity-60 tabular-nums">{backendCounts[bt] || 0}</span>
              </button>
            );
          })}
        </div>

        {/* Separator */}
        <div className="w-px h-4 bg-cc-border/50" />

        {/* Playable filter */}
        <div className="flex items-center gap-1">
          {(["all", "playable", "metadata"] as const).map((pf) => (
            <button
              key={pf}
              onClick={() => setPlayableFilter(pf)}
              className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors cursor-pointer ${
                playableFilter === pf ? "bg-cc-primary/10 text-cc-primary" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {playableFilterLabel(pf)}
            </button>
          ))}
        </div>

        {/* Separator */}
        <div className="w-px h-4 bg-cc-border/50" />

        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="h-7 px-2 rounded-md border border-cc-border bg-cc-input-bg text-[10px] text-cc-fg cursor-pointer"
          aria-label="Sort recordings"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="longest">Longest duration</option>
          <option value="most-messages">Most messages</option>
        </select>

        {/* Result count */}
        <span className="text-[10px] text-cc-muted/50 ml-auto tabular-nums">{filtered.length} recording{filtered.length === 1 ? "" : "s"}</span>
      </div>

      {/* Recording list */}
      {loading && <p className="text-cc-muted text-sm">Loading...</p>}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-cc-muted">
          <p className="text-sm">No recordings indexed yet</p>
          <p className="text-xs mt-1">Click "Index Recordings" to import existing session recordings</p>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((rec) => (
          <div key={rec.id}>
            <RecordingCard
              recording={rec}
              playable={hasPlayableContent(rec.messageTypeSummary)}
              isExpanded={expandedId === rec.id}
              onExpand={() => handleExpand(rec.id)}
              onDelete={() => handleDelete(rec.id)}
              onReplay={() => handleReplay(rec.filename)}
            />
            {expandedId === rec.id && (
              <RecordingDetail
                recording={rec}
                validation={validation}
                diagnostics={diagnostics}
                loading={detailLoading}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Recording Card ─────────────────────────────────────────────────────────

function RecordingCard({ recording: r, playable, isExpanded, onExpand, onDelete, onReplay }: Readonly<{
  recording: HubRecordingMeta;
  playable: boolean;
  isExpanded: boolean;
  onExpand: () => void;
  onDelete: () => void;
  onReplay: () => void;
}>) {
  const color = BACKEND_COLORS[r.backendType] || "text-cc-muted bg-cc-hover";

  return (
    <div className={`border rounded-lg transition-all ${isExpanded ? "border-cc-primary/30 bg-cc-primary/[0.02]" : "border-cc-border bg-cc-card hover:shadow-panel"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Backend badge */}
        <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full ${color}`}>
          {r.backendType}
        </span>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <span className="text-[12px] font-medium text-cc-fg truncate block font-mono-code">
            {r.filename}
          </span>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-cc-muted">
            <span>{formatTime(r.startedAt)}</span>
            <span className="tabular-nums">{formatDuration(r.duration)}</span>
            <span className="tabular-nums">{r.entryCount} msgs</span>
            {!playable && <span className="text-cc-muted/40">metadata only</span>}
          </div>
        </div>

        {/* Tags */}
        {r.tags.length > 0 && (
          <div className="flex gap-1 shrink-0">
            {r.tags.slice(0, 3).map((t) => (
              <span key={t} className="text-[8px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted">{t}</span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onReplay} disabled={!playable} title={playable ? "Replay" : "No playable messages"} className={`p-1.5 rounded-md transition-colors ${playable ? "hover:bg-cc-hover text-cc-primary cursor-pointer" : "text-cc-muted/30 cursor-not-allowed"}`}>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden><path d="M4 2l10 6-10 6V2z" /></svg>
          </button>
          <button onClick={onExpand} title="Details" className={`p-1.5 rounded-md hover:bg-cc-hover cursor-pointer transition-colors ${isExpanded ? "text-cc-primary" : "text-cc-muted"}`}>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden><path d="M8 2a6 6 0 100 12A6 6 0 008 2zm.75 3.5a.75.75 0 00-1.5 0v2.25H5a.75.75 0 000 1.5h2.25V11.5a.75.75 0 001.5 0V9.25H11a.75.75 0 000-1.5H8.75V5.5z" /></svg>
          </button>
          <button onClick={onDelete} title="Remove from hub" className="p-1.5 rounded-md hover:bg-cc-hover text-cc-muted hover:text-cc-error cursor-pointer transition-colors">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5" aria-hidden><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.928l.856 10.268A1.75 1.75 0 006.282 16h3.436a1.75 1.75 0 001.748-1.632l.856-10.268h.928a.75.75 0 000-1.5H11z" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Recording Detail (validation + diagnostics) ────────────────────────────

function RecordingDetail({ recording, validation, diagnostics, loading }: Readonly<{
  recording: HubRecordingMeta;
  validation: ValidationResult | null;
  diagnostics: DiagnosticsReport | null;
  loading: boolean;
}>) {
  if (loading) {
    return (
      <div className="ml-4 my-2 flex items-center gap-2 text-cc-muted text-[11px]">
        <div className="w-3.5 h-3.5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
        Analyzing recording...
      </div>
    );
  }

  return (
    <div className="mx-4 mb-3 mt-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {/* Validation card */}
      {validation && (
        <div className={`rounded-lg border p-3 ${validation.compatible ? "border-cc-success/30 bg-cc-success/[0.03]" : "border-cc-error/30 bg-cc-error/[0.03]"}`}>
          <div className="flex items-center gap-2 mb-2">
            {validation.compatible ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success" aria-hidden><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error" aria-hidden><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" /></svg>
            )}
            <span className="text-[12px] font-semibold text-cc-fg">
              {validationLabel(validation)}
            </span>
          </div>
          <div className="text-[10px] text-cc-muted space-y-0.5">
            <p>Checked {validation.checkedMessages} of {validation.totalMessages} messages</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {Object.entries(validation.messageTypeBreakdown).slice(0, 8).map(([type, info]) => (
                <span key={type} className={`px-1.5 py-0.5 rounded text-[8px] font-mono-code ${info.issues > 0 ? "bg-cc-error/10 text-cc-error" : "bg-cc-hover text-cc-muted"}`}>
                  {type}: {info.count}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Diagnostics card */}
      {diagnostics && (
        <div className="rounded-lg border border-cc-border p-3">
          <h4 className="text-[12px] font-semibold text-cc-fg mb-2">Health Report</h4>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <span className="text-cc-muted">Duration</span>
            <span className="text-cc-fg font-mono-code tabular-nums">{formatDuration(diagnostics.totalDuration)}</span>
            <span className="text-cc-muted">Messages</span>
            <span className="text-cc-fg font-mono-code tabular-nums">{diagnostics.totalMessages}</span>
            <span className="text-cc-muted">Msg/min</span>
            <span className="text-cc-fg font-mono-code tabular-nums">{diagnostics.messageRate}</span>
            <span className="text-cc-muted">Disconnections</span>
            <span className={`font-mono-code tabular-nums ${diagnostics.disconnections.length > 0 ? "text-cc-error" : "text-cc-fg"}`}>{diagnostics.disconnections.length}</span>
            <span className="text-cc-muted">Data Gaps</span>
            <span className={`font-mono-code tabular-nums ${diagnostics.dataGaps.length > 0 ? "text-cc-warning" : "text-cc-fg"}`}>{diagnostics.dataGaps.length}</span>
            {diagnostics.avgPermissionResponseMs !== null && (
              <>
                <span className="text-cc-muted">Avg Perm Response</span>
                <span className="text-cc-fg font-mono-code tabular-nums">{formatDuration(diagnostics.avgPermissionResponseMs)}</span>
              </>
            )}
          </div>
          {/* Patterns */}
          <div className="mt-2 space-y-0.5">
            {diagnostics.patterns.map((p) => (
              <p key={p} className={`text-[9px] ${p.includes("No anomalies") ? "text-cc-success" : "text-cc-warning"}`}>{p}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
