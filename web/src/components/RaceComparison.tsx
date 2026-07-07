import { useState } from "react";
import { api, type RaceInfo, type RaceEntryInfo } from "../api.js";
import { useStore } from "../store.js";
import { connectSession } from "../ws.js";
import { DiffViewer } from "./DiffViewer.js";

function formatDuration(ms?: number): string {
  if (!ms) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatCost(usd?: number): string {
  if (!usd) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function statusClass(status: RaceEntryInfo["status"]): string {
  if (status === "completed") return "text-cc-success";
  if (status === "failed" || status === "timeout") return "text-cc-error";
  if (status === "running") return "text-cc-primary";
  // "pending" and "skipped" (cascade never reached this entry) stay muted.
  return "text-cc-muted";
}

export function RaceComparison({ race, onUpdate }: Readonly<{ race: RaceInfo; onUpdate: (race: RaceInfo) => void }>) {
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);
  const pickWinner = async (sessionId: string) => {
    const updated = await api.pickRaceWinner(race.raceId, sessionId);
    onUpdate(updated);
  };
  const loadDiff = async (entry: RaceEntryInfo) => {
    setLoadingDiff(entry.id);
    try {
      const result = await api.getRaceEntryDiff(race.raceId, entry.id);
      setDiffs((current) => new Map(current).set(entry.id, result.diff || ""));
    } finally {
      setLoadingDiff(null);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      {race.entries.map((entry) => (
        <div key={entry.id} className="rounded-lg border border-cc-border bg-cc-card overflow-hidden">
          <div className="px-3 py-2.5 border-b border-cc-border/50 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-cc-fg truncate">{entry.backendType}</div>
              <div className={`text-[10px] uppercase font-mono-code ${statusClass(entry.status)}`}>{entry.status}</div>
            </div>
            <button
              disabled={entry.status !== "completed" || race.winnerId === entry.sessionId}
              onClick={() => void pickWinner(entry.sessionId)}
              className="px-2 py-1 rounded-md text-[11px] bg-cc-fg text-cc-bg disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {race.winnerId === entry.sessionId ? "Selected" : "Merge"}
            </button>
          </div>
          <div className="px-3 py-2.5 grid grid-cols-2 gap-2 text-[11px]">
            <Metric label="Time" value={formatDuration(entry.metrics?.wallClockMs)} />
            <Metric label="Cost" value={formatCost(entry.metrics?.costUsd)} />
            <Metric label="Files" value={String(entry.metrics?.filesChanged ?? 0)} />
            <Metric label="Lines" value={`+${entry.metrics?.linesAdded ?? 0} -${entry.metrics?.linesRemoved ?? 0}`} />
          </div>
          <div className="px-3 pb-3">
            <div className="text-[10px] text-cc-muted uppercase tracking-wider mb-1">Summary</div>
            <p className="min-h-20 max-h-40 overflow-auto rounded-md bg-cc-bg/60 px-2 py-1.5 text-[11px] text-cc-muted whitespace-pre-wrap">
              {entry.error || entry.outputSummary || (entry.status === "skipped" ? "Skipped — an earlier cascade entry succeeded." : "No output yet.")}
            </p>
          </div>
          <div className="px-3 pb-3">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] text-cc-muted uppercase tracking-wider">Diff</div>
              <button
                onClick={() => void loadDiff(entry)}
                className="text-[10px] text-cc-primary hover:text-cc-primary-hover"
              >
                {loadingDiff === entry.id ? "Loading..." : "Load"}
              </button>
            </div>
            {diffs.has(entry.id) ? (
              diffs.get(entry.id) ? (
                <div className="max-h-72 overflow-auto rounded-md border border-cc-border/50">
                  <DiffViewer unifiedDiff={diffs.get(entry.id)} fileName={entry.branch} mode="compact" />
                </div>
              ) : (
                <p className="rounded-md bg-cc-bg/60 px-2 py-1.5 text-[11px] text-cc-muted">No diff for this entry.</p>
              )
            ) : (
              <p className="rounded-md bg-cc-bg/60 px-2 py-1.5 text-[11px] text-cc-muted">
                {entry.filesChanged?.length ? `${entry.filesChanged.length} changed files` : "No changed files recorded yet."}
              </p>
            )}
          </div>
          <button
            onClick={() => {
              setCurrentSession(entry.sessionId);
              connectSession(entry.sessionId);
              window.location.hash = "";
            }}
            className="w-full border-t border-cc-border/50 px-3 py-2 text-left text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          >
            Open session {entry.sessionId.slice(0, 8)}
          </button>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-md bg-cc-bg/60 px-2 py-1.5">
      <div className="text-[9px] text-cc-muted uppercase tracking-wider">{label}</div>
      <div className="text-[12px] text-cc-fg font-mono-code">{value}</div>
    </div>
  );
}
