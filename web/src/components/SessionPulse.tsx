import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import type { BackgroundAgentItem, TaskItem } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionActivity {
  sessionId: string;
  name: string;
  status: "idle" | "running" | "compacting" | "disconnected";
  cost: number;
  pendingPerms: number;
  startedAt: number | null;
}

interface ActiveTool {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
}

type PanelTab = "activity" | "sessions";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatElapsed(startedAt: number, completedAt?: number): string {
  const elapsed = Math.max(0, Math.round(((completedAt || Date.now()) - startedAt) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (secs > 0) return mins + "m " + secs + "s";
  return mins + "m";
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "";
  return `$${usd.toFixed(2)}`;
}

function sessionStatusColor(status: SessionActivity["status"]): string {
  if (status === "running") return "bg-cc-primary";
  if (status === "compacting") return "bg-cc-warning";
  return "bg-cc-success";
}

function agentStatusColor(status: BackgroundAgentItem["status"]): string {
  if (status === "running") return "bg-cc-primary";
  if (status === "failed") return "bg-cc-error";
  return "bg-cc-success";
}

const EMPTY_AGENTS: BackgroundAgentItem[] = [];
const EMPTY_TASKS: TaskItem[] = [];

// ─── Tick Hook ──────────────────────────────────────────────────────────────

function useSecondTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return tick;
}

// ─── Auto-hide Hook ─────────────────────────────────────────────────────────

function useAutoHide(
  agents: BackgroundAgentItem[],
  tasks: TaskItem[],
  sessions: SessionActivity[],
  delayMs = 4000,
): boolean {
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const totalCount = agents.length + tasks.length + sessions.length;

  const allResolved =
    totalCount > 0 &&
    tasks.every((t) => t.status === "completed") &&
    agents.every((a) => a.status !== "running") &&
    sessions.length === 0;

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (allResolved) {
      timerRef.current = setTimeout(() => setHidden(true), delayMs);
    } else {
      setHidden(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [allResolved, delayMs]);

  // Reset when new entries arrive
  useEffect(() => {
    setHidden(false);
  }, [totalCount]);

  return hidden;
}

// ─── Panel Interaction Hook (click-outside, escape, focus) ──────────────────

function usePanelInteractions(
  expanded: boolean,
  setExpanded: (v: boolean) => void,
  trayRef: React.RefObject<HTMLDivElement | null>,
  panelRef: React.RefObject<HTMLDialogElement | null>,
) {
  useEffect(() => {
    if (!expanded) return;
    function handleClick(e: MouseEvent) {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [expanded, setExpanded, trayRef]);

  useEffect(() => {
    if (!expanded) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExpanded(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [expanded, setExpanded]);

  useEffect(() => {
    if (expanded && panelRef.current) {
      panelRef.current.focus();
    }
  }, [expanded, panelRef]);
}

// ─── Pill Summary Builder ───────────────────────────────────────────────────

function buildPillText(
  runningAgents: number,
  completedAgents: number,
  activeToolCount: number,
  completedTasks: number,
  totalTasks: number,
  runningSessions: number,
): string {
  const segments: string[] = [];
  if (runningAgents > 0) segments.push(`${runningAgents} agent${runningAgents > 1 ? "s" : ""}`);
  else if (completedAgents > 0) segments.push(`${completedAgents} done`);
  if (activeToolCount > 0) segments.push(`${activeToolCount} tool${activeToolCount > 1 ? "s" : ""}`);
  if (totalTasks > 0) segments.push(`${completedTasks}/${totalTasks}`);
  if (runningSessions > 0) segments.push(`${runningSessions} session${runningSessions > 1 ? "s" : ""}`);
  return segments.join(" · ") || "activity";
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function SessionPulse() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessions = useStore((s) => s.sessions);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionStartTimes = useStore((s) => s.sessionStartTimes);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const bgAgents = useStore((s) => currentSessionId ? (s.sessionBackgroundAgents.get(currentSessionId) || EMPTY_AGENTS) : EMPTY_AGENTS);
  const tasks = useStore((s) => currentSessionId ? (s.sessionTasks.get(currentSessionId) || EMPTY_TASKS) : EMPTY_TASKS);
  const toolProgressMap = useStore((s) => currentSessionId ? s.toolProgress.get(currentSessionId) : undefined);

  // Convert tool progress map to array for rendering
  const activeTools: ActiveTool[] = useMemo(() => {
    if (!toolProgressMap) return [];
    return Array.from(toolProgressMap.entries()).map(([id, data]) => ({
      toolUseId: id,
      toolName: data.toolName,
      elapsedSeconds: data.elapsedSeconds,
    }));
  }, [toolProgressMap]);

  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<PanelTab>("activity");
  const panelRef = useRef<HTMLDialogElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);

  // Build background sessions list (non-current, active sessions)
  const bgSessions: SessionActivity[] = useMemo(() => {
    return sdkSessions
      .filter((s) => !s.archived && s.sessionId !== currentSessionId)
      .map((s) => {
        const status = sessionStatus.get(s.sessionId);
        const session = sessions.get(s.sessionId);
        const perms = pendingPermissions.get(s.sessionId);
        let resolvedStatus: SessionActivity["status"] = "disconnected";
        if (status === "running") resolvedStatus = "running";
        else if (status === "compacting") resolvedStatus = "compacting";
        else if (status === "idle") resolvedStatus = "idle";
        return {
          sessionId: s.sessionId,
          name: sessionNames.get(s.sessionId) || s.sessionId.slice(0, 8),
          status: resolvedStatus,
          cost: session?.total_cost_usd || 0,
          pendingPerms: perms ? perms.size : 0,
          startedAt: sessionStartTimes.get(s.sessionId) || null,
        };
      })
      .filter((a) => a.status === "running" || a.status === "compacting" || a.pendingPerms > 0);
  }, [sdkSessions, currentSessionId, sessionStatus, sessionNames, sessions, pendingPermissions, sessionStartTimes]);

  // Counts
  const runningAgents = bgAgents.filter((a) => a.status === "running").length;
  const completedAgents = bgAgents.filter((a) => a.status !== "running").length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const runningSessions = bgSessions.filter((a) => a.status === "running" || a.status === "compacting").length;
  const sessionPermCount = bgSessions.reduce((sum, a) => sum + a.pendingPerms, 0);

  const hasAgentActivity = bgAgents.length > 0 || tasks.length > 0 || activeTools.length > 0;
  const hasSessionActivity = bgSessions.length > 0;
  const hasAny = hasAgentActivity || hasSessionActivity;

  // Shared tick for elapsed timers
  const hasRunning = runningAgents > 0 || runningSessions > 0 || activeTools.length > 0;
  useSecondTick(hasRunning);

  // Auto-hide when everything resolves
  const shouldHide = useAutoHide(bgAgents, tasks, bgSessions);

  // Auto-select tab based on what has content
  useEffect(() => {
    if (hasAgentActivity && !hasSessionActivity) setActiveTab("activity");
    else if (!hasAgentActivity && hasSessionActivity) setActiveTab("sessions");
  }, [hasAgentActivity, hasSessionActivity]);

  // Panel interaction effects (click-outside, escape, focus)
  usePanelInteractions(expanded, setExpanded, trayRef, panelRef);

  const handleJump = useCallback((sessionId: string) => {
    setCurrentSession(sessionId);
    setExpanded(false);
  }, [setCurrentSession]);

  // Don't render when nothing to show
  if (shouldHide && !hasAny) return null;
  if (!hasAny && !expanded) return null;

  const pillText = buildPillText(runningAgents, completedAgents, activeTools.length, completedTasks, tasks.length, runningSessions);

  return (
    <div
      ref={trayRef}
      className="absolute bottom-3 right-3 z-20"
      style={{
        transition: "opacity 0.4s ease-out",
        opacity: hasAny ? 1 : 0,
        pointerEvents: hasAny ? "auto" : "none",
      }}
    >
      {/* Expanded panel */}
      {expanded && hasAny && (
        <dialog
          ref={panelRef}
          open
          aria-label="Activity panel"
          id="session-pulse-panel"
          className="mb-2 w-80 max-w-[calc(100vw-2rem)] max-h-80 rounded-xl border border-cc-border/60 bg-cc-card/95 backdrop-blur-xl shadow-float animate-slide-up outline-none p-0 m-0 relative flex flex-col"
        >
          {/* Header with tabs */}
          <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-cc-border/40">
            {hasAgentActivity && (
              <button
                onClick={() => setActiveTab("activity")}
                className={`px-2.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
                  activeTab === "activity"
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                Activity{" "}
                <span className="text-[9px] tabular-nums opacity-70">
                  {bgAgents.length + activeTools.length + tasks.length}
                </span>
              </button>
            )}
            {hasSessionActivity && (
              <button
                onClick={() => setActiveTab("sessions")}
                className={`px-2.5 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wider transition-colors cursor-pointer ${
                  activeTab === "sessions"
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                Sessions
                {bgSessions.length > 0 && (
                  <span className="ml-1.5 text-[9px] tabular-nums opacity-70">{bgSessions.length}</span>
                )}
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={() => setExpanded(false)}
              className="p-1 rounded hover:bg-cc-hover transition-colors cursor-pointer"
              aria-label="Close panel"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted">
                <path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z" />
              </svg>
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === "activity" && hasAgentActivity && (
              <ActivityPanel agents={bgAgents} tools={activeTools} tasks={tasks} />
            )}
            {activeTab === "sessions" && hasSessionActivity && (
              <SessionsPanel sessions={bgSessions} onJump={handleJump} />
            )}
          </div>
        </dialog>
      )}

      {/* Trigger pill */}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls="session-pulse-panel"
        className={[
          "flex items-center gap-2 px-3 h-8 rounded-full",
          "border border-cc-border/50 bg-cc-card/90 backdrop-blur-lg",
          "hover:bg-cc-hover/80 hover:border-cc-border/70",
          "transition-all duration-200 cursor-pointer",
          "animate-slide-up shadow-panel",
          expanded ? "ring-1 ring-cc-primary/30" : "",
        ].join(" ")}
      >
        {/* Pulse indicator */}
        <span className="relative flex h-2 w-2">
          {hasRunning && (
            <span className="absolute inset-0 rounded-full bg-cc-primary opacity-75 animate-ping" />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${
            hasRunning ? "bg-cc-primary" : "bg-cc-success"
          }`} />
        </span>

        {/* Summary text */}
        <span className="text-[11px] font-medium text-cc-fg/80 font-mono-code whitespace-nowrap">
          {pillText}
        </span>

        {/* Permission badge */}
        {sessionPermCount > 0 && (
          <span className="flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-cc-warning/15 text-cc-warning text-[9px] font-semibold tabular-nums">
            {sessionPermCount}
          </span>
        )}

        {/* Chevron */}
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted/60 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4.427 9.573l3.396-3.396a.25.25 0 01.354 0l3.396 3.396a.25.25 0 01-.177.427H4.604a.25.25 0 01-.177-.427z" />
        </svg>
      </button>
    </div>
  );
}

// ─── Activity Panel (agents + tools + tasks — works for all backends) ───────

function ActivityPanel({ agents, tools, tasks }: Readonly<{ agents: BackgroundAgentItem[]; tools: ActiveTool[]; tasks: TaskItem[] }>) {
  const hasPrevSection = agents.length > 0;
  const needsSepBeforeTools = hasPrevSection && tools.length > 0;
  const needsSepBeforeTasks = (hasPrevSection || tools.length > 0) && tasks.length > 0;

  return (
    <div className="py-1.5">
      {/* Background agents section (Claude Code specific) */}
      {agents.length > 0 && (
        <div>
          <div className="px-3 py-1">
            <span className="text-[9px] text-cc-muted/50 uppercase tracking-widest font-semibold">Agents</span>
          </div>
          {agents.map((agent) => (
            <AgentRow key={agent.toolUseId} agent={agent} />
          ))}
        </div>
      )}

      {/* Active tools section (works for ALL backends) */}
      {needsSepBeforeTools && <hr className="mx-3 my-1.5 border-t border-cc-border/30 border-b-0 border-x-0" />}
      {tools.length > 0 && (
        <div>
          <div className="px-3 py-1">
            <span className="text-[9px] text-cc-muted/50 uppercase tracking-widest font-semibold">Tools</span>
          </div>
          {tools.map((tool) => (
            <ToolProgressRow key={tool.toolUseId} tool={tool} />
          ))}
        </div>
      )}

      {/* Tasks section */}
      {needsSepBeforeTasks && <hr className="mx-3 my-1.5 border-t border-cc-border/30 border-b-0 border-x-0" />}
      {tasks.length > 0 && (
        <div>
          <div className="px-3 py-1">
            <span className="text-[9px] text-cc-muted/50 uppercase tracking-widest font-semibold">Tasks</span>
          </div>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Row ──────────────────────────────────────────────────────────────

function AgentRow({ agent }: Readonly<{ agent: BackgroundAgentItem }>) {
  const [showSummary, setShowSummary] = useState(false);
  const isRunning = agent.status === "running";
  const elapsed = formatElapsed(agent.startedAt, agent.completedAt);
  const hasSummary = !!agent.summary;

  const content = (
    <>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {isRunning && (
          <span className="absolute inset-0 rounded-full bg-cc-primary opacity-75 animate-breathing" />
        )}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${agentStatusColor(agent.status)}`} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[11px] font-medium truncate ${
            agent.status === "running" ? "text-cc-fg" : "text-cc-fg/60"
          }`}>
            {agent.name}
          </span>
          <span className="text-[8px] text-cc-muted/40 uppercase font-mono-code shrink-0">
            {agent.agentType}
          </span>
        </div>
        {(hasSummary && showSummary) && (
          <p className="text-[10px] text-cc-muted/60 mt-0.5 leading-tight">
            {agent.summary}
          </p>
        )}
      </div>
      <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums shrink-0">
        {elapsed}
      </span>
    </>
  );

  if (hasSummary) {
    return (
      <button
        onClick={() => setShowSummary((v) => !v)}
        aria-expanded={showSummary}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-cc-hover/60 transition-colors text-left cursor-pointer"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      {content}
    </div>
  );
}

// ─── Tool Progress Row (works for ALL backends) ────────────────────────────

function ToolProgressRow({ tool }: Readonly<{ tool: ActiveTool }>) {
  const elapsedStr = tool.elapsedSeconds < 60
    ? tool.elapsedSeconds + "s"
    : Math.floor(tool.elapsedSeconds / 60) + "m " + (tool.elapsedSeconds % 60) + "s";

  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      <svg className="w-3.5 h-3.5 text-cc-primary animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="text-[11px] font-medium text-cc-fg truncate flex-1">
        {tool.toolName}
      </span>
      <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums shrink-0">
        {elapsedStr}
      </span>
    </div>
  );
}

// ─── Task Row ───────────────────────────────────────────────────────────────

function TaskRow({ task }: Readonly<{ task: TaskItem }>) {
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      {/* Status icon */}
      {task.status === "in_progress" && (
        <svg className="w-3.5 h-3.5 text-cc-primary animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {task.status === "completed" && (
        <svg className="w-3.5 h-3.5 text-cc-success shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
        </svg>
      )}
      {task.status === "pending" && (
        <svg className="w-3.5 h-3.5 text-cc-muted/30 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="5.5" />
        </svg>
      )}
      {/* Task text */}
      <div className="flex-1 min-w-0">
        <span className={`text-[11px] truncate block ${
          task.status === "completed" ? "text-cc-muted/50 line-through" : "text-cc-fg"
        }`}>
          {task.subject}
        </span>
        {task.status === "in_progress" && task.activeForm && (
          <span className="text-[10px] text-cc-muted/50 italic truncate block">
            {task.activeForm}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Sessions Panel ─────────────────────────────────────────────────────────

function SessionsPanel({ sessions, onJump }: Readonly<{ sessions: SessionActivity[]; onJump: (id: string) => void }>) {
  return (
    <div className="py-1">
      {sessions.map((activity) => (
        <SessionRow key={activity.sessionId} activity={activity} onJump={onJump} />
      ))}
    </div>
  );
}

// ─── Session Row ────────────────────────────────────────────────────────────

function SessionRow({ activity, onJump }: Readonly<{ activity: SessionActivity; onJump: (id: string) => void }>) {
  const cost = formatCost(activity.cost);
  const isActive = activity.status === "running" || activity.status === "compacting";

  return (
    <button
      onClick={() => onJump(activity.sessionId)}
      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-cc-hover/60 transition-colors text-left cursor-pointer group"
      title={`Switch to ${activity.name}`}
    >
      {/* Status dot */}
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        {isActive && (
          <span className={`absolute inset-0 rounded-full opacity-75 animate-breathing ${
            activity.status === "compacting" ? "bg-cc-warning" : "bg-cc-primary"
          }`} />
        )}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${sessionStatusColor(activity.status)}`} />
      </span>

      {/* Name + details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-cc-fg truncate">
            {activity.name}
          </span>
          {activity.status === "compacting" && (
            <span className="text-[9px] text-cc-warning/70 font-mono-code shrink-0">compacting</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {isActive && activity.startedAt != null && (
            <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums">
              {formatElapsed(activity.startedAt)}
            </span>
          )}
          {cost && (
            <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums">{cost}</span>
          )}
        </div>
      </div>

      {/* Permission alert badge */}
      {activity.pendingPerms > 0 && (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-cc-warning/10 shrink-0">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-warning" aria-hidden>
            <path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
          </svg>
          <span className="text-[9px] font-semibold text-cc-warning tabular-nums">{activity.pendingPerms}</span>
        </span>
      )}

      {/* Jump arrow */}
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-muted/30 group-hover:text-cc-primary/60 transition-colors shrink-0" aria-hidden>
        <path d="M8.22 2.97a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06l2.97-2.97H3.75a.75.75 0 010-1.5h7.44L8.22 4.03a.75.75 0 010-1.06z" />
      </svg>
    </button>
  );
}
