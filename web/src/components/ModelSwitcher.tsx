import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { getModelsForBackend, getDefaultModel, type ModelOption } from "../utils/backends.js";
import type { BackendType } from "../types.js";

/**
 * ModelSwitcher — a compact dropdown for switching AI models mid-session.
 *
 * Unlike companion's version (Claude-only), this works for ALL backends
 * that support runtime model switching. Renders in the TopBar as a subtle
 * pill that shows the current model and expands into a grouped dropdown.
 */

function resolveBackendType(
  sdkBackend: string | undefined,
  runtimeBackend: string | undefined,
): BackendType {
  return (runtimeBackend || sdkBackend || "claude") as BackendType;
}

function findCurrentOption(models: ModelOption[], modelId: string): ModelOption | null {
  const match = models.find((m) => m.value === modelId);
  if (match) return match;
  if (!modelId) return null;
  // Fallback for custom/unknown models
  const shortLabel = modelId.split("/").pop() || modelId;
  return { value: modelId, label: shortLabel, icon: "\u25C6" };
}

export function ModelSwitcher({ sessionId }: Readonly<{ sessionId: string }>) {
  const sdkSession = useStore((s) =>
    s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
  );
  const runtimeSession = useStore((s) => s.sessions.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const backendType = resolveBackendType(sdkSession?.backendType, runtimeSession?.backend_type);
  const isCodex = backendType === "codex";
  const currentModel = runtimeSession?.model ?? sdkSession?.model ?? getDefaultModel(backendType);
  const models = getModelsForBackend(backendType);
  const currentOption = findCurrentOption(models, currentModel);

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

  function handleSelect(model: string) {
    if (model === currentModel) {
      setOpen(false);
      return;
    }

    // Send model switch via WebSocket (only if CLI is connected)
    if (cliConnected) {
      sendToSession(sessionId, { type: "set_model", model });
    }

    // Optimistic update: reflect in sidebar/TopBar immediately
    const { sdkSessions, setSdkSessions } = useStore.getState();
    setSdkSessions(
      sdkSessions.map((sdk) =>
        sdk.sessionId === sessionId ? { ...sdk, model } : sdk,
      ),
    );

    setOpen(false);
  }

  // Don't render if we have no model info at all
  if (isCodex || !currentOption) return null;

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch model"
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono-code transition-colors cursor-pointer ${
          open
            ? "bg-cc-active text-cc-fg"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
      >
        <span className="text-[10px]">{currentOption.icon}</span>
        <span className="max-w-[80px] truncate hidden sm:inline">{currentOption.label}</span>
        <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          <path d="M4.427 9.573l3.396-3.396a.25.25 0 01.354 0l3.396 3.396a.25.25 0 01-.177.427H4.604a.25.25 0 01-.177-.427z" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <ul
          aria-label="Available models"
          className="absolute right-0 top-full mt-1 z-50 min-w-[180px] max-h-64 overflow-y-auto bg-cc-card border border-cc-border rounded-lg shadow-float py-1 animate-slide-down list-none m-0 p-0 py-1"
        >
          {/* Backend label */}
          <div className="px-3 py-1">
            <span className="text-[9px] text-cc-muted/50 uppercase tracking-widest font-semibold">
              {backendType}
            </span>
          </div>

          {models.map((m) => {
            const isSelected = m.value === currentModel;
            return (
              <li key={m.value}>
                <button
                  onClick={() => handleSelect(m.value)}
                  aria-pressed={isSelected}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-cc-primary/8 text-cc-fg"
                      : "text-cc-fg/80 hover:bg-cc-hover"
                  }`}
                >
                  <span className="text-[11px] w-4 text-center shrink-0">{m.icon}</span>
                  <span className="text-[11px] font-medium flex-1 truncate">{m.label}</span>
                  {isSelected && (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary shrink-0" aria-hidden>
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
