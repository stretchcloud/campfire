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
    <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Connection status */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isConnected ? "bg-cc-success" : "bg-cc-muted opacity-40"
              }`}
            />
            {sessionName && (
              <span className="text-[11px] font-medium text-cc-fg max-w-[9rem] sm:max-w-none truncate" title={sessionName}>
                {sessionName}
              </span>
            )}
            {totalCost > 0 && (
              <span className="text-[10px] text-cc-muted font-mono" title={`Session cost: $${totalCost.toFixed(4)}`}>
                ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
              </span>
            )}
            {!isConnected && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[11px] text-cc-warning hover:text-cc-warning/80 font-medium cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-2 sm:gap-3 text-[12px] text-cc-muted">
          {status === "compacting" && (
            <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
          )}

          {status === "running" && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cc-primary animate-[pulse-dot_1s_ease-in-out_infinite]" />
              <span className="text-cc-primary font-medium">Thinking</span>
            </div>
          )}

          {/* Presence avatars */}
          {viewers.length > 1 && (
            <div className="flex items-center -space-x-1.5" title={`${viewers.length} viewers connected`}>
              {viewers.slice(0, 4).map((v) => (
                <div
                  key={v.id}
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold border-2 border-cc-card ${
                    v.role === "owner"
                      ? "bg-cc-primary text-white"
                      : v.role === "spectator"
                        ? "bg-cc-hover text-cc-muted"
                        : "bg-cc-warning/20 text-cc-warning"
                  }`}
                  title={`${v.name} (${v.role})`}
                >
                  {v.name.charAt(0).toUpperCase()}
                </div>
              ))}
              {viewers.length > 4 && (
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold bg-cc-hover text-cc-muted border-2 border-cc-card">
                  +{viewers.length - 4}
                </div>
              )}
            </div>
          )}

          {/* Chat / Editor tab toggle */}
          <div className="flex items-center bg-cc-hover rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab("chat")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                activeTab === "chat"
                  ? "bg-cc-card text-cc-fg shadow-sm"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Chat
            </button>
            <button
              onClick={() => setActiveTab("diff")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === "diff"
                  ? "bg-cc-card text-cc-fg shadow-sm"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Diffs
              {changedFilesCount > 0 && (
                <span className="text-[9px] bg-cc-warning text-white rounded-full w-4 h-4 flex items-center justify-center font-semibold leading-none">
                  {changedFilesCount}
                </span>
              )}
            </button>
          </div>

          {/* Fork button */}
          {cwd && (
            <button
              onClick={handleFork}
              disabled={forking}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
              title={forking ? "Forking..." : "Fork session onto new worktree"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-4 h-4 ${forking ? "animate-pulse" : ""}`}>
                <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
              </svg>
            </button>
          )}

          {/* Add to Gallery */}
          <button
            onClick={() => {
              window.location.hash = "#/gallery";
            }}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Add to Gallery"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
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
              className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer relative"
              title={shareCopied ? "Copied!" : "Share session link"}
            >
              {shareCopied ? (
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cc-success">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                </svg>
              )}
            </button>
            {shareMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShareMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-cc-card border border-cc-border rounded-lg shadow-lg py-1 min-w-[160px]">
                  <button
                    onClick={() => handleShare("collaborator")}
                    className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    <span className="font-medium">Collaborator</span>
                    <span className="block text-cc-muted text-[10px]">Can approve & send messages</span>
                  </button>
                  <button
                    onClick={() => handleShare("spectator")}
                    className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    <span className="font-medium">Spectator</span>
                    <span className="block text-cc-muted text-[10px]">Watch only</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* CLAUDE.md editor */}
          {cwd && (
            <button
              onClick={() => setClaudeMdOpen(true)}
              className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                claudeMdOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Edit CLAUDE.md"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
              </svg>
            </button>
          )}

          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle session panel"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h4a1 1 0 100-2H7z" clipRule="evenodd" />
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
