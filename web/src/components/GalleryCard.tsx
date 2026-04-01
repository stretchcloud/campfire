import { useState } from "react";
import type { GalleryEntryInfo } from "../api.js";

interface Props {
  entry: GalleryEntryInfo;
  onVote: (id: string, direction: 1 | -1) => void;
  onDelete?: (id: string) => void;
  onFeature?: (id: string) => void;
  onExportClawHub?: (id: string) => void;
  clawHubAvailable?: boolean;
  onPostMoltbook?: (id: string) => void;
  moltbookAvailable?: boolean;
  onCreatePublicLink?: (id: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const BACKEND_COLORS: Record<string, string> = {
  claude: "text-[#5BA8A0] bg-[#5BA8A0]/10 border-[#5BA8A0]/20",
  codex: "text-blue-500 bg-blue-500/10 border-blue-500/20",
  goose: "text-amber-600 bg-amber-500/10 border-amber-500/20",
  aider: "text-purple-500 bg-purple-500/10 border-purple-500/20",
  openhands: "text-rose-500 bg-rose-500/10 border-rose-500/20",
  openclaw: "text-orange-500 bg-orange-500/10 border-orange-500/20",
};

export function GalleryCard({ entry, onVote, onDelete, onFeature, onExportClawHub, clawHubAvailable, onPostMoltbook, moltbookAvailable, onCreatePublicLink }: Props) {
  const [voting, setVoting] = useState<1 | -1 | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleVote(dir: 1 | -1) {
    if (voting) return;
    setVoting(dir);
    try {
      onVote(entry.id, dir);
    } finally {
      setVoting(null);
    }
  }

  const backendColor = BACKEND_COLORS[entry.backendType] || "text-cc-fg/60 bg-cc-hover border-cc-border/40";

  return (
    <div className="rounded-xl border border-cc-border/60 bg-cc-card hover:border-cc-border transition-all duration-200 overflow-hidden group">
      {/* Main content area */}
      <div className="px-5 py-4">
        <div className="flex items-start gap-4">
          {/* Vote column */}
          <div className="flex flex-col items-center gap-0.5 pt-0.5 shrink-0">
            <button
              onClick={() => handleVote(1)}
              disabled={voting !== null}
              className="w-7 h-6 flex items-center justify-center rounded-md text-cc-fg/35 hover:text-cc-primary hover:bg-cc-primary/5 transition-colors cursor-pointer disabled:opacity-50"
              title="Upvote"
              aria-label="Upvote"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M8 4l4 5H4l4-5z" />
              </svg>
            </button>
            <span className={`text-[13px] font-bold tabular-nums leading-none ${
              entry.votes > 0 ? "text-cc-primary" : entry.votes < 0 ? "text-cc-error" : "text-cc-fg/40"
            }`}>
              {entry.votes}
            </span>
            <button
              onClick={() => handleVote(-1)}
              disabled={voting !== null}
              className="w-7 h-6 flex items-center justify-center rounded-md text-cc-fg/35 hover:text-cc-error hover:bg-cc-error/5 transition-colors cursor-pointer disabled:opacity-50"
              title="Downvote"
              aria-label="Downvote"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M8 12l4-5H4l4 5z" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {entry.featured && (
                <span className="text-amber-500 shrink-0" title="Featured">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                    <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
                  </svg>
                </span>
              )}
              <h3 className="text-[14px] font-semibold text-cc-fg truncate">{entry.name}</h3>
              <span className="text-[11px] text-cc-fg/40 shrink-0 ml-auto">{timeAgo(entry.createdAt)}</span>
            </div>

            {entry.description && (
              <p className="mt-1 text-[12px] text-cc-fg/55 line-clamp-2 leading-relaxed">{entry.description}</p>
            )}

            {/* Metadata badges row */}
            <div className="flex flex-wrap items-center gap-1.5 mt-3">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${backendColor}`}>
                {entry.backendType}
              </span>
              {entry.model && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-hover/70 text-cc-fg/55 border border-cc-border/30 truncate max-w-[140px]">
                  {entry.model}
                </span>
              )}
              {entry.totalCostUsd > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-hover/70 text-cc-fg/55 border border-cc-border/30">
                  {formatCost(entry.totalCostUsd)}
                </span>
              )}
              {entry.numTurns > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-hover/70 text-cc-fg/55 border border-cc-border/30">
                  {entry.numTurns} turns
                </span>
              )}
              {entry.durationMs > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-hover/70 text-cc-fg/55 border border-cc-border/30">
                  {formatDuration(entry.durationMs)}
                </span>
              )}
              {(entry.totalLinesAdded > 0 || entry.totalLinesRemoved > 0) && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-hover/70 border border-cc-border/30">
                  <span className="text-green-500">+{entry.totalLinesAdded}</span>
                  <span className="text-cc-fg/30 mx-0.5">/</span>
                  <span className="text-red-500">-{entry.totalLinesRemoved}</span>
                </span>
              )}
            </div>

            {/* Tags */}
            {entry.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {entry.tags.map((tag) => (
                  <span key={tag} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cc-primary/5 text-cc-primary/70 border border-cc-primary/10">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action bar — visible on hover */}
      <div className="flex items-center justify-between px-5 py-2.5 border-t border-cc-border/30 bg-cc-bg/50">
        {/* Left: Replay link */}
        <a
          href={`#/replay/session/${entry.sessionId}`}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-cc-primary hover:text-cc-primary-hover transition-colors"
          title="Watch replay"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M4.5 3.5A.5.5 0 015.22 3l7 4.5a.5.5 0 010 .86l-7 4.5A.5.5 0 014.5 12.5v-9z" />
          </svg>
          Watch Replay
        </a>

        {/* Right: Actions */}
        <div className="flex items-center gap-0.5">
          {onFeature && (
            <button
              onClick={() => onFeature(entry.id)}
              className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer ${
                entry.featured
                  ? "text-amber-500 bg-amber-500/10"
                  : "text-cc-fg/30 hover:text-amber-500 hover:bg-amber-500/5"
              }`}
              title={entry.featured ? "Unfeature" : "Feature"}
              aria-label={entry.featured ? "Unfeature" : "Feature"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
              </svg>
            </button>
          )}
          {onExportClawHub && clawHubAvailable && (
            <button
              onClick={() => onExportClawHub(entry.id)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-fg/30 hover:text-orange-500 hover:bg-orange-500/5 transition-colors cursor-pointer"
              title="Export to ClawHub"
              aria-label="Export to ClawHub"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path d="M7 1h8v8M15 1L8 8M6 3H2v11h11v-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {onPostMoltbook && moltbookAvailable && (
            <button
              onClick={() => onPostMoltbook(entry.id)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-fg/30 hover:text-violet-500 hover:bg-violet-500/5 transition-colors cursor-pointer"
              title="Post to Moltbook"
              aria-label="Post to Moltbook"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 2a1.5 1.5 0 00-1.5 1.5v3.793l-1.146-1.147a1.5 1.5 0 00-2.122 2.122l3.5 3.5a1.5 1.5 0 002.122 0l3.5-3.5a1.5 1.5 0 00-2.122-2.122L9.5 7.293V3.5A1.5 1.5 0 008 2z" />
              </svg>
            </button>
          )}
          {onCreatePublicLink && (
            <button
              onClick={() => onCreatePublicLink(entry.id)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-fg/30 hover:text-cc-primary hover:bg-cc-primary/5 transition-colors cursor-pointer"
              title="Copy public link"
              aria-label="Copy public replay link"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M4.715 6.542L3.343 7.914a3 3 0 104.243 4.243l1.828-1.829A3 3 0 008.586 5.5L8 6.086a1.002 1.002 0 00-.154.199 2 2 0 01.861 3.337L6.88 11.45a2 2 0 11-2.83-2.83l.793-.792a4.018 4.018 0 01-.128-1.287z" />
                <path d="M11.285 9.458l1.372-1.372a3 3 0 10-4.243-4.243L6.586 5.672A3 3 0 007.414 10.5l.586-.586a1.002 1.002 0 00.154-.199 2 2 0 01-.861-3.337L9.12 4.55a2 2 0 112.83 2.83l-.793.792c.112.42.155.855.128 1.287z" />
              </svg>
            </button>
          )}

          {/* Delete with confirmation */}
          {onDelete && !confirmDelete && (
            <button
              onClick={() => setConfirmDelete(true)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-fg/30 hover:text-cc-error hover:bg-cc-error/5 transition-colors cursor-pointer"
              title="Delete"
              aria-label="Delete"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                <path d="M3 4h10M5.5 4V2.5h5V4M6 6.5v5M10 6.5v5M4.5 4l.5 9.5h6l.5-9.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {onDelete && confirmDelete && (
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 rounded-md text-[10px] font-medium text-cc-fg/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(entry.id); setConfirmDelete(false); }}
                className="px-2 py-1 rounded-md text-[10px] font-medium bg-cc-error text-white hover:bg-cc-error/90 transition-colors cursor-pointer"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
