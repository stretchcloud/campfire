import { useMemo } from "react";
import { useStore } from "../store.js";
import type { TaskItem } from "../types.js";

type Column = "pending" | "in_progress" | "completed";

const COLUMN_CONFIG: Record<Column, { label: string; emptyText: string; dotColor: string; headerColor: string }> = {
  pending: {
    label: "To Do",
    emptyText: "No pending tasks",
    dotColor: "bg-cc-muted/40",
    headerColor: "text-cc-muted",
  },
  in_progress: {
    label: "In Progress",
    emptyText: "Nothing in progress",
    dotColor: "bg-cc-primary animate-pulse",
    headerColor: "text-cc-primary",
  },
  completed: {
    label: "Done",
    emptyText: "Nothing completed yet",
    dotColor: "bg-cc-success",
    headerColor: "text-cc-success",
  },
};

function TaskCard({ task }: { task: TaskItem }) {
  const isBlocked = task.blockedBy && task.blockedBy.length > 0;

  return (
    <div
      className={`p-3 rounded-lg border transition-colors ${
        isBlocked
          ? "border-cc-border/50 bg-cc-hover/30 opacity-60"
          : "border-cc-border bg-cc-card hover:border-cc-muted/20"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-cc-fg leading-tight">
            {task.subject}
          </p>
          {task.description && task.description !== task.subject && (
            <p className="text-[10px] text-cc-muted mt-1 line-clamp-2 leading-relaxed">
              {task.description}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {task.owner && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">
            {task.owner}
          </span>
        )}
        {task.activeForm && task.status === "in_progress" && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary">
            {task.activeForm}
          </span>
        )}
        {isBlocked && (
          <span className="text-[9px] font-mono-code px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-warning">
            blocked
          </span>
        )}
        <span className="text-[9px] font-mono-code text-cc-muted/40 ml-auto">
          #{task.id}
        </span>
      </div>
    </div>
  );
}

function KanbanColumn({ column, tasks }: { column: Column; tasks: TaskItem[] }) {
  const config = COLUMN_CONFIG[column];

  return (
    <div className="flex-1 min-w-[250px] max-w-[400px]">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 pb-3 border-b border-cc-border">
        <div className={`w-2 h-2 rounded-full ${config.dotColor}`} />
        <span className={`text-[12px] font-semibold ${config.headerColor}`}>
          {config.label}
        </span>
        <span className="text-[10px] text-cc-muted/50 font-mono-code tabular-nums ml-auto">
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className="space-y-2 pt-3 min-h-[100px]">
        {tasks.length === 0 ? (
          <div className="text-[11px] text-cc-muted/40 italic text-center py-6">
            {config.emptyText}
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
}

export function KanbanPage() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const allTasks = useStore((s) => {
    if (!currentSessionId) return new Map<string, TaskItem[]>();
    return s.sessionTasks;
  });
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);

  // Aggregate all tasks across sessions or show for current session
  const { grouped, totalCount, sessionId } = useMemo(() => {
    const pending: TaskItem[] = [];
    const in_progress: TaskItem[] = [];
    const completed: TaskItem[] = [];

    // If there's a current session, show that session's tasks
    // Otherwise, aggregate all
    const sessionsToShow = currentSessionId
      ? [[currentSessionId, allTasks.get(currentSessionId) || []] as const]
      : Array.from(allTasks.entries());

    for (const [, tasks] of sessionsToShow) {
      for (const task of tasks) {
        if (task.status === "completed") {
          completed.push(task);
        } else if (task.status === "in_progress") {
          in_progress.push(task);
        } else {
          pending.push(task);
        }
      }
    }

    return {
      grouped: { pending, in_progress, completed },
      totalCount: pending.length + in_progress.length + completed.length,
      sessionId: currentSessionId,
    };
  }, [allTasks, currentSessionId]);

  const sessionName = sessionId
    ? sessionNames.get(sessionId) || sdkSessions.find((s) => s.sessionId === sessionId)?.name || sessionId.slice(0, 8)
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-[16px] font-semibold text-cc-fg">Task Board</h1>
          <p className="text-[12px] text-cc-muted mt-0.5">
            {sessionName
              ? `Tasks from session: ${sessionName}`
              : "Tasks extracted from agent tool calls (TodoWrite, TaskCreate)"}
          </p>
        </div>

        {totalCount === 0 ? (
          <div className="text-center py-16 border border-dashed border-cc-border rounded-lg">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-8 h-8 mx-auto text-cc-muted/20 mb-3">
              <path d="M1.5 3.25a2.25 2.25 0 013-2.122V1A2.5 2.5 0 017 3.5H3.25a.75.75 0 010-1.5h3.06A1 1 0 005.5 1.5h-1a.75.75 0 01-.75-.75.75.75 0 00-1.5 0v.5h-.5a.25.25 0 00-.25.25zm13 0v.5a.25.25 0 01-.25.25H8V1h.75a.75.75 0 01.75.75.75.75 0 001.5 0h-1a1 1 0 00-.81.5h3.06a.75.75 0 010 1.5H9A2.5 2.5 0 0111.5 1v.128a2.25 2.25 0 013 2.122zM1.5 5v8.25c0 .966.784 1.75 1.75 1.75h9.5A1.75 1.75 0 0014.5 13.25V5h-13z" />
            </svg>
            <p className="text-[13px] text-cc-muted">No tasks yet</p>
            <p className="text-[11px] text-cc-muted/60 mt-1">
              Tasks appear here when agents use TodoWrite or TaskCreate tools
            </p>
          </div>
        ) : (
          <>
            {/* Summary stats */}
            <div className="flex items-center gap-4 text-[11px] font-mono-code">
              <span className="text-cc-muted">
                {grouped.completed.length}/{totalCount} complete
              </span>
              {grouped.in_progress.length > 0 && (
                <span className="text-cc-primary">
                  {grouped.in_progress.length} in progress
                </span>
              )}
              {/* Progress bar */}
              <div className="flex-1 h-1 rounded-full bg-cc-hover overflow-hidden max-w-[200px]">
                <div
                  className="h-full rounded-full bg-cc-success transition-all duration-500"
                  style={{ width: `${(grouped.completed.length / totalCount) * 100}%` }}
                />
              </div>
            </div>

            {/* Kanban columns */}
            <div className="flex gap-4 overflow-x-auto pb-4">
              <KanbanColumn column="pending" tasks={grouped.pending} />
              <KanbanColumn column="in_progress" tasks={grouped.in_progress} />
              <KanbanColumn column="completed" tasks={grouped.completed} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
