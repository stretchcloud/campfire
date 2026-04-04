import { useState, useEffect, useCallback } from "react";
import { api, type MonitorSnapshot } from "../api.js";
import { useStore } from "../store.js";

/**
 * ProtocolMonitorPage — real-time dashboard showing WebSocket message
 * flow, per-session stats, backend breakdown, and protocol drift alerts.
 * Auto-refreshes every 3 seconds for live monitoring.
 */

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const BACKEND_COLORS: Record<string, string> = {
  claude: "text-[#5BA8A0]", codex: "text-blue-500", goose: "text-amber-500",
  aider: "text-purple-500", openhands: "text-rose-500", openclaw: "text-orange-500", opencode: "text-teal-500",
};

export function ProtocolMonitorPage({ embedded = false }: Readonly<{ embedded?: boolean }>) {
  const [stats, setStats] = useState<MonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionNames = useStore((s) => s.sessionNames);

  const refresh = useCallback(() => {
    api.getMonitorStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-cc-muted text-sm">Loading monitor...</div>;
  }
  if (!stats) {
    return <div className="flex items-center justify-center h-64 text-cc-muted text-sm">Monitor not available</div>;
  }

  return (
    <div className={embedded ? "px-4 py-6 max-w-5xl mx-auto" : "p-6 max-w-5xl mx-auto"}>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-cc-fg">Protocol Monitor</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">Real-time WebSocket message flow and health metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-cc-success animate-breathing" />
          <span className="text-[11px] text-cc-muted font-mono-code">Live · {formatUptime(stats.uptime)}</span>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <MetricCard label="Total Messages" value={stats.totalMessages.toLocaleString()} />
        <MetricCard label="Messages/min" value={String(stats.globalMessagesPerMinute)} accent={stats.globalMessagesPerMinute > 0} />
        <MetricCard label="Active Sessions" value={String(stats.activeSessions)} />
        <MetricCard label="Errors" value={String(stats.totalErrors)} error={stats.totalErrors > 0} />
      </div>

      {/* Backend breakdown */}
      {Object.keys(stats.backendBreakdown).length > 0 && (
        <div className="mb-5">
          <h2 className="text-[12px] font-semibold text-cc-fg mb-2">Backend Breakdown</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.backendBreakdown).map(([bt, data]) => (
              <div key={bt} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cc-border bg-cc-card">
                <span className={`text-[12px] font-semibold ${BACKEND_COLORS[bt] || "text-cc-muted"}`}>{bt}</span>
                <span className="text-[11px] text-cc-fg font-mono-code tabular-nums">{data.messages} msgs</span>
                {data.errors > 0 && <span className="text-[10px] text-cc-error font-mono-code tabular-nums">{data.errors} err</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Message type distribution */}
      {Object.keys(stats.messageTypeGlobal).length > 0 && (
        <div className="mb-5">
          <h2 className="text-[12px] font-semibold text-cc-fg mb-2">Message Types (5min window)</h2>
          <div className="flex flex-wrap gap-1">
            {Object.entries(stats.messageTypeGlobal)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 20)
              .map(([type, count]) => (
                <span key={type} className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
                  {type}: <span className="text-cc-fg tabular-nums">{count}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Per-session stats */}
      {stats.sessionStats.length > 0 && (
        <div className="mb-5">
          <h2 className="text-[12px] font-semibold text-cc-fg mb-2">Active Sessions</h2>
          <div className="space-y-1.5">
            {stats.sessionStats.map((s) => {
              const name = sessionNames.get(s.sessionId) || s.sessionId.slice(0, 8);
              return (
                <div key={s.sessionId} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-cc-border bg-cc-card">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${BACKEND_COLORS[s.backendType] || "text-cc-muted"} bg-current/10`}>
                    {s.backendType}
                  </span>
                  <span className="text-[12px] font-medium text-cc-fg truncate flex-1">{name}</span>
                  <span className="text-[10px] text-cc-muted font-mono-code tabular-nums">{s.messageCount} msgs</span>
                  <span className="text-[10px] text-cc-muted font-mono-code tabular-nums">{s.messagesPerMinute}/min</span>
                  {s.errorCount > 0 && <span className="text-[10px] text-cc-error font-mono-code tabular-nums">{s.errorCount} err</span>}
                  <span className="text-[10px] text-cc-muted/50 font-mono-code">{formatTime(s.lastMessageAt)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Protocol drift alerts */}
      {stats.recentDrifts.length > 0 && (
        <div>
          <h2 className="text-[12px] font-semibold text-cc-error mb-2">Protocol Drift Alerts</h2>
          <div className="space-y-1">
            {stats.recentDrifts.map((d) => (
              <div key={`${d.backendType}-${d.messageType}-${d.timestamp}`} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cc-error/20 bg-cc-error/[0.03]">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0" aria-hidden>
                  <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754z" />
                </svg>
                <span className="text-[11px] font-medium text-cc-fg">{d.backendType}</span>
                <span className="text-[10px] text-cc-muted font-mono-code">{d.direction} {d.messageType}</span>
                <span className="text-[10px] text-cc-error/70 flex-1 truncate">{d.details}</span>
                <span className="text-[9px] text-cc-muted/50 font-mono-code">{formatTime(d.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.activeSessions === 0 && stats.totalMessages === 0 && (
        <div className="text-center py-12 text-cc-muted">
          <p className="text-sm">No activity yet</p>
          <p className="text-xs mt-1">Start a session to see real-time protocol metrics</p>
        </div>
      )}
    </div>
  );
}

// ─── Metric Card ────────────────────────────────────────────────────────────

function metricColor(isError: boolean, isAccent: boolean): string {
  if (isError) return "text-cc-error";
  if (isAccent) return "text-cc-primary";
  return "text-cc-fg";
}

function MetricCard({ label, value, accent = false, error = false }: Readonly<{
  label: string;
  value: string;
  accent?: boolean;
  error?: boolean;
}>) {
  return (
    <div className="rounded-xl border border-cc-border bg-cc-card px-4 py-3">
      <p className="text-[10px] text-cc-muted uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold font-mono-code tabular-nums ${
        metricColor(error, accent)
      }`}>
        {value}
      </p>
    </div>
  );
}
