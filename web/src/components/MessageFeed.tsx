import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageBubble } from "./MessageBubble.js";
import { getToolIcon, getToolLabel, getPreview, ToolIcon } from "./ToolBlock.js";
import type { ChatMessage, ContentBlock } from "../types.js";

const FEED_PAGE_SIZE = 100;

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const EMPTY_MESSAGES: ChatMessage[] = [];

// ─── Message-level grouping ─────────────────────────────────────────────────

interface ToolItem { id: string; name: string; input: Record<string, unknown> }

interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
}

interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  children: FeedEntry[];
}

type FeedEntry =
  | { kind: "message"; msg: ChatMessage }
  | ToolMsgGroup
  | SubagentGroup;

/**
 * Get the dominant tool name if this message is "tool-only"
 * (assistant message whose contentBlocks are ALL tool_use of the same name).
 * Returns null if it has text/thinking or mixed tool types.
 */
function getToolOnlyName(msg: ChatMessage): string | null {
  if (msg.role !== "assistant") return null;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return null;

  let toolName: string | null = null;
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) return null;
    if (b.type === "thinking") return null;
    if (b.type === "tool_use") {
      if (toolName === null) toolName = b.name;
      else if (toolName !== b.name) return null;
    }
  }
  return toolName;
}

function extractToolItems(msg: ChatMessage): ToolItem[] {
  const blocks = msg.contentBlocks || [];
  return blocks
    .filter((b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .filter(b => b.name === "Task")
      .map(b => b.id);
  }
  if (entry.kind === "tool_msg_group" && entry.toolName === "Task") {
    return entry.items.map(item => item.id);
  }
  return [];
}

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const msg of messages) {
    const toolName = getToolOnlyName(msg);

    if (toolName) {
      const last = entries[entries.length - 1];
      if (last?.kind === "tool_msg_group" && last.toolName === toolName) {
        last.items.push(...extractToolItems(msg));
        continue;
      }
      entries.push({
        kind: "tool_msg_group",
        toolName,
        items: extractToolItems(msg),
        firstId: msg.id,
      });
    } else {
      entries.push({ kind: "message", msg });
    }
  }

  return entries;
}

/** Build feed entries with subagent nesting */
function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<string, { description: string; agentType: string }>,
  childrenByParent: Map<string, ChatMessage[]>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    result.push(entry);

    // After each entry containing Task tool_use(s), insert subagent groups
    const taskIds = getTaskIdsFromEntry(entry);
    for (const taskId of taskIds) {
      const children = childrenByParent.get(taskId);
      if (children && children.length > 0) {
        const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "" };
        const childEntries = buildEntries(children, taskInfo, childrenByParent);
        result.push({
          kind: "subagent",
          taskToolUseId: taskId,
          description: info.description,
          agentType: info.agentType,
          children: childEntries,
        });
      }
    }
  }

  return result;
}

function groupMessages(messages: ChatMessage[]): FeedEntry[] {
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<string, { description: string; agentType: string }>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && b.name === "Task") {
        const { input, id } = b;
        taskInfo.set(id, {
          description: String(input?.description || "Subagent"),
          agentType: String(input?.subagent_type || ""),
        });
      }
    }
  }

  // If no Task tool_uses found, skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages);
  }

  // Phase 2: Partition into top-level and child messages
  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.parentToolUseId && taskInfo.has(msg.parentToolUseId)) {
      let arr = childrenByParent.get(msg.parentToolUseId);
      if (!arr) { arr = []; childrenByParent.set(msg.parentToolUseId, arr); }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // Phase 3: Build grouped entries with subagent nesting
  return buildEntries(topLevel, taskInfo, childrenByParent);
}

// ─── Components ──────────────────────────────────────────────────────────────

function ToolMessageGroup({ group }: { group: ToolMsgGroup }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(group.toolName);
  const label = getToolLabel(group.toolName);
  const count = group.items.length;

  // Single item — render inline with log-tool accent
  if (count === 1) {
    const item = group.items[0];
    return (
      <div className="animate-[fadeSlideIn_0.15s_ease-out]">
        <div className="log-tool">
          <div className="rounded-md overflow-hidden bg-cc-hover/50">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-[11px] font-medium text-cc-fg font-mono-code">{label}</span>
              <span className="text-[11px] text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-2.5 pt-0 border-t border-cc-border/50 mt-0">
                <pre className="mt-1.5 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Multi-item group
  return (
    <div className="animate-[fadeSlideIn_0.15s_ease-out]">
      <div className="log-tool">
        <div className="rounded-md overflow-hidden bg-cc-hover/50">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={iconType} />
            <span className="text-[11px] font-medium text-cc-fg font-mono-code">{label}</span>
            <span className="text-[10px] text-cc-muted/60 font-mono-code tabular-nums">
              x{count}
            </span>
          </button>

          {open && (
            <div className="border-t border-cc-border/50 px-3 py-1.5">
              {group.items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div key={item.id || i} className="flex items-center gap-2 py-0.5 text-[11px] text-cc-muted font-mono-code truncate">
                    <span className="text-cc-muted/30 select-none">-</span>
                    <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FeedEntries({ entries, onForkAt }: { entries: FeedEntry[]; onForkAt?: (msgId: string) => void }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "tool_msg_group") {
          return <ToolMessageGroup key={entry.firstId || i} group={entry} />;
        }
        if (entry.kind === "subagent") {
          return <SubagentContainer key={entry.taskToolUseId} group={entry} />;
        }
        return (
          <MessageBubble
            key={entry.msg.id}
            message={entry.msg}
            onFork={onForkAt ? () => onForkAt(entry.msg.id) : undefined}
          />
        );
      })}
    </>
  );
}

function SubagentContainer({ group }: { group: SubagentGroup }) {
  const [open, setOpen] = useState(false);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const childCount = group.children.length;

  // Get the last visible entry for a compact preview
  const lastEntry = group.children[group.children.length - 1];
  const lastPreview = useMemo(() => {
    if (!lastEntry) return "";
    if (lastEntry.kind === "tool_msg_group") {
      return `${getToolLabel(lastEntry.toolName)}${lastEntry.items.length > 1 ? ` x${lastEntry.items.length}` : ""}`;
    }
    if (lastEntry.kind === "message" && lastEntry.msg.role === "assistant") {
      const text = lastEntry.msg.content?.trim();
      if (text) return text.length > 60 ? text.slice(0, 60) + "..." : text;
      const toolBlock = lastEntry.msg.contentBlocks?.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  return (
    <div className="animate-[fadeSlideIn_0.15s_ease-out]">
      <div className="ml-3 border-l border-cc-border pl-3">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center gap-2 py-1 text-left cursor-pointer mb-0.5"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`w-2.5 h-2.5 text-cc-muted/50 transition-transform shrink-0 ${open ? "rotate-90" : ""}`}>
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span className="text-[11px] font-medium text-cc-fg font-mono-code truncate">{label}</span>
          {agentType && (
            <span className="text-[9px] text-cc-muted/60 font-mono-code shrink-0">
              [{agentType}]
            </span>
          )}
          {!open && lastPreview && (
            <span className="text-[11px] text-cc-muted/50 truncate ml-1 font-mono-code">
              {lastPreview}
            </span>
          )}
          <span className="text-[10px] text-cc-muted/40 font-mono-code tabular-nums shrink-0 ml-auto">
            {childCount}
          </span>
        </button>

        {open && (
          <div className="space-y-2 pb-2">
            <FeedEntries entries={group.children} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Feed ───────────────────────────────────────────────────────────────

export function MessageFeed({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const [elapsed, setElapsed] = useState(0);
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE_SIZE);

  const replaySessionId = useStore((s) => s.replaySessionId);
  const isReplay = sessionId === replaySessionId;
  const cwd = useStore((s) => s.sessions.get(sessionId)?.cwd);

  const handleForkAt = useCallback(async (msgId: string) => {
    if (isReplay || !cwd) return;
    // Find the message index in the full messages array
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    try {
      const result = await api.forkSession(sessionId, { messageIndex: idx + 1 });
      if (result.sessionId) {
        useStore.getState().setCurrentSession(result.sessionId);
        const { connectSession } = await import("../ws.js");
        connectSession(result.sessionId);
        const list = await api.listSessions();
        useStore.getState().setSdkSessions(list);
      }
    } catch (err) {
      console.error("[MessageFeed] Fork failed:", err);
    }
  }, [sessionId, messages, isReplay, cwd]);

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // Reset visible count when switching sessions
  useEffect(() => {
    setVisibleCount(FEED_PAGE_SIZE);
  }, [sessionId]);

  const totalEntries = grouped.length;
  const hasMore = totalEntries > visibleCount;
  const visibleEntries = hasMore ? grouped.slice(totalEntries - visibleCount) : grouped;
  const hiddenCount = totalEntries - visibleEntries.length;

  const handleLoadMore = useCallback(() => {
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setVisibleCount((c) => c + FEED_PAGE_SIZE);
    // Preserve scroll position after DOM updates
    requestAnimationFrame(() => {
      if (el) {
        const newHeight = el.scrollHeight;
        el.scrollTop += newHeight - prevHeight;
      }
    });
  }, []);

  // Tick elapsed time every second while generating
  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    setElapsed(Date.now() - start);
    const interval = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, streamingText]);

  if (messages.length === 0 && !streamingText) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 select-none px-6">
        <div className="text-cc-muted/30 font-mono-code text-[11px] uppercase tracking-[0.2em]">
          awaiting input
        </div>
        <div className="w-8 h-px bg-cc-border" />
        <p className="text-[12px] text-cc-muted/50 font-mono-code">
          type below to begin
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto scroll-smooth px-4 sm:px-6 py-4"
      >
        <div className="max-w-4xl mx-auto space-y-2">
          {hasMore && (
            <div className="flex justify-center pb-2">
              <button
                onClick={handleLoadMore}
                className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono-code text-cc-muted hover:text-cc-fg bg-cc-hover rounded-md hover:bg-cc-active transition-colors cursor-pointer"
              >
                + {Math.min(FEED_PAGE_SIZE, hiddenCount)} more ({hiddenCount} hidden)
              </button>
            </div>
          )}
          <FeedEntries entries={visibleEntries} onForkAt={!isReplay && cwd ? handleForkAt : undefined} />

          {/* Tool progress indicator */}
          {toolProgress && toolProgress.size > 0 && !streamingText && (
            <div className="flex items-center gap-2 text-[11px] text-cc-muted font-mono-code pl-3">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-primary/60 animate-breathing" />
              {Array.from(toolProgress.values()).map((p, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-cc-muted/20">|</span>}
                  <span>{getToolLabel(p.toolName)}</span>
                  <span className="text-cc-muted/40 tabular-nums">{p.elapsedSeconds}s</span>
                </span>
              ))}
            </div>
          )}

          {/* Streaming indicator */}
          {streamingText && (
            <div className="animate-[fadeSlideIn_0.1s_ease-out]">
              <div className="log-accent">
                <pre className="font-sans-ui text-[13px] text-cc-fg whitespace-pre-wrap break-words leading-[1.7]">
                  {streamingText}
                  <span className="inline-block w-[2px] h-[13px] bg-cc-primary rounded-sm ml-0.5 align-middle animate-[cursor-blink_1s_step-end_infinite]" />
                </pre>
              </div>
            </div>
          )}

          {/* Generation stats bar */}
          {sessionStatus === "running" && elapsed > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-cc-muted/50 font-mono-code pl-3">
              <span className="inline-block w-1 h-1 rounded-full bg-cc-primary/50 animate-breathing" />
              <span className="tabular-nums">{formatElapsed(elapsed)}</span>
              {(streamingOutputTokens ?? 0) > 0 && (
                <>
                  <span className="text-cc-muted/20">|</span>
                  <span className="tabular-nums">{formatTokens(streamingOutputTokens!)}tok</span>
                </>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
