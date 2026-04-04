import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import type { SessionRole, PresenceViewer } from "../types.js";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { ProviderSwitcher } from "./ProviderSwitcher.js";

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
  const isSessionView =
    hash !== "#/settings" &&
    hash !== "#/terminal" &&
    hash !== "#/environments" &&
    hash !== "#/gallery" &&
    hash !== "#/webhooks" &&
    hash !== "#/adapters";

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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

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

  // Focus the name input when entering edit mode
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  // ---- Handlers ----

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
        // Clipboard API fails on non-HTTPS -- try legacy fallback
        try {
          const textarea = document.createElement("textarea");
          textarea.value = url;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          copied = document.execCommand("copy");
          document.body.removeChild(textarea);
        } catch {
          /* fallback also failed */
        }
      }
      if (copied) {
        setShareCopied(true);
        setShareMenuOpen(false);
        setOverflowOpen(false);
        setTimeout(() => setShareCopied(false), 2000);
      } else {
        // Last resort: show the URL in a prompt so user can manually copy
        setShareMenuOpen(false);
        setOverflowOpen(false);
        window.prompt("Copy this invite link:", url);
      }
    } catch (err) {
      console.error("[TopBar] Failed to create invite link:", err);
    }
  }

  function handleNameClick() {
    if (isSpectator || !currentSessionId) return;
    setNameInput(sessionName || "");
    setEditingName(true);
  }

  async function handleNameSubmit() {
    setEditingName(false);
    const trimmed = nameInput.trim();
    if (!currentSessionId || !trimmed || trimmed === sessionName) return;
    try {
      await api.renameSession(currentSessionId, trimmed);
      useStore.getState().setSessionName(currentSessionId, trimmed);
    } catch (err) {
      console.error("[TopBar] Failed to rename session:", err);
    }
  }

  function handleCopySessionId() {
    if (!currentSessionId) return;
    navigator.clipboard.writeText(currentSessionId).catch(() => {
      window.prompt("Session ID:", currentSessionId);
    });
    setOverflowOpen(false);
  }

  return (
    <header className="shrink-0 flex items-center justify-between px-3 h-11 bg-cc-bg border-b border-cc-border">
      {/* ---- Left: sidebar toggle + session name + connection dot ---- */}
      <div className="flex items-center gap-2 min-w-0">
        {/* Sidebar toggle -- hidden for spectators */}
        {!isSpectator && (
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
            aria-pressed={sidebarOpen}
            className="flex items-center justify-center w-7 h-7 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4">
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}

        {/* Spectator badge */}
        {isSpectator && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono-code uppercase tracking-wider bg-cc-muted/10 text-cc-muted">
            spectator
          </span>
        )}

        {/* Session name + connection dot */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isConnected ? "bg-cc-success" : "bg-cc-muted/30"
              }`}
              title={isConnected ? "Connected" : "Disconnected"}
            />
            {editingName ? (
              <input
                ref={nameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={handleNameSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleNameSubmit();
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="text-sm font-medium text-cc-fg bg-transparent border-b border-cc-primary/50 outline-none max-w-[12rem] sm:max-w-[20rem]"
              />
            ) : (
              <span
                onClick={handleNameClick}
                className={`text-sm font-medium text-cc-fg max-w-[10rem] sm:max-w-[20rem] truncate ${
                  !isSpectator ? "cursor-pointer hover:text-cc-primary transition-colors" : ""
                }`}
                title={sessionName || undefined}
              >
                {sessionName}
              </span>
            )}

            {/* Status indicators -- subtle inline */}
            {status === "compacting" && (
              <span className="text-[10px] text-cc-warning/70 font-mono-code animate-pulse ml-1">compacting</span>
            )}
            {status === "running" && (
              <div className="flex items-center gap-1 ml-1">
                <span className="w-1 h-1 rounded-full bg-cc-primary/60 animate-breathing" />
                <span className="text-[10px] text-cc-primary/70 font-mono-code">running</span>
              </div>
            )}

            {/* Reconnect button */}
            {!isConnected && !isSpectator && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[10px] text-cc-warning/80 hover:text-cc-warning font-medium font-mono-code cursor-pointer ml-1 hidden sm:inline"
              >
                reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* ---- Center/Right: tabs + actions ---- */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-2">
          {/* Presence avatars */}
          {viewers.length > 1 && (
            <div className="flex items-center gap-0.5 mr-1" title={`${viewers.length} viewers`}>
              {viewers.slice(0, 3).map((v) => (
                <span
                  key={v.id}
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
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
                <span className="text-[9px] text-cc-muted/40 ml-0.5">+{viewers.length - 3}</span>
              )}
            </div>
          )}

          {/* Tab pills */}
          <div className="flex items-center bg-cc-hover/50 rounded-md p-0.5">
            <button
              onClick={() => setActiveTab("chat")}
              aria-pressed={activeTab === "chat"}
              className={`text-[11px] px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                activeTab === "chat"
                  ? "text-cc-fg bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Log
            </button>
            <button
              onClick={() => setActiveTab("diff")}
              aria-pressed={activeTab === "diff"}
              className={`text-[11px] px-2.5 py-1 rounded-md transition-colors cursor-pointer flex items-center gap-1 ${
                activeTab === "diff"
                  ? "text-cc-fg bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Diff
              {changedFilesCount > 0 && (
                <span className="text-[9px] text-cc-warning tabular-nums">{changedFilesCount}</span>
              )}
            </button>
            <button
              onClick={() => setActiveTab("files")}
              aria-pressed={activeTab === "files"}
              className={`text-[11px] px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                activeTab === "files"
                  ? "text-cc-fg bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Files
            </button>
          </div>

          {/* Cost */}
          {totalCost > 0 && (
            <span
              className="text-[11px] text-cc-muted font-mono-code tabular-nums"
              title={`Session cost: $${totalCost.toFixed(4)}`}
            >
              ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
            </span>
          )}

          {/* Provider + Model switcher */}
          {!isSpectator && (
            <div className="flex items-center gap-0.5">
              <ProviderSwitcher sessionId={currentSessionId} />
              <span className="text-cc-border text-[10px] select-none">/</span>
              <ModelSwitcher sessionId={currentSessionId} />
            </div>
          )}

          {/* Overflow menu -- hidden for spectators */}
          {!isSpectator && (
            <div className="relative" ref={overflowRef}>
              <button
                onClick={() => setOverflowOpen(!overflowOpen)}
                aria-label="More actions"
                className="flex items-center justify-center w-7 h-7 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
              {overflowOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => { setOverflowOpen(false); setShareMenuOpen(false); }} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-cc-card border border-cc-border rounded-md shadow-panel py-1 min-w-[180px]">
                    {/* Fork */}
                    {cwd && (
                      <button
                        onClick={() => { handleFork(); setOverflowOpen(false); }}
                        disabled={forking}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code flex items-center gap-2 disabled:opacity-40"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path fillRule="evenodd" d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z" />
                        </svg>
                        {forking ? "Forking..." : "Fork session"}
                      </button>
                    )}

                    {/* Share sub-menu */}
                    <div className="relative">
                      <button
                        onClick={() => setShareMenuOpen(!shareMenuOpen)}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code flex items-center gap-2"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path d="M15 8a3 3 0 10-2.977-2.63l-4.94 2.47a3 3 0 100 4.319l4.94 2.47a3 3 0 10.895-1.789l-4.94-2.47a3.027 3.027 0 000-.74l4.94-2.47C13.456 7.68 14.19 8 15 8z" />
                        </svg>
                        {shareCopied ? "Copied!" : "Share"}
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 ml-auto">
                          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      {shareMenuOpen && (
                        <div className="absolute right-full top-0 mr-1 bg-cc-card border border-cc-border rounded-md shadow-panel py-1 min-w-[150px]">
                          <button
                            onClick={() => handleShare("collaborator")}
                            className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code"
                          >
                            <span className="font-medium">Collaborator</span>
                            <span className="block text-cc-muted/60 text-[9px]">approve & send</span>
                          </button>
                          <button
                            onClick={() => handleShare("spectator")}
                            className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code"
                          >
                            <span className="font-medium">Spectator</span>
                            <span className="block text-cc-muted/60 text-[9px]">watch only</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="my-1 border-t border-cc-border" />

                    {/* Edit CLAUDE.md */}
                    {cwd && (
                      <button
                        onClick={() => { setClaudeMdOpen(true); setOverflowOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code flex items-center gap-2"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
                        </svg>
                        Edit CLAUDE.md
                      </button>
                    )}

                    {/* View in gallery */}
                    <button
                      onClick={() => {
                        window.location.hash = currentSessionId
                          ? `#/gallery?session=${encodeURIComponent(currentSessionId)}`
                          : "#/gallery";
                        setOverflowOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code flex items-center gap-2"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v1H2V3zm0 2.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7zM4 7v3h3V7H4zm5 0v1h3V7H9zm3 2.5H9V11h3V9.5z" />
                      </svg>
                      View in gallery
                    </button>

                    <div className="my-1 border-t border-cc-border" />

                    {/* Copy session ID */}
                    <button
                      onClick={handleCopySessionId}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer font-mono-code flex items-center gap-2"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                        <path d="M5.75 1a.75.75 0 00-.75.75v1.5a.75.75 0 001.5 0V2.5h5v9h-.75a.75.75 0 000 1.5h1.5a.75.75 0 00.75-.75v-10.5A.75.75 0 0012.25 1h-6.5zM3.75 4a.75.75 0 00-.75.75v10.5a.75.75 0 00.75.75h6.5a.75.75 0 00.75-.75V4.75a.75.75 0 00-.75-.75h-6.5zM4.5 5.5h5v9h-5v-9z" />
                      </svg>
                      Copy session ID
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Task panel toggle */}
          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            aria-label="Toggle session panel"
            aria-pressed={taskPanelOpen}
            className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
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
