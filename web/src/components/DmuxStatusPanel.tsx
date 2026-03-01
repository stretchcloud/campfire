import { useState, useEffect } from "react";
import type { DmuxSessionStatus, DmuxPaneInfo } from "../api.js";
import { connectDmux, disconnectDmux, sendDmuxFocusPane } from "../dmux-ws.js";

interface DmuxStatusPanelProps {
  cwd: string;
  onPaneFocus?: (target: string) => void;
  onViewLog?: (tmuxTarget: string) => void;
}

const STATUS_COLORS: Record<DmuxPaneInfo["agentStatus"], string> = {
  working: "bg-green-500",
  waiting: "bg-yellow-500",
  analyzing: "bg-blue-500",
  idle: "bg-cc-muted/40",
};

const STATUS_LABELS: Record<DmuxPaneInfo["agentStatus"], string> = {
  working: "Working",
  waiting: "Waiting",
  analyzing: "Analyzing",
  idle: "Idle",
};

export function DmuxStatusPanel({ cwd, onPaneFocus, onViewLog }: DmuxStatusPanelProps) {
  const [status, setStatus] = useState<DmuxSessionStatus | null>(null);

  useEffect(() => {
    connectDmux(cwd, setStatus);
    return () => disconnectDmux();
  }, [cwd]);

  if (!status || !status.running) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-cc-muted">Waiting for dmux session...</p>
      </div>
    );
  }

  const handlePaneClick = (pane: DmuxPaneInfo) => {
    sendDmuxFocusPane(pane.tmuxTarget);
    onPaneFocus?.(pane.tmuxTarget);
  };

  const handleNewPane = () => {
    // Send 'n' to the dmux control pane (first pane, typically the orchestrator)
    if (status.panes.length > 0) {
      // Use the REST API for send_keys since it's a one-off action
      import("../dmux-ws.js").then(({ sendDmuxMessage }) => {
        sendDmuxMessage({ type: "send_keys", tmuxTarget: status.panes[0].tmuxTarget, keys: "n", enter: true });
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {status.panes.map((pane) => (
          <div
            key={pane.id}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              pane.isActive
                ? "border-cc-primary bg-cc-primary/5"
                : "border-cc-border bg-cc-card hover:bg-cc-card-hover"
            }`}
          >
            <button
              type="button"
              onClick={() => handlePaneClick(pane)}
              className="w-full text-left cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[pane.agentStatus]}`}
                  title={STATUS_LABELS[pane.agentStatus]}
                />
                <span className="text-sm font-medium text-cc-fg truncate">
                  {pane.agent}
                </span>
                <span className="text-xs text-cc-muted">{pane.slug}</span>
              </div>
              {pane.branchName && (
                <p className="text-xs font-mono text-cc-muted truncate mt-1">
                  {pane.branchName}
                </p>
              )}
              {pane.worktreePath && (
                <p className="text-[10px] text-cc-muted/60 truncate mt-0.5">
                  {pane.worktreePath}
                </p>
              )}
            </button>
            {onViewLog && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewLog(pane.tmuxTarget);
                }}
                className="mt-2 px-2 py-0.5 text-[10px] font-medium rounded border border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-card-hover transition-colors cursor-pointer"
              >
                View Log
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-cc-border flex items-center justify-between">
        <button
          type="button"
          onClick={handleNewPane}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
        >
          New Pane
        </button>
        <span className="text-xs text-cc-muted">
          {status.totalPanes} pane{status.totalPanes !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
