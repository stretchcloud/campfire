import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { MessageFeed } from "./MessageFeed.js";
import type { ChatMessage, ContentBlock } from "../types.js";

interface Props {
  token: string;
}

interface PublicReplayData {
  messages: ChatMessage[];
  gallery: {
    name?: string;
    description?: string;
    backendType?: string;
    model?: string;
    totalCostUsd?: number;
    durationMs?: number;
    numTurns?: number;
    tags?: string[];
  } | null;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// ─── Message Conversion ──────────────────────────────────────────────────────

let idCounter = 0;
function nextId(): string {
  return `public-replay-${++idCounter}`;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

/**
 * Convert a raw BrowserIncomingMessage to a ChatMessage.
 * Same logic as SessionReplay's convertToChat / ws.ts message_history handler.
 */
function convertToChat(msg: any, index: number): ChatMessage | null {
  if (msg.type === "user_message") {
    return {
      id: msg.id || nextId(),
      role: "user",
      content: msg.content || "",
      timestamp: msg.timestamp || 0,
    };
  }
  if (msg.type === "assistant") {
    const m = msg.message;
    if (!m) return null;
    return {
      id: m.id || nextId(),
      role: "assistant",
      content: extractTextFromBlocks(m.content || []),
      contentBlocks: m.content,
      timestamp: msg.timestamp || 0,
      parentToolUseId: msg.parent_tool_use_id,
      model: m.model,
      stopReason: m.stop_reason,
    };
  }
  if (msg.type === "result") {
    const r = msg.data;
    if (r?.is_error && r.errors?.length) {
      return {
        id: `replay-error-${index}`,
        role: "system",
        content: `Error: ${r.errors.join(", ")}`,
        timestamp: 0,
      };
    }
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PublicReplayPage({ token }: Props) {
  const [data, setData] = useState<PublicReplayData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Use a temporary session ID for the store
  const sessionId = `public-replay-${token}`;
  const setMessages = useStore((s) => s.setMessages);

  useEffect(() => {
    api.getPublicReplay(token)
      .then((result) => {
        // Convert raw BrowserIncomingMessages to ChatMessages
        const rawMessages = result.messages as any[];
        const converted = rawMessages
          .map((msg, i) => convertToChat(msg, i))
          .filter((m): m is ChatMessage => m !== null);
        setData({
          messages: converted,
          gallery: result.gallery as PublicReplayData["gallery"],
        });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [token]);

  // Progressive replay: feed messages into the store
  useEffect(() => {
    if (!data) return;
    const sliced = data.messages.slice(0, replayIndex);
    setMessages(sessionId, sliced);
  }, [data, replayIndex, sessionId, setMessages]);

  // Auto-play timer
  useEffect(() => {
    if (!playing || !data) return;
    timerRef.current = setInterval(() => {
      setReplayIndex((i) => {
        if (i >= data.messages.length) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 300 / speed);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, speed, data]);

  const handlePlayPause = useCallback(() => {
    if (!data) return;
    if (replayIndex >= data.messages.length) {
      setReplayIndex(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  }, [data, replayIndex]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full bg-cc-bg flex items-center justify-center">
        <span className="text-sm text-cc-muted">Loading replay...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full bg-cc-bg flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-cc-error">{error}</p>
          <p className="text-xs text-cc-muted mt-2">This replay link may have expired or is invalid.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const gallery = data.gallery;
  const progress = data.messages.length > 0 ? (replayIndex / data.messages.length) * 100 : 0;

  return (
    <div className="h-full bg-cc-bg flex flex-col">
      {/* Header bar with gallery metadata */}
      <div className="border-b border-cc-border bg-cc-card px-4 py-3">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-cc-fg">
              {gallery?.name || "Session Replay"}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-cc-primary/10 text-cc-primary font-medium">
              Public Replay
            </span>
          </div>
          {gallery && (
            <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-cc-muted">
              {gallery.backendType && (
                <span className="font-medium px-1.5 rounded-full bg-cc-hover">{gallery.backendType}</span>
              )}
              {gallery.model && <span>{gallery.model}</span>}
              {gallery.totalCostUsd != null && gallery.totalCostUsd > 0 && (
                <span>{formatCost(gallery.totalCostUsd)}</span>
              )}
              {gallery.numTurns != null && gallery.numTurns > 0 && (
                <span>{gallery.numTurns} turns</span>
              )}
              {gallery.durationMs != null && gallery.durationMs > 0 && (
                <span>{formatDuration(gallery.durationMs)}</span>
              )}
              {gallery.tags && gallery.tags.length > 0 && (
                <span>{gallery.tags.join(", ")}</span>
              )}
            </div>
          )}
          {gallery?.description && (
            <p className="text-xs text-cc-muted mt-1">{gallery.description}</p>
          )}
        </div>
      </div>

      {/* Replay controls */}
      <div className="border-b border-cc-border bg-cc-card px-4 py-2">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <button
            onClick={handlePlayPause}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
          >
            {playing ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M5.5 3.5A1.5 1.5 0 017 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5zm5 0A1.5 1.5 0 0112 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M4.5 3.5A.5.5 0 015.22 3l7 4.5a.5.5 0 010 .86l-7 4.5A.5.5 0 014.5 12.5v-9z" />
              </svg>
            )}
          </button>

          {/* Progress bar */}
          <div className="flex-1 h-1.5 bg-cc-hover rounded-full overflow-hidden cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              setReplayIndex(Math.round(pct * data.messages.length));
            }}
          >
            <div
              className="h-full bg-cc-primary rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>

          <span className="text-[10px] text-cc-muted tabular-nums">
            {replayIndex}/{data.messages.length}
          </span>

          {/* Speed control */}
          <button
            onClick={() => setSpeed((s) => (s >= 8 ? 1 : s * 2))}
            className="px-2 py-1 text-[10px] font-medium bg-cc-hover rounded text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
          >
            {speed}x
          </button>
        </div>
      </div>

      {/* Message feed */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <MessageFeed sessionId={sessionId} />
      </div>
    </div>
  );
}
