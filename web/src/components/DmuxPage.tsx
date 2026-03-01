import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import { FolderPicker } from "./FolderPicker.js";
import { TerminalView } from "./TerminalView.js";
import { DmuxStatusPanel } from "./DmuxStatusPanel.js";
import { DmuxLaunchForm } from "./DmuxLaunchForm.js";
import { DmuxPaneLogViewer } from "./DmuxPaneLogViewer.js";
import { DmuxConfigEditor } from "./DmuxConfigEditor.js";
import type { DmuxRecordingMeta } from "../api.js";

interface PrereqStatus {
  dmux: { available: boolean; path: string | null };
  tmux: { available: boolean; path: string | null };
}

export function DmuxPage() {
  // State 1: Prereq check
  const [prereqStatus, setPrereqStatus] = useState<PrereqStatus | null>(null);
  const [prereqError, setPrereqError] = useState<string | null>(null);

  // State 2: Launch form
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // State 3: Dashboard
  const [dmuxRunning, setDmuxRunning] = useState(false);
  const [launchCommand, setLaunchCommand] = useState<string | null>(null);
  const [statusPanelOpen, setStatusPanelOpen] = useState(true);

  // Pane log viewer
  const [selectedPaneLog, setSelectedPaneLog] = useState<string | null>(null);
  const paneOutputHandlerRef = useRef<((tmuxTarget: string, data: string, isHistory?: boolean) => void) | null>(null);

  // Config editor
  const [showConfigEditor, setShowConfigEditor] = useState(false);

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [showRecordingsList, setShowRecordingsList] = useState(false);
  const [recordings, setRecordings] = useState<DmuxRecordingMeta[]>([]);

  // Check prerequisites on mount
  useEffect(() => {
    api.checkDmuxPrereqs()
      .then(setPrereqStatus)
      .catch((err) => setPrereqError(err.message || "Failed to check prerequisites"));
  }, []);

  // When a cwd is selected, check if dmux is already running there
  const checkExistingSession = useCallback((cwd: string) => {
    api.getDmuxStatus(cwd)
      .then((status) => {
        if (status.running) {
          setDmuxRunning(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedCwd) {
      checkExistingSession(selectedCwd);
    }
  }, [selectedCwd, checkExistingSession]);

  const allReady = prereqStatus?.dmux.available && prereqStatus?.tmux.available;

  const handleLaunch = (command: string) => {
    setLaunchCommand(command);
    setDmuxRunning(true);
  };

  const handleFolderSelect = (path: string) => {
    setSelectedCwd(path);
    setShowFolderPicker(false);
    // Reset dashboard state when folder changes
    setDmuxRunning(false);
    setLaunchCommand(null);
  };

  const handleToggleRecording = async () => {
    if (!selectedCwd) return;
    try {
      if (isRecording) {
        await api.stopDmuxRecording();
        setIsRecording(false);
      } else {
        await api.startDmuxRecording(selectedCwd);
        setIsRecording(true);
      }
    } catch {
      // Ignore errors
    }
  };

  const loadRecordings = async () => {
    try {
      const list = await api.listDmuxRecordings();
      setRecordings(list);
      setShowRecordingsList(true);
    } catch {
      // Ignore errors
    }
  };

  const registerOutputHandler = useCallback((handler: (tmuxTarget: string, data: string, isHistory?: boolean) => void) => {
    paneOutputHandlerRef.current = handler;
    // Re-connect dmux WS with the pane output handler
    if (selectedCwd) {
      import("../dmux-ws.js").then(({ connectDmux }) => {
        connectDmux(selectedCwd, () => {}, handler);
      });
    }
  }, [selectedCwd]);

  const unregisterOutputHandler = useCallback(() => {
    paneOutputHandlerRef.current = null;
  }, []);

  // ─── State 1: Prereq check (loading, error, or missing) ──────────

  if (prereqStatus === null && !prereqError) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 h-full flex flex-col">
          <Header />
          <div className="flex-1 min-h-[420px]">
            <div className="h-full bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 flex items-center justify-center text-center">
              <p className="text-sm text-cc-muted">Checking prerequisites...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (prereqError) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 h-full flex flex-col">
          <Header />
          <div className="flex-1 min-h-[420px]">
            <div className="h-full bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 flex items-center justify-center text-center">
              <div className="max-w-md">
                <h2 className="text-lg font-semibold text-cc-fg mb-2">Error</h2>
                <p className="text-sm text-cc-muted">{prereqError}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (prereqStatus && !allReady) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 h-full flex flex-col">
          <Header />
          <div className="flex-1 min-h-[420px]">
            <div className="h-full bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 flex items-center justify-center text-center">
              <div className="max-w-md">
                <h2 className="text-lg font-semibold text-cc-fg mb-4">Missing Prerequisites</h2>
                <p className="text-sm text-cc-muted mb-6">
                  dmux requires the following tools to be installed:
                </p>
                <PrereqList prereqStatus={prereqStatus} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── State 3: Dashboard (dmux running) ────────────────────────────

  if (allReady && selectedCwd && dmuxRunning) {
    return (
      <div className="h-full bg-cc-bg flex flex-col">
        {/* Dashboard header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-cc-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-sm font-semibold text-cc-fg whitespace-nowrap">dmux</h1>
            <code className="text-xs text-cc-muted truncate">{selectedCwd}</code>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowConfigEditor(true)}
              className="px-2 py-1 text-xs font-medium rounded border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
            >
              Config
            </button>
            <button
              type="button"
              onClick={handleToggleRecording}
              className={`px-2 py-1 text-xs font-medium rounded border transition-colors cursor-pointer ${
                isRecording
                  ? "border-red-500/30 text-red-400 bg-red-500/10 hover:bg-red-500/20"
                  : "border-cc-border text-cc-fg hover:bg-cc-card-hover"
              }`}
            >
              {isRecording ? "Stop Rec" : "Record"}
            </button>
            <button
              type="button"
              onClick={loadRecordings}
              className="px-2 py-1 text-xs font-medium rounded border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
            >
              Recordings
            </button>
            <button
              type="button"
              onClick={() => setStatusPanelOpen(!statusPanelOpen)}
              className="px-2 py-1 text-xs font-medium rounded border border-cc-border text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
            >
              {statusPanelOpen ? "Hide Panel" : "Show Panel"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDmuxRunning(false);
                setLaunchCommand(null);
              }}
              className="px-2 py-1 text-xs font-medium rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              Stop
            </button>
          </div>
        </div>

        {/* Split layout */}
        <div className="flex-1 flex min-h-0">
          {/* Left: Status panel */}
          {statusPanelOpen && (
            <div className="w-[280px] shrink-0 border-r border-cc-border overflow-hidden">
              <DmuxStatusPanel
                cwd={selectedCwd}
                onViewLog={(tmuxTarget) => setSelectedPaneLog(tmuxTarget)}
              />
            </div>
          )}

          {/* Center: Terminal */}
          <div className="flex-1 min-w-0 flex flex-col">
            <TerminalView
              cwd={selectedCwd}
              embedded
              initialCommand={launchCommand || undefined}
            />
          </div>

          {/* Right: Pane log viewer (overlay) */}
          {selectedPaneLog && (
            <div className="w-[400px] shrink-0">
              <DmuxPaneLogViewer
                tmuxTarget={selectedPaneLog}
                onClose={() => setSelectedPaneLog(null)}
                registerOutputHandler={registerOutputHandler}
                unregisterOutputHandler={unregisterOutputHandler}
              />
            </div>
          )}
        </div>

        {showFolderPicker && (
          <FolderPicker
            initialPath={selectedCwd || ""}
            onSelect={handleFolderSelect}
            onClose={() => setShowFolderPicker(false)}
          />
        )}

        {showConfigEditor && selectedCwd && (
          <DmuxConfigEditor
            cwd={selectedCwd}
            onClose={() => setShowConfigEditor(false)}
          />
        )}

        {/* Recordings list modal */}
        {showRecordingsList && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowRecordingsList(false)}>
            <div className="bg-cc-card border border-cc-border rounded-xl p-6 max-w-lg w-full mx-4 max-h-[60vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-cc-fg">Recordings</h2>
                <button type="button" onClick={() => setShowRecordingsList(false)} className="text-cc-muted hover:text-cc-fg cursor-pointer">&times;</button>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2">
                {recordings.length === 0 ? (
                  <p className="text-sm text-cc-muted text-center py-4">No recordings yet</p>
                ) : (
                  recordings.map((rec) => (
                    <a
                      key={rec.filename}
                      href={`#/dmux/replay/${encodeURIComponent(rec.filename)}`}
                      className="block p-3 rounded-lg border border-cc-border hover:bg-cc-card-hover transition-colors"
                      onClick={() => setShowRecordingsList(false)}
                    >
                      <div className="text-sm font-medium text-cc-fg">{rec.sessionName}</div>
                      <div className="text-xs text-cc-muted mt-1">
                        {new Date(rec.startedAt).toLocaleString()} - {rec.panes.length} pane{rec.panes.length !== 1 ? "s" : ""}
                      </div>
                      <div className="text-[10px] text-cc-muted/60 mt-0.5 truncate">{rec.filename}</div>
                    </a>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── State 2: Launch form (prereqs pass, no running session) ──────

  return (
    <div className="h-full bg-cc-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 h-full flex flex-col">
        <Header
          showChangeFolder={!!selectedCwd}
          onChangeFolder={() => setShowFolderPicker(true)}
        />

        <div className="flex-1 min-h-[420px] flex items-center justify-center">
          {!selectedCwd ? (
            <div className="bg-cc-card border border-cc-border rounded-xl p-6 sm:p-8 text-center max-w-md">
              <h2 className="text-lg font-semibold text-cc-fg mb-2">Choose a project folder</h2>
              <p className="text-sm text-cc-muted mb-4">
                Select a folder to launch dmux in. Each agent will get its own git worktree.
              </p>
              <button
                type="button"
                onClick={() => setShowFolderPicker(true)}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
              >
                Choose Folder
              </button>
            </div>
          ) : (
            <DmuxLaunchForm
              cwd={selectedCwd}
              onLaunch={handleLaunch}
              onChangeCwd={() => setShowFolderPicker(true)}
            />
          )}
        </div>
      </div>

      {showFolderPicker && (
        <FolderPicker
          initialPath={selectedCwd || ""}
          onSelect={handleFolderSelect}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function Header({
  showChangeFolder,
  onChangeFolder,
}: {
  showChangeFolder?: boolean;
  onChangeFolder?: () => void;
} = {}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-6 shrink-0">
      <div>
        <h1 className="text-xl font-semibold text-cc-fg">dmux</h1>
        <p className="mt-1 text-sm text-cc-muted">
          Run multiple AI coding agents in parallel via tmux panes.
        </p>
      </div>
      {showChangeFolder && onChangeFolder && (
        <button
          type="button"
          onClick={onChangeFolder}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer whitespace-nowrap"
        >
          Change Folder
        </button>
      )}
    </div>
  );
}

function PrereqList({ prereqStatus }: { prereqStatus: PrereqStatus }) {
  return (
    <div className="space-y-3 text-left">
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border ${
          prereqStatus.dmux.available
            ? "border-green-500/30 bg-green-500/5"
            : "border-red-500/30 bg-red-500/5"
        }`}
      >
        <span className={`text-lg ${prereqStatus.dmux.available ? "text-green-500" : "text-red-500"}`}>
          {prereqStatus.dmux.available ? "\u2713" : "\u2717"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-cc-fg">dmux</div>
          {!prereqStatus.dmux.available && (
            <code className="text-xs text-cc-muted block mt-1">npm install -g dmux</code>
          )}
        </div>
      </div>
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border ${
          prereqStatus.tmux.available
            ? "border-green-500/30 bg-green-500/5"
            : "border-red-500/30 bg-red-500/5"
        }`}
      >
        <span className={`text-lg ${prereqStatus.tmux.available ? "text-green-500" : "text-red-500"}`}>
          {prereqStatus.tmux.available ? "\u2713" : "\u2717"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-cc-fg">tmux</div>
          {!prereqStatus.tmux.available && (
            <code className="text-xs text-cc-muted block mt-1">
              apt install tmux{" "}
              <span className="text-cc-muted/50">or</span>{" "}
              brew install tmux
            </code>
          )}
        </div>
      </div>
    </div>
  );
}
