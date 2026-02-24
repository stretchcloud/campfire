import { useEffect, useRef, useCallback, useState } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageFeed } from "./MessageFeed.js";
import type { ChatMessage, ContentBlock } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionReplayProps {
  filename?: string;
  sessionId?: string;
}

interface RecordingHeader {
  session_id: string;
  backend_type: string;
  started_at: number;
  cwd: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(): string {
  return `replay-${++idCounter}`;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

/**
 * Convert a raw BrowserIncomingMessage to a ChatMessage (same logic as ws.ts message_history handler).
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

// ─── Speed Options ──────────────────────────────────────────────────────────

const SPEEDS = [1, 2, 4, 8];

// ─── Component ──────────────────────────────────────────────────────────────

export function SessionReplay({ filename, sessionId }: SessionReplayProps) {
  const replaySpeed = useStore((s) => s.replaySpeed);
  const replayState = useStore((s) => s.replayState);
  const replaySessionId = useStore((s) => s.replaySessionId);
  const setReplaySpeed = useStore((s) => s.setReplaySpeed);
  const setReplayState = useStore((s) => s.setReplayState);
  const setReplaySessionId = useStore((s) => s.setReplaySessionId);
  const setMessages = useStore((s) => s.setMessages);

  // All converted ChatMessages from the recording/history
  const allMessages = useRef<ChatMessage[]>([]);
  // Timestamps for pacing (only from recordings)
  const timestamps = useRef<number[]>([]);
  // Current position in the message array
  const position = useRef(0);
  // Interval handle
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Loading state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // Header info
  const [header, setHeader] = useState<RecordingHeader | null>(null);
  // Total message count (for timeline)
  const [totalMessages, setTotalMessages] = useState(0);
  // Current position for UI (re-rendered on each tick)
  const [currentPosition, setCurrentPosition] = useState(0);

  // Create a stable replay session ID on mount
  useEffect(() => {
    const rid = `replay-${Math.random().toString(36).slice(2, 10)}`;
    setReplaySessionId(rid);
    setMessages(rid, []);
    setReplayState("idle");

    return () => {
      // Cleanup: remove replay session from store
      setReplaySessionId(null);
      setReplayState("idle");
      setMessages(rid, []);
    };
  }, [setReplaySessionId, setMessages, setReplayState]);

  // Load data on mount
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        if (filename) {
          const data = await api.getRecording(filename);
          if (cancelled) return;
          setHeader(data.header as unknown as RecordingHeader);
          timestamps.current = data.timestamps;

          // Convert all messages to ChatMessages
          const chatMsgs: ChatMessage[] = [];
          for (let i = 0; i < data.messages.length; i++) {
            const cm = convertToChat(data.messages[i], i);
            if (cm) chatMsgs.push(cm);
          }
          allMessages.current = chatMsgs;
          setTotalMessages(chatMsgs.length);
        } else if (sessionId) {
          const data = await api.getSessionHistory(sessionId);
          if (cancelled) return;
          if (data.state) {
            setHeader({
              session_id: sessionId,
              backend_type: (data.state as any).backend_type || "unknown",
              started_at: (data.state as any).started_at || Date.now(),
              cwd: (data.state as any).cwd || "",
            });
          }

          const chatMsgs: ChatMessage[] = [];
          for (let i = 0; i < data.messages.length; i++) {
            const cm = convertToChat(data.messages[i], i);
            if (cm) chatMsgs.push(cm);
          }
          allMessages.current = chatMsgs;
          setTotalMessages(chatMsgs.length);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load replay data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    return () => { cancelled = true; };
  }, [filename, sessionId]);

  // Stop timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Compute delay between messages based on timestamps and speed
  const getDelay = useCallback((idx: number): number => {
    const ts = timestamps.current;
    if (ts.length > 1 && idx > 0 && idx < ts.length) {
      const delta = ts[idx] - ts[idx - 1];
      // Cap individual delays to 3 seconds (before speed)
      return Math.min(delta, 3000) / replaySpeed;
    }
    // Fallback: fixed 300ms divided by speed
    return 300 / replaySpeed;
  }, [replaySpeed]);

  // Advance one message
  const tick = useCallback(() => {
    if (!replaySessionId) return;
    const pos = position.current;
    if (pos >= allMessages.current.length) {
      setReplayState("ended");
      return;
    }

    // Push the next message into the store
    const msgs = allMessages.current.slice(0, pos + 1);
    setMessages(replaySessionId, msgs);
    position.current = pos + 1;
    setCurrentPosition(pos + 1);

    // Schedule next tick
    if (pos + 1 < allMessages.current.length) {
      timerRef.current = setTimeout(tick, getDelay(pos + 1));
    } else {
      setReplayState("ended");
    }
  }, [replaySessionId, setMessages, setReplayState, getDelay]);

  // Play
  const play = useCallback(() => {
    if (!replaySessionId || allMessages.current.length === 0) return;
    setReplayState("playing");
    // If ended, restart
    if (position.current >= allMessages.current.length) {
      position.current = 0;
      setCurrentPosition(0);
      setMessages(replaySessionId, []);
    }
    timerRef.current = setTimeout(tick, getDelay(position.current));
  }, [replaySessionId, setReplayState, setMessages, tick, getDelay]);

  // Pause
  const pause = useCallback(() => {
    setReplayState("paused");
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [setReplayState]);

  // Reset
  const reset = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setReplayState("idle");
    position.current = 0;
    setCurrentPosition(0);
    if (replaySessionId) setMessages(replaySessionId, []);
  }, [setReplayState, setMessages, replaySessionId]);

  // Scrub to position
  const scrubTo = useCallback((pos: number) => {
    if (!replaySessionId) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const clamped = Math.max(0, Math.min(pos, allMessages.current.length));
    position.current = clamped;
    setCurrentPosition(clamped);
    setMessages(replaySessionId, allMessages.current.slice(0, clamped));
    if (clamped >= allMessages.current.length) {
      setReplayState("ended");
    } else if (replayState === "playing") {
      // Continue playing from new position
      timerRef.current = setTimeout(tick, getDelay(clamped));
    } else {
      setReplayState("paused");
    }
  }, [replaySessionId, setMessages, setReplayState, replayState, tick, getDelay]);

  // When speed changes during playback, restart the timer
  useEffect(() => {
    if (replayState === "playing" && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(tick, getDelay(position.current));
    }
  }, [replaySpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Share: copy link
  const shareLink = useCallback(() => {
    const path = filename ? `#/replay/${filename}` : `#/replay/session/${sessionId}`;
    const url = `${window.location.origin}/${path}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }, [filename, sessionId]);

  // Close: navigate back
  const close = useCallback(() => {
    window.location.hash = "";
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-cc-text-secondary">
        <div className="flex items-center gap-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
            <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" />
          </svg>
          Loading replay...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-cc-text-secondary">
        <p className="text-red-400">Failed to load replay: {error}</p>
        <button onClick={close} className="px-4 py-2 bg-cc-border rounded hover:bg-cc-hover transition-colors">
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-cc-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-cc-border bg-cc-card">
        <div className="flex items-center gap-3 text-sm text-cc-muted">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium text-cc-fg">Session Replay</span>
          {header && (
            <>
              <span className="text-xs px-2 py-0.5 rounded bg-cc-hover text-cc-muted">
                {header.backend_type}
              </span>
              <span className="text-xs">{header.session_id.slice(0, 8)}...</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={shareLink}
            className={`p-1.5 rounded hover:bg-cc-hover transition-colors ${shareCopied ? "text-cc-success" : "text-cc-muted"}`}
            title={shareCopied ? "Copied!" : "Copy replay link"}
          >
            {shareCopied ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            )}
          </button>
          <button
            onClick={close}
            className="p-1.5 rounded hover:bg-cc-hover transition-colors text-cc-muted"
            title="Close replay"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Replay controls */}
      <div className="border-b border-cc-border bg-cc-card px-4 py-2">
        <div className="flex items-center gap-3">
          {/* Play/Pause */}
          <button
            onClick={replayState === "playing" ? pause : play}
            className="w-8 h-8 flex items-center justify-center rounded-lg bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
            title={replayState === "playing" ? "Pause" : "Play"}
          >
            {replayState === "playing" ? (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M5.5 3.5A1.5 1.5 0 017 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5zm5 0A1.5 1.5 0 0112 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M4.5 3.5A.5.5 0 015.22 3l7 4.5a.5.5 0 010 .86l-7 4.5A.5.5 0 014.5 12.5v-9z" />
              </svg>
            )}
          </button>

          {/* Reset */}
          <button
            onClick={reset}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            title="Reset"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          {/* Progress bar */}
          <div className="flex-1 h-1.5 bg-cc-hover rounded-full overflow-hidden cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              scrubTo(Math.round(pct * totalMessages));
            }}
          >
            <div
              className="h-full bg-cc-primary rounded-full transition-all"
              style={{ width: `${totalMessages > 0 ? (currentPosition / totalMessages) * 100 : 0}%` }}
            />
          </div>

          <span className="text-[10px] text-cc-muted tabular-nums">
            {currentPosition}/{totalMessages}
          </span>

          {/* Speed selector */}
          <div className="flex items-center gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setReplaySpeed(s)}
                className={`px-2 py-1 text-[10px] font-medium rounded transition-colors cursor-pointer ${
                  replaySpeed === s
                    ? "bg-cc-primary text-white"
                    : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>

          {/* State badge */}
          <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${
            replayState === "playing" ? "bg-green-500/20 text-green-400" :
            replayState === "paused" ? "bg-yellow-500/20 text-yellow-400" :
            replayState === "ended" ? "bg-cc-hover text-cc-muted" :
            "bg-cc-hover text-cc-muted"
          }`}>
            {replayState === "playing" ? "Playing" :
             replayState === "paused" ? "Paused" :
             replayState === "ended" ? "Ended" :
             "Ready"}
          </span>
        </div>
      </div>

      {/* MessageFeed (reuses existing component) */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {replaySessionId && <MessageFeed sessionId={replaySessionId} />}
      </div>
    </div>
  );
}
