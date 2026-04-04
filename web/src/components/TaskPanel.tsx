import { useEffect, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { api, type UsageLimits, type GitHubPRInfo } from "../api.js";
import type { TaskItem } from "../types.js";
import { McpSection } from "./McpPanel.js";
import { CostCard } from "./CostCard.js";

const EMPTY_TASKS: TaskItem[] = [];
const POLL_INTERVAL = 60_000;

// Module-level cache — survives session switches so limits don't flash empty
const limitsCache = new Map<string, UsageLimits>();

function formatResetTime(resetsAt: string): string {
  try {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (diffMs <= 0) return "now";
    const days = Math.floor(diffMs / 86_400_000);
    const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h${minutes}m`;
    if (hours > 0) return `${hours}h${minutes}m`;
    return `${minutes}m`;
  } catch {
    return "N/A";
  }
}

function barColor(pct: number): string {
  if (pct > 80) return "bg-cc-error";
  if (pct > 50) return "bg-cc-warning";
  return "bg-cc-primary";
}

function contextBarColor(pct: number): string {
  if (pct > 80) return "bg-red-500";
  if (pct > 50) return "bg-yellow-500";
  return "bg-green-500";
}

function UsageLimitsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const [limits, setLimits] = useState<UsageLimits | null>(
    limitsCache.get(sessionId) ?? null,
  );

  const fetchLimits = useCallback(async () => {
    try {
      const data = await api.getSessionUsageLimits(sessionId);
      limitsCache.set(sessionId, data);
      setLimits(data);
    } catch {
      // silent
    }
  }, [sessionId]);

  // When sessionId changes, show cached value immediately
  useEffect(() => {
    setLimits(limitsCache.get(sessionId) ?? null);
  }, [sessionId]);

  useEffect(() => {
    fetchLimits();
    const id = setInterval(fetchLimits, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchLimits]);

  // Also tick every 30s to refresh the "resets in" countdown
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!limits) return null;

  const has5h = limits.five_hour !== null;
  const has7d = limits.seven_day !== null;
  const hasExtra = !has5h && !has7d && limits.extra_usage?.is_enabled;

  if (!has5h && !has7d && !hasExtra) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2.5 space-y-2">
      {/* 5-hour limit */}
      {limits.five_hour && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted font-medium">
              5h Limit
            </span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              {limits.five_hour.utilization}%
              {limits.five_hour.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatResetTime(limits.five_hour.resets_at)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(limits.five_hour.utilization)}`}
              style={{
                width: `${Math.min(limits.five_hour.utilization, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* 7-day limit */}
      {limits.seven_day && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted font-medium">
              7d Limit
            </span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              {limits.seven_day.utilization}%
              {limits.seven_day.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatResetTime(limits.seven_day.resets_at)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(limits.seven_day.utilization)}`}
              style={{
                width: `${Math.min(limits.seven_day.utilization, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Extra usage (only if 5h/7d not available) */}
      {hasExtra && limits.extra_usage && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted font-medium">
              Extra
            </span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              ${limits.extra_usage.used_credits.toFixed(2)} / $
              {limits.extra_usage.monthly_limit}
            </span>
          </div>
          {limits.extra_usage.utilization !== null && (
            <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColor(limits.extra_usage.utilization)}`}
                style={{
                  width: `${Math.min(limits.extra_usage.utilization, 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Codex Rate Limits ───────────────────────────────────────────────────────

function formatCodexResetTime(resetsAtMs: number): string {
  const diffMs = resetsAtMs - Date.now();
  if (diffMs <= 0) return "now";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function formatWindowDuration(mins: number): string {
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
  if (mins >= 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

function CodexRateLimitsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const rateLimits = useStore((s) => s.sessions.get(sessionId)?.codex_rate_limits);

  // Tick for countdown refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!rateLimits) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [rateLimits]);

  if (!rateLimits) return null;
  const { primary, secondary } = rateLimits;
  if (!primary && !secondary) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2.5 space-y-2">
      {primary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted font-medium">
              {formatWindowDuration(primary.windowDurationMins)} Limit
            </span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              {Math.round(primary.usedPercent)}%
              {primary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(primary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(primary.usedPercent)}`}
              style={{ width: `${Math.min(primary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
      {secondary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted font-medium">
              {formatWindowDuration(secondary.windowDurationMins)} Limit
            </span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              {Math.round(secondary.usedPercent)}%
              {secondary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(secondary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(secondary.usedPercent)}`}
              style={{ width: `${Math.min(secondary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Codex Token Details ─────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function CodexTokenDetailsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const details = useStore((s) => s.sessions.get(sessionId)?.codex_token_details);
  // Use the server-computed context percentage (input+output / contextWindow, capped 0-100)
  const contextPct = useStore((s) => s.sessions.get(sessionId)?.context_used_percent ?? 0);
  const [open, setOpen] = useState(false);

  if (!details) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] text-cc-muted uppercase tracking-wider hover:text-cc-fg hover:bg-cc-hover/50 transition-colors cursor-pointer w-full px-3 py-2.5"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 3l5 5-5 5V3z" />
        </svg>
        Tokens
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-cc-border/40">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-cc-muted">Input</span>
              <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.inputTokens)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-cc-muted">Output</span>
              <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.outputTokens)}</span>
            </div>
            {details.cachedInputTokens > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-cc-muted">Cached</span>
                <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.cachedInputTokens)}</span>
              </div>
            )}
            {details.reasoningOutputTokens > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-cc-muted">Reasoning</span>
                <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.reasoningOutputTokens)}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {details.modelContextWindow > 0 && (
        <div className="px-3 pb-2.5 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-cc-muted">Context</span>
            <span className="text-[10px] text-cc-muted tabular-nums">{contextPct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor(contextPct)}`}
              style={{ width: `${Math.min(contextPct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Claude Token Details ────────────────────────────────────────────────────

function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function ClaudeTokenDetailsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const details = useStore((s) => s.sessions.get(sessionId)?.claude_token_details);
  const [open, setOpen] = useState(false);

  if (!details) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10px] text-cc-muted uppercase tracking-wider hover:text-cc-fg hover:bg-cc-hover/50 transition-colors cursor-pointer w-full px-3 py-2.5"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 3l5 5-5 5V3z" />
        </svg>
        Tokens
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-cc-border/40">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-cc-muted">Input</span>
              <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.inputTokens)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-cc-muted">Output</span>
              <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.outputTokens)}</span>
            </div>
            {details.cacheReadInputTokens > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-cc-muted">Cache Read</span>
                <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.cacheReadInputTokens)}</span>
              </div>
            )}
            {details.cacheCreationInputTokens > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-cc-muted">Cache Write</span>
                <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatTokenCount(details.cacheCreationInputTokens)}</span>
              </div>
            )}
            {details.costUsd > 0 && (
              <div className="flex items-center justify-between col-span-2 pt-1 border-t border-cc-border/50">
                <span className="text-[10px] text-cc-muted">Cost</span>
                <span className="text-[11px] text-cc-fg tabular-nums font-mono-code">{formatCostUsd(details.costUsd)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Context Usage Bar ──────────────────────────────────────────────────────

function ContextUsageBar({ sessionId }: Readonly<{ sessionId: string }>) {
  const contextPct = useStore((s) => s.sessions.get(sessionId)?.context_used_percent ?? 0);

  if (contextPct === 0) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-cc-muted font-medium">Context</span>
        <span className="text-[10px] text-cc-muted tabular-nums">{contextPct}%</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${contextBarColor(contextPct)}`}
          style={{ width: `${Math.min(contextPct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ─── Session Stats ───────────────────────────────────────────────────────────

function SessionStatsSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const session = useStore((s) => s.sessions.get(sessionId));
  if (!session) return null;

  const cost = session.total_cost_usd ?? 0;
  const turns = session.num_turns ?? 0;
  const contextPct = session.context_used_percent ?? 0;
  const linesAdded = session.total_lines_added ?? 0;
  const linesRemoved = session.total_lines_removed ?? 0;

  // Only show when there's something to display
  if (cost === 0 && turns === 0) return null;

  return (
    <div className="mx-3 mt-3 grid grid-cols-2 gap-2">
      {/* Cost */}
      <div className="rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2">
        <span className="text-[10px] text-cc-muted uppercase tracking-wider block">Cost</span>
        <span className="text-[14px] font-semibold text-cc-fg font-mono-code">
          ${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}
        </span>
      </div>
      {/* Turns */}
      <div className="rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2">
        <span className="text-[10px] text-cc-muted uppercase tracking-wider block">Turns</span>
        <span className="text-[14px] font-semibold text-cc-fg font-mono-code">{turns}</span>
      </div>
      {/* Context */}
      {contextPct > 0 && (
        <div className="rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2">
          <span className="text-[10px] text-cc-muted uppercase tracking-wider block">Context</span>
          <span className="text-[14px] font-semibold text-cc-fg font-mono-code">{contextPct}%</span>
        </div>
      )}
      {/* Lines */}
      {(linesAdded > 0 || linesRemoved > 0) && (
        <div className="rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2">
          <span className="text-[10px] text-cc-muted uppercase tracking-wider block">Lines</span>
          <span className="text-[14px] font-semibold font-mono-code">
            <span className="text-cc-success">+{linesAdded}</span>
            {" / "}
            <span className="text-cc-error">-{linesRemoved}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── GitHub PR Status ────────────────────────────────────────────────────────

function prStatePill(state: GitHubPRInfo["state"], isDraft: boolean) {
  if (isDraft) return { label: "Draft", cls: "text-cc-muted bg-cc-hover" };
  switch (state) {
    case "OPEN": return { label: "Open", cls: "text-cc-success bg-cc-success/10" };
    case "MERGED": return { label: "Merged", cls: "text-purple-400 bg-purple-400/10" };
    case "CLOSED": return { label: "Closed", cls: "text-cc-error bg-cc-error/10" };
  }
}

export function GitHubPRDisplay({ pr }: Readonly<{ pr: GitHubPRInfo }>) {
  const pill = prStatePill(pr.state, pr.isDraft);
  const { checksSummary: cs, reviewThreads: rt } = pr;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card px-3 py-2.5 space-y-1.5">
      {/* Row 1: PR number + state pill */}
      <div className="flex items-center gap-1.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] font-semibold text-cc-fg hover:text-cc-primary transition-colors"
        >
          PR #{pr.number}
        </a>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${pill.cls}`}>
          {pill.label}
        </span>
        {/* CI checks as colored dots */}
        {cs.total > 0 && (
          <div className="flex items-center gap-1 ml-auto">
            {cs.success > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-cc-success">
                <span className="w-1.5 h-1.5 rounded-full bg-cc-success inline-block" />
                {cs.success}
              </span>
            )}
            {cs.pending > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-cc-warning">
                <span className="w-1.5 h-1.5 rounded-full bg-cc-warning inline-block" />
                {cs.pending}
              </span>
            )}
            {cs.failure > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-cc-error">
                <span className="w-1.5 h-1.5 rounded-full bg-cc-error inline-block" />
                {cs.failure}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Row 2: Title */}
      <p className="text-[11px] text-cc-muted truncate" title={pr.title}>
        {pr.title}
      </p>

      {/* Row 3: Review + unresolved + diff stats */}
      <div className="flex items-center gap-2 text-[10px] text-cc-muted">
        {pr.reviewDecision === "APPROVED" && (
          <span className="text-cc-success">Approved</span>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <span className="text-cc-error">Changes requested</span>
        )}
        {(pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === null) && pr.state === "OPEN" && (
          <span>Review pending</span>
        )}
        {rt.unresolved > 0 && (
          <span className="text-cc-warning">{rt.unresolved} unresolved</span>
        )}
        <span className="ml-auto">
          <span className="text-cc-success">+{pr.additions}</span>
          {" "}
          <span className="text-cc-error">-{pr.deletions}</span>
          {" "}
          <span>&middot; {pr.changedFiles}f</span>
        </span>
      </div>
    </div>
  );
}

function GitHubPRSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const prStatus = useStore((s) => s.prStatus.get(sessionId));

  const cwd = session?.cwd || sdk?.cwd;
  const branch = session?.git_branch || sdk?.gitBranch;

  // One-time REST fallback on mount if no pushed data yet
  useEffect(() => {
    if (prStatus || !cwd || !branch) return;
    api.getPRStatus(cwd, branch).then((data) => {
      useStore.getState().setPRStatus(sessionId, data);
    }).catch(() => {});
  }, [sessionId, cwd, branch, prStatus]);

  if (!prStatus?.available || !prStatus.pr) return null;

  return <GitHubPRDisplay pr={prStatus.pr} />;
}

// ─── Cost Card ───────────────────────────────────────────────────────────────

function CostCardSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sessionName = useStore((s) => s.sessionNames.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`);
  const status = useStore((s) => s.sessionStatus.get(sessionId));

  if (!session) return null;

  const cost = session.total_cost_usd ?? 0;
  const turns = session.num_turns ?? 0;

  // Only show when the session is idle and has completed at least one turn
  if (status !== "idle" || turns === 0) return null;

  // Use accumulated API duration from result messages (actual work time, not wall clock)
  const durationMs = session.total_duration_api_ms ?? 0;

  return (
    <div className="mx-3 mt-3">
      <CostCard
        sessionName={sessionName}
        cost={cost}
        turns={turns}
        durationMs={durationMs}
        model={session.model || "unknown"}
        backend={session.backend_type || "claude"}
        linesAdded={session.total_lines_added ?? 0}
        linesRemoved={session.total_lines_removed ?? 0}
      />
    </div>
  );
}

// ─── Collapsible MCP Section Wrapper ────────────────────────────────────────

function CollapsibleMcpSection({ sessionId }: Readonly<{ sessionId: string }>) {
  const mcpServers = useStore((s) => s.mcpServers.get(sessionId));
  const [open, setOpen] = useState(false);

  const count = mcpServers?.length ?? 0;
  if (count === 0) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-2.5 text-[10px] text-cc-muted uppercase tracking-wider hover:text-cc-fg hover:bg-cc-hover/50 transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 3l5 5-5 5V3z" />
        </svg>
        MCP Servers
        <span className="rounded-full bg-cc-primary/10 text-cc-primary px-1.5 text-[10px] font-medium leading-[16px] ml-auto">
          {count}
        </span>
      </button>
      {open && (
        <div className="border-t border-cc-border/40">
          <McpSection sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}


// ─── Task Panel ──────────────────────────────────────────────────────────────

export { CodexRateLimitsSection, CodexTokenDetailsSection, ClaudeTokenDetailsSection };

export function TaskPanel({ sessionId }: Readonly<{ sessionId: string }>) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId) || EMPTY_TASKS);
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkBackendType = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId)?.backendType);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  if (!taskPanelOpen) return null;

  const isCodex = (session?.backend_type || sdkBackendType) === "codex";
  const showTasks = !!session;

  // Group tasks: in_progress first, then pending, then completed
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const pending = tasks.filter((t) => t.status !== "in_progress" && t.status !== "completed");
  const completed = tasks.filter((t) => t.status === "completed");
  const sortedTasks = [...inProgress, ...pending, ...completed];
  const completedCount = completed.length;

  return (
    <aside className="w-[280px] h-full flex flex-col overflow-hidden bg-cc-bg border-l border-cc-border">
      {/* Header — h-11 to match top bar */}
      <div className="shrink-0 flex items-center justify-between px-4 h-11 border-b border-cc-border">
        <span className="text-[13px] font-semibold text-cc-fg">
          Session
        </span>
        <button
          onClick={() => setTaskPanelOpen(false)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all duration-200 cursor-pointer"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Context usage bar — right below header */}
      <ContextUsageBar sessionId={sessionId} />

      <div data-testid="task-panel-content" className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* Usage limits & token details — varies by backend */}
        {isCodex ? (
          <>
            <CodexRateLimitsSection sessionId={sessionId} />
            <CodexTokenDetailsSection sessionId={sessionId} />
          </>
        ) : (
          <>
            <UsageLimitsSection sessionId={sessionId} />
            <ClaudeTokenDetailsSection sessionId={sessionId} />
          </>
        )}

        {/* Session stats */}
        <SessionStatsSection sessionId={sessionId} />

        {/* Cost card — shown when session has completed at least one turn */}
        <CostCardSection sessionId={sessionId} />

        {/* GitHub PR status */}
        <GitHubPRSection sessionId={sessionId} />

        {/* MCP servers — collapsible with count badge */}
        <CollapsibleMcpSection sessionId={sessionId} />

        {showTasks && (
          <div className="mx-3 mt-3 rounded-lg border border-cc-border/60 bg-cc-card overflow-hidden">
            {/* Task section header */}
            <div className="px-3 py-2.5 border-b border-cc-border/40 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">Tasks</span>
              <div className="flex items-center gap-2">
                {tasks.length > 0 && (
                  <span className="text-[11px] text-cc-muted tabular-nums">
                    {completedCount}/{tasks.length}
                  </span>
                )}
                {tasks.length > 0 && (
                  <button
                    onClick={() => { globalThis.location.hash = "#/kanban"; }}
                    className="text-[10px] font-mono-code text-cc-muted hover:text-cc-fg px-1.5 py-0.5 rounded hover:bg-cc-hover transition-all duration-200 cursor-pointer"
                    title="View Kanban board"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 inline-block mr-0.5 -mt-px">
                      <path d="M1.5 2h4v12h-4V2zm.75.75v10.5h2.5V2.75h-2.5zM6 2h4v8H6V2zm.75.75v6.5h2.5v-6.5h-2.5zM10.5 2h4v10h-4V2zm.75.75v8.5h2.5v-8.5h-2.5z" />
                    </svg>
                    board
                  </button>
                )}
              </div>
            </div>

            {/* Task list — grouped: in_progress, pending, completed */}
            <div className="px-1">
              {tasks.length === 0 ? (
                <p className="text-xs text-cc-muted text-center py-8">No tasks yet</p>
              ) : (
                <div className="divide-y divide-cc-border/30">
                  {sortedTasks.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function TaskStatusIcon({ status }: Readonly<{ status: TaskItem["status"] }>) {
  if (status === "in_progress") {
    return (
      <svg className="w-[18px] h-[18px] text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-[18px] h-[18px] text-cc-success" aria-hidden>
        <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" clipRule="evenodd" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" className="w-[18px] h-[18px] text-cc-muted" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TaskRow({ task }: Readonly<{ task: TaskItem }>) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div
      className="px-2.5 py-2 hover:bg-cc-hover/30 transition-colors"
    >
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-[18px] h-[18px] mt-px">
          <TaskStatusIcon status={task.status} />
        </span>

        {/* Subject */}
        <span
          className={`text-[12px] leading-snug flex-1 ${
            isCompleted ? "text-cc-muted/60 opacity-60" : "text-cc-fg"
          }`}
        >
          {task.subject}
        </span>
      </div>

      {/* Active form text (in_progress only) */}
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-[26px] text-[11px] text-cc-muted italic truncate">
          {task.activeForm}
        </p>
      )}

      {/* Blocked by */}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-[26px] text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M5 8h6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}
