import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { api, type BackendInfo } from "../api.js";
import { getDefaultModel, getDefaultMode } from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { connectSession } from "../ws.js";

/**
 * ProviderSwitcher — a compact TopBar dropdown showing the current backend
 * provider with the ability to quickly create a new session using a
 * different provider. Shows availability status for each backend.
 *
 * Switching providers creates a new session (same cwd) since each backend
 * is a separate process that can't be swapped mid-session.
 */

const PROVIDER_META: Record<string, { label: string; color: string; icon: string }> = {
  claude:    { label: "Claude",    color: "text-[#5BA8A0]", icon: "\u2728" },
  codex:     { label: "Codex",     color: "text-blue-500",  icon: "\u2733" },
  goose:     { label: "Goose",     color: "text-amber-500", icon: "\u{1F9AA}" },
  aider:     { label: "Aider",     color: "text-purple-500", icon: "\u25C6" },
  openhands: { label: "OpenHands", color: "text-rose-500",  icon: "\u270B" },
  openclaw:  { label: "OpenClaw",  color: "text-orange-500", icon: "\u{1F43E}" },
  opencode:  { label: "OpenCode",  color: "text-teal-500",  icon: "\u25CF" },
};

function getProviderInfo(id: string) {
  return PROVIDER_META[id] || { label: id, color: "text-cc-muted", icon: "\u25C6" };
}

export function ProviderSwitcher({ sessionId }: Readonly<{ sessionId: string }>) {
  const sdkSession = useStore((s) =>
    s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
  );
  const runtimeSession = useStore((s) => s.sessions.get(sessionId));
  const setCurrentSession = useStore((s) => s.setCurrentSession);

  const [open, setOpen] = useState(false);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [switching, setSwitching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentBackend = (runtimeSession?.backend_type || sdkSession?.backendType || "claude") as string;
  const currentCwd = runtimeSession?.cwd || sdkSession?.cwd || "";
  const provider = getProviderInfo(currentBackend);

  // Fetch available backends when dropdown opens
  useEffect(() => {
    if (!open) return;
    api.getBackends().then(setBackends).catch(() => {});
  }, [open]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const handleSwitch = useCallback(async (backendId: string) => {
    if (backendId === currentBackend) {
      setOpen(false);
      return;
    }

    setSwitching(true);
    try {
      const bt = backendId as BackendType;
      const result = await api.createSession({
        backend: bt,
        model: getDefaultModel(bt),
        permissionMode: getDefaultMode(bt),
        cwd: currentCwd || undefined,
      });
      if (result.sessionId) {
        connectSession(result.sessionId);
        setCurrentSession(result.sessionId);
      }
      setOpen(false);
    } catch (err) {
      console.error("[ProviderSwitcher] Failed to create session:", err);
    } finally {
      setSwitching(false);
    }
  }, [currentBackend, currentCwd, setCurrentSession]);

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger badge */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch provider"
        aria-expanded={open}
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
          open
            ? "bg-cc-active text-cc-fg"
            : `${provider.color} hover:bg-cc-hover`
        }`}
      >
        <span className="text-[10px]">{provider.icon}</span>
        <span className="hidden sm:inline">{provider.label}</span>
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          <path d="M4.427 9.573l3.396-3.396a.25.25 0 01.354 0l3.396 3.396a.25.25 0 01-.177.427H4.604a.25.25 0 01-.177-.427z" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <ul
          aria-label="Available providers"
          className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-cc-card border border-cc-border rounded-lg shadow-float py-1 animate-slide-down list-none m-0 p-0 py-1"
        >
          <li className="px-3 py-1">
            <span className="text-[9px] text-cc-muted/50 uppercase tracking-widest font-semibold">
              Providers
            </span>
          </li>
          {backends.map((b) => {
            const info = getProviderInfo(b.id);
            const isCurrent = b.id === currentBackend;
            return (
              <li key={b.id}>
                <button
                  onClick={() => handleSwitch(b.id)}
                  disabled={!b.available || switching}
                  aria-pressed={isCurrent}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    isCurrent
                      ? "bg-cc-primary/8"
                      : "hover:bg-cc-hover"
                  }`}
                >
                  <span className={`text-sm ${info.color}`}>{info.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-cc-fg">{info.label}</span>
                      {!b.available && (
                        <span className="text-[8px] text-cc-muted/50 font-mono-code">not installed</span>
                      )}
                    </div>
                    {isCurrent && (
                      <span className="text-[9px] text-cc-muted/60">current session</span>
                    )}
                    {!isCurrent && b.available && (
                      <span className="text-[9px] text-cc-muted/50">new session, same directory</span>
                    )}
                  </div>
                  {isCurrent && (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary shrink-0" aria-hidden>
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}

          {/* Loading state */}
          {backends.length === 0 && (
            <li className="px-3 py-2 text-[11px] text-cc-muted">Loading providers...</li>
          )}

          {/* Hint */}
          {switching && (
            <li className="px-3 py-1.5 text-[10px] text-cc-primary font-mono-code animate-breathing">
              Creating session...
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
