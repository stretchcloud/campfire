import type { RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

interface SessionItemProps {
  session: SessionItemType;
  isActive: boolean;
  isArchived?: boolean;
  sessionName: string | undefined;
  permCount: number;
  isRecentlyRenamed: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onUnarchive: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClearRecentlyRenamed: (id: string) => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: RefObject<HTMLInputElement | null>;
}

/** Abbreviate model name for badge display */
function modelBadge(model: string | undefined, backendType: string): string {
  if (!model) return backendType === "codex" ? "Codex" : "Claude";
  // Common Claude models
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  // Codex models
  if (model.includes("codex")) return "Codex";
  // Fallback: capitalize backend
  if (backendType === "codex") return "Codex";
  if (backendType === "goose") return "Goose";
  if (backendType === "aider") return "Aider";
  if (backendType === "openhands") return "OpenHands";
  return "Claude";
}

export function SessionItem({
  session: s,
  isActive,
  isArchived: archived,
  sessionName,
  permCount,
  isRecentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
}: SessionItemProps) {
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isRunning = s.status === "running";
  const isCompacting = s.status === "compacting";
  const isEditing = editingSessionId === s.id;

  // Full-height left border color by status
  const borderColor = archived
    ? "bg-cc-muted/30"
    : permCount > 0
    ? "bg-cc-warning"
    : s.sdkState === "exited"
    ? "bg-cc-muted/30"
    : isRunning
    ? "bg-cc-success"
    : isCompacting
    ? "bg-cc-warning"
    : "bg-cc-success/60";

  // Pulse animation for running or permissions
  const showPulse = !archived && (
    permCount > 0 || (isRunning && s.isConnected)
  );

  // Model badge colors per backend
  const badgeColors = "text-cc-muted bg-cc-hover";

  const hasGitStats = s.gitAhead > 0 || s.gitBehind > 0 || s.linesAdded > 0 || s.linesRemoved > 0;

  return (
    <div className={`relative group ${archived ? "opacity-40" : ""}`}>
      <button
        onClick={() => onSelect(s.id)}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartRename(s.id, label);
        }}
        className={`w-full pl-3 pr-7 py-1.5 ${archived ? "pr-14" : ""} text-left rounded transition-all duration-100 cursor-pointer ${
          isActive
            ? "bg-cc-active"
            : "hover:bg-cc-hover"
        }`}
      >
        {/* Left status indicator */}
        <span
          className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${borderColor} transition-colors ${
            showPulse ? "animate-[pulse-dot_1.5s_ease-in-out_infinite]" : ""
          } ${isActive ? "opacity-100" : "opacity-50 group-hover:opacity-80"}`}
        />

        <div className="flex flex-col gap-0.5 min-w-0">
          {/* Row 1: Name + Model badge */}
          <div className="flex items-center gap-1.5">
            {isEditing ? (
              <input
                ref={editInputRef}
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onConfirmRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancelRename();
                  }
                  e.stopPropagation();
                }}
                onBlur={onConfirmRename}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className="text-[13px] font-medium flex-1 min-w-0 text-cc-fg bg-transparent border border-cc-border rounded px-1 py-0 outline-none focus:border-cc-primary/50"
              />
            ) : (
              <>
                <span
                  className={`text-[12px] font-medium truncate text-cc-fg leading-snug ${
                    isRecentlyRenamed ? "animate-name-appear" : ""
                  }`}
                  onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
                >
                  {label}
                </span>
                <span className="text-[9px] font-mono-code text-cc-muted/50 shrink-0">
                  {modelBadge(s.model, s.backendType).toLowerCase()}
                </span>
                {s.cronJobId && (
                  <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-violet-500 bg-violet-500/10">
                    Cron
                  </span>
                )}
              </>
            )}
          </div>

          {/* Row 2: Branch info */}
          {s.gitBranch && (
            <div className="flex items-center gap-1 text-[10.5px] text-cc-muted leading-tight truncate">
              {s.isWorktree ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                  <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
              )}
              <span className="truncate">{s.gitBranch}</span>
              {s.isWorktree && (
                <span className="text-[8px] bg-cc-hover text-cc-muted px-0.5 rounded shrink-0">wt</span>
              )}
            </div>
          )}

          {/* Row 3: Git stats — hover-revealed on desktop, always visible on mobile */}
          {hasGitStats && (
            <div className="flex items-center gap-1.5 text-[10px] text-cc-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
              {(s.gitAhead > 0 || s.gitBehind > 0) && (
                <span className="flex items-center gap-0.5">
                  {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                  {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                </span>
              )}
              {(s.linesAdded > 0 || s.linesRemoved > 0) && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{s.linesAdded}</span>
                  <span className="text-red-400">-{s.linesRemoved}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </button>

      {/* Permission badge */}
      {!archived && permCount > 0 && (
        <span className="absolute right-8 sm:right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-bold leading-none px-1 sm:group-hover:opacity-0 transition-opacity pointer-events-none">
          {permCount}
        </span>
      )}

      {/* Action buttons — always visible on mobile, hover-revealed on desktop */}
      {archived ? (
        <>
          <button
            onClick={(e) => onUnarchive(e, s.id)}
            className="absolute right-8 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
            title="Restore session"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M8 10V3M5 5l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 13h10" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={(e) => onDelete(e, s.id)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-red-400 transition-all cursor-pointer"
            title="Delete permanently"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </>
      ) : (
        <button
          onClick={(e) => onArchive(e, s.id)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 sm:p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
          title="Archive session"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 3h10v2H3zM4 5v7a1 1 0 001 1h6a1 1 0 001-1V5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.5 8h3" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
