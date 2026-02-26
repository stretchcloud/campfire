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
  claude: "text-[#5BA8A0] bg-[#5BA8A0]/10",
  codex: "text-blue-500 bg-blue-500/10",
  goose: "text-amber-500 bg-amber-500/10",
  aider: "text-purple-500 bg-purple-500/10",
  openhands: "text-rose-500 bg-rose-500/10",
  openclaw: "text-orange-500 bg-orange-500/10",
};

export function GalleryCard({ entry, onVote, onDelete, onFeature, onExportClawHub, clawHubAvailable, onPostMoltbook, moltbookAvailable, onCreatePublicLink }: Props) {
  const [voting, setVoting] = useState<1 | -1 | null>(null);

  async function handleVote(dir: 1 | -1) {
    if (voting) return;
    setVoting(dir);
    try {
      onVote(entry.id, dir);
    } finally {
      setVoting(null);
    }
  }

  const backendColor = BACKEND_COLORS[entry.backendType] || "text-cc-muted bg-cc-hover";

  return (
    <div className="border border-cc-border rounded-lg overflow-hidden bg-cc-card hover:border-cc-border-hover transition-colors">
      {/* Header */}
      <div className="flex items-start gap-2 px-3 py-2.5">
        {/* Vote buttons */}
        <div className="flex flex-col items-center gap-0.5 pt-0.5">
          <button
            onClick={() => handleVote(1)}
            disabled={voting !== null}
            className="w-6 h-5 flex items-center justify-center text-cc-muted hover:text-cc-primary transition-colors cursor-pointer disabled:opacity-50"
            title="Upvote"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M8 4l4 5H4l4-5z" />
            </svg>
          </button>
          <span className={`text-xs font-semibold ${entry.votes > 0 ? "text-cc-primary" : entry.votes < 0 ? "text-cc-error" : "text-cc-muted"}`}>
            {entry.votes}
          </span>
          <button
            onClick={() => handleVote(-1)}
            disabled={voting !== null}
            className="w-6 h-5 flex items-center justify-center text-cc-muted hover:text-cc-error transition-colors cursor-pointer disabled:opacity-50"
            title="Downvote"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M8 12l4-5H4l4 5z" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {entry.featured && (
              <span className="text-amber-500" title="Featured">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
                </svg>
              </span>
            )}
            <span className="text-sm font-medium text-cc-fg truncate">{entry.name}</span>
          </div>

          {entry.description && (
            <p className="mt-0.5 text-xs text-cc-muted line-clamp-2">{entry.description}</p>
          )}

          {/* Tags */}
          {entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {entry.tags.map((tag) => (
                <span key={tag} className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {onFeature && (
            <button
              onClick={() => onFeature(entry.id)}
              className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                entry.featured
                  ? "text-amber-500 bg-amber-500/10"
                  : "text-cc-muted hover:text-amber-500 hover:bg-cc-hover"
              }`}
              title={entry.featured ? "Unfeature" : "Feature"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 1.5l2.09 4.26 4.66.68-3.38 3.28.8 4.64L8 12.17l-4.17 2.19.8-4.64-3.38-3.28 4.66-.68L8 1.5z" />
              </svg>
            </button>
          )}
          {onExportClawHub && clawHubAvailable && (
            <button
              onClick={() => onExportClawHub(entry.id)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-orange-500 hover:bg-cc-hover transition-colors cursor-pointer"
              title="Export to ClawHub"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8.636 3.5a.5.5 0 00-.5-.5H1.5A1.5 1.5 0 000 4.5v10A1.5 1.5 0 001.5 16h10a1.5 1.5 0 001.5-1.5V7.864a.5.5 0 00-1 0V14.5a.5.5 0 01-.5.5h-10a.5.5 0 01-.5-.5v-10a.5.5 0 01.5-.5h6.636a.5.5 0 00.5-.5z" />
                <path d="M16 .5a.5.5 0 00-.5-.5h-5a.5.5 0 000 1h3.793L6.146 9.146a.5.5 0 10.708.708L15 1.707V5.5a.5.5 0 001 0v-5z" />
              </svg>
            </button>
          )}
          {onPostMoltbook && moltbookAvailable && (
            <button
              onClick={() => onPostMoltbook(entry.id)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-red-400 hover:bg-cc-hover transition-colors cursor-pointer"
              title="Post to Moltbook"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8 0C3.58 0 0 3.58 0 8s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm0 2.5c1.5 0 2.5 1.12 2.5 2.5 0 .83-.5 1.56-1 2-.5.44-.5.56-.5 1h-2c0-.94.37-1.35 1-2 .45-.45.5-.72.5-1 0-.56-.44-1-1-1s-1 .44-1 1H4.5C4.5 3.62 5.5 2.5 8 2.5zM7 11h2v2H7v-2z" />
              </svg>
            </button>
          )}
          {onCreatePublicLink && (
            <button
              onClick={() => onCreatePublicLink(entry.id)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-primary hover:bg-cc-hover transition-colors cursor-pointer"
              title="Create public replay link"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M4.715 6.542L3.343 7.914a3 3 0 104.243 4.243l1.828-1.829A3 3 0 008.586 5.5L8 6.086a1.002 1.002 0 00-.154.199 2 2 0 01.861 3.337L6.88 11.45a2 2 0 11-2.83-2.83l.793-.792a4.018 4.018 0 01-.128-1.287z" />
                <path d="M11.285 9.458l1.372-1.372a3 3 0 10-4.243-4.243L6.586 5.672A3 3 0 007.414 10.5l.586-.586a1.002 1.002 0 00.154-.199 2 2 0 01-.861-3.337L9.12 4.55a2 2 0 112.83 2.83l-.793.792c.112.42.155.855.128 1.287z" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(entry.id)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-error hover:bg-cc-hover transition-colors cursor-pointer"
              title="Delete"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z" />
                <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-cc-bg border-t border-cc-border text-[10px] text-cc-muted">
        <span className={`font-medium px-1.5 rounded-full leading-[16px] ${backendColor}`}>
          {entry.backendType}
        </span>
        {entry.model && <span className="truncate max-w-[120px]">{entry.model}</span>}
        {entry.totalCostUsd > 0 && <span>{formatCost(entry.totalCostUsd)}</span>}
        {entry.numTurns > 0 && <span>{entry.numTurns} turns</span>}
        {entry.durationMs > 0 && <span>{formatDuration(entry.durationMs)}</span>}
        {(entry.totalLinesAdded > 0 || entry.totalLinesRemoved > 0) && (
          <span>
            <span className="text-green-500">+{entry.totalLinesAdded}</span>
            {" / "}
            <span className="text-red-500">-{entry.totalLinesRemoved}</span>
          </span>
        )}
        <span className="ml-auto">{timeAgo(entry.createdAt)}</span>
        {/* View Replay link */}
        <a
          href={`#/replay/session/${entry.sessionId}`}
          className="text-cc-primary hover:text-cc-primary-hover transition-colors"
          title="View replay"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M4.5 3.5A.5.5 0 015.22 3l7 4.5a.5.5 0 010 .86l-7 4.5A.5.5 0 014.5 12.5v-9z" />
          </svg>
        </a>
      </div>
    </div>
  );
}
