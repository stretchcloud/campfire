import { useState, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import type { SessionRole, PresenceViewer } from "../types.js";

// Stable empty references to avoid infinite re-renders from Zustand selectors
// (Object.is([], []) is false, so returning new [] on every selector call triggers re-renders)
const EMPTY_VIEWERS: PresenceViewer[] = [];

export function TopBar() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const isSessionView = hash !== "#/settings" && hash !== "#/terminal" && hash !== "#/environments" && hash !== "#/gallery" && hash !== "#/webhooks" && hash !== "#/adapters";
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const changedFilesCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const cwd =
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd;
    const files = s.changedFiles.get(currentSessionId);
    if (!files) return 0;
    if (!cwd) return files.size;
    const prefix = `${cwd}/`;
    return [...files].filter((fp) => fp === cwd || fp.startsWith(prefix)).length;
  });

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd ||
      null
    );
  });

  const totalCost = useStore((s) => {
    if (!currentSessionId) return 0;
    return s.sessions.get(currentSessionId)?.total_cost_usd ?? 0;
  });

  const myRole = useStore((s) => {
    if (!currentSessionId) return null;
    return s.myRole.get(currentSessionId) ?? null;
  });
  const isSpectator = myRole === "spectator";

  const viewers = useStore((s) => {
    if (!currentSessionId) return EMPTY_VIEWERS;
    return s.sessionViewers.get(currentSessionId) ?? EMPTY_VIEWERS;
  });

  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const sessionName = currentSessionId
    ? (sessionNames?.get(currentSessionId) ||
      sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
      `Session ${currentSessionId.slice(0, 8)}`)
    : null;

  async function handleFork() {
    if (!currentSessionId || forking) return;
    setForking(true);
    try {
      const result = await api.forkSession(currentSessionId);
      if (result.sessionId) {
        useStore.getState().setCurrentSession(result.sessionId);
        const { connectSession } = await import("../ws.js");
        connectSession(result.sessionId);
        // Refresh sessions list
        const list = await api.listSessions();
        useStore.getState().setSdkSessions(list);
      }
    } catch (err) {
      console.error("[TopBar] Failed to fork session:", err);
    } finally {
      setForking(false);
    }
  }

  async function handleShare(role: SessionRole) {
    if (!currentSessionId || shareCopied) return;
    try {
      const { url } = await api.createInviteLink(currentSessionId, role);
      // Try clipboard API first, fall back to execCommand, then prompt
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Clipboard API fails on non-HTTPS — try legacy fallback
        try {
          const textarea = document.createElement("textarea");
          textarea.value = url;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          copied = document.execCommand("copy");
          document.body.removeChild(textarea);
        } catch { /* fallback also failed */ }
      }
      if (copied) {
        setShareCopied(true);
        setShareMenuOpen(false);
        setTimeout(() => setShareCopied(false), 2000);
      } else {
        // Last resort: show the URL in a prompt so user can manually copy
        setShareMenuOpen(false);
        window.prompt("Copy this invite link:", url);
      }
    } catch (err) {
      console.error("[TopBar] Failed to create invite link:", err);
    }
  }

  return (
    <header className="shrink-0 flex items-center justify-between px-3 h-10 bg-cc-bg border-b border-cc-border">
      <div className="flex items-center gap-2">
        {/* Sidebar toggle — hidden for spectators */}
        {!isSpectator && (
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex items-center justify-center w-6 h-6 rounded text-cc-muted/60 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        )}

        {/* Spectator badge */}
        {isSpectator && (
          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono-code uppercase tracking-wider bg-cc-muted/10 text-cc-muted">
            spectator
          </span>
        )}

        {/* Session breadcrumb */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5 text-[11px] font-mono-code">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isConnected ? "bg-cc-success" : "bg-cc-muted/30"
              }`}
            />
            {sessionName && (
              <span className="font-medium text-cc-fg max-w-[10rem] sm:max-w-none truncate" title={sessionName}>
                {sessionName}
              </span>
            )}
            {totalCost > 0 && (
              <>
                <span className="text-cc-muted/25">|</span>
                <span className="text-cc-muted/60 tabular-nums" title={`Session cost: $${totalCost.toFixed(4)}`}>
                  ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
                </span>
              </>
            )}
            {!isConnected && !isSpectator && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-cc-warning/80 hover:text-cc-warning font-medium cursor-pointer hidden sm:inline ml-1"
              >
                reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] text-cc-muted font-mono-code">
          {status === "compacting" && (
            <span className="text-cc-warning/80 animate-pulse">compacting</span>
          )}

          {status === "running" && (
            <div className="flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-cc-primary/70 animate-breathing" />
              <span className="text-cc-primary/80">running</span>
            </div>
          )}

          {/* Presence */}
          {viewers.length > 1 && (
            <div className="flex items-center gap-0.5" title={`${viewers.length} viewers`}>
              {viewers.slice(0, 3).map((v) => (
                <span
                  key={v.id}
                  className={`w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold ${
                    v.role === "owner"
                      ? "bg-cc-primary/15 text-cc-primary"
                      : "bg-cc-hover text-cc-muted/60"
                  }`}
                  title={`${v.name} (${v.role})`}
                >
                  {v.name.charAt(0).toUpperCase()}
                </span>
              ))}
              {viewers.length > 3 && (
                <span className="text-[9px] text-cc-muted/40">+{viewers.length - 3}</span>
              )}
            </div>
          )}

          <span className="text-cc-muted/15">|</span>

          {/* Tab toggle */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setActiveTab("chat")}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
                activeTab === "chat"
                  ? "text-cc-fg bg-cc-active"
                  : "text-cc-muted/50 hover:text-cc-fg"
              }`}
            >
              log
            </button>
            <button
              onClick={() => setActiveTab("diff")}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer flex items-center gap-1 ${
                activeTab === "diff"
                  ? "text-cc-fg bg-cc-active"
                  : "text-cc-muted/50 hover:text-cc-fg"
              }`}
            >
              diff
              {changedFilesCount > 0 && (
                <span className="text-[8px] text-cc-warning tabular-nums">
                  {changedFilesCount}
                </span>
              )}
            </button>
          </div>

          {/* Action buttons — hidden for spectators (watch-only) */}
          {!isSpectator && (
            <>
              {/* Fork button */}
              {cwd && (
                <button
                  onClick={handleFork}
                  disabled={forking}
                  className="flex items-center justify-center w-6 h-6 rounded text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-40"
                  title={forking ? "Forking..." : "Fork session onto new worktree"}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3.5 h-3.5 ${forking ? "animate-pulse" : ""}`}>
                    <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
                  </svg>
                </button>
              )}

              {/* Add to Gallery */}
              <button
                onClick={() => {
                  if (currentSessionId) {
                    window.location.hash = `#/gallery?session=${encodeURIComponent(currentSessionId)}`;
                  } else {
                    window.location.hash = "#/gallery";
                  }
                }}
                className="flex items-center justify-center w-6 h-6 rounded text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                title="Add to Gallery"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1H2V3zm0 2.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7zM4 7v3h3V7H4zm5 0v1h3V7H9zm3 2.5H9V11h3V9.5z" />
                </svg>
              </button>

              {/* Share button with role selector */}
              <div className="relative">
                <button
                  onClick={() => {
                    if (shareCopied) return;
                    setShareMenuOpen(!shareMenuOpen);
                  }}
                  className="flex items-center justify-center w-6 h-6 rounded text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer relative"
                  title={shareCopied ? "Copied!" : "Share session link"}
                >
                  {shareCopied ? (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-cc-success">
                      <path d="M3 8.5l3 3 6.5-7" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                    </svg>
                  )}
                </button>
                {shareMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShareMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-cc-card border border-cc-border rounded-md shadow-panel py-1 min-w-[140px]">
                      <button
                        onClick={() => handleShare("collaborator")}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code"
                      >
                        <span className="font-medium">collaborator</span>
                        <span className="block text-cc-muted/60 text-[9px]">approve & send</span>
                      </button>
                      <button
                        onClick={() => handleShare("spectator")}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code"
                      >
                        <span className="font-medium">spectator</span>
                        <span className="block text-cc-muted/60 text-[9px]">watch only</span>
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* CLAUDE.md editor */}
              {cwd && (
                <button
                  onClick={() => setClaudeMdOpen(true)}
                  className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
                    claudeMdOpen
                      ? "text-cc-primary bg-cc-active"
                      : "text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover"
                  }`}
                  title="Edit CLAUDE.md"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
                  </svg>
                </button>
              )}
            </>
          )}

          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`flex items-center justify-center w-6 h-6 rounded transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle session panel"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm1 2v2h3V4H4zm5 0v1h3V4H9zm-5 3v2h3V7H4zm5 0v1h3V7H9zm-5 3v2h2V10H4z" />
            </svg>
          </button>
        </div>
      )}

      {/* CLAUDE.md editor modal */}
      {cwd && (
        <ClaudeMdEditor
          cwd={cwd}
          open={claudeMdOpen}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </header>
  );
}
