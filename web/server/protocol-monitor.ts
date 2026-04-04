/**
 * Protocol Monitor — real-time message tracking and health metrics.
 *
 * Tracks message counts, rates, errors, and protocol drift across
 * all sessions and backends. Provides a rolling 5-minute window
 * of statistics for the dashboard.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageEvent {
  sessionId: string;
  backendType: string;
  direction: "in" | "out";
  channel: "cli" | "browser";
  messageType: string;
  timestamp: number;
}

export interface DriftEvent {
  sessionId: string;
  backendType: string;
  direction: "in" | "out";
  messageType: string;
  details: string;
  timestamp: number;
}

export interface SessionStats {
  sessionId: string;
  backendType: string;
  messageCount: number;
  errorCount: number;
  messagesPerMinute: number;
  lastMessageAt: number;
  messageTypes: Record<string, number>;
}

export interface MonitorSnapshot {
  uptime: number;
  totalMessages: number;
  totalErrors: number;
  globalMessagesPerMinute: number;
  activeSessions: number;
  sessionStats: SessionStats[];
  recentDrifts: DriftEvent[];
  messageTypeGlobal: Record<string, number>;
  backendBreakdown: Record<string, { messages: number; errors: number }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const MAX_DRIFTS = 50;
const MAX_EVENTS_PER_SESSION = 500;

// ─── Monitor ────────────────────────────────────────────────────────────────

export class ProtocolMonitor {
  private readonly startedAt = Date.now();
  private readonly sessionEvents = new Map<string, MessageEvent[]>();
  private readonly sessionBackends = new Map<string, string>();
  private readonly drifts: DriftEvent[] = [];
  private readonly driftSeen = new Set<string>();
  private totalMessages = 0;
  private totalErrors = 0;

  /** Record a message passing through the bridge. */
  recordMessage(
    sessionId: string,
    direction: "in" | "out",
    channel: "cli" | "browser",
    messageType: string,
    backendType?: string,
  ): void {
    const now = Date.now();
    this.totalMessages++;

    if (backendType) {
      this.sessionBackends.set(sessionId, backendType);
    }

    const event: MessageEvent = {
      sessionId,
      backendType: backendType || this.sessionBackends.get(sessionId) || "unknown",
      direction,
      channel,
      messageType,
      timestamp: now,
    };

    let events = this.sessionEvents.get(sessionId);
    if (!events) {
      events = [];
      this.sessionEvents.set(sessionId, events);
    }
    events.push(event);

    // Cap per-session events to prevent memory bloat
    if (events.length > MAX_EVENTS_PER_SESSION) {
      events.splice(0, events.length - MAX_EVENTS_PER_SESSION);
    }

    // Track errors
    if (messageType === "error" || messageType === "parse_error") {
      this.totalErrors++;
    }
  }

  /** Report a protocol drift (unexpected message format). */
  reportDrift(
    sessionId: string,
    backendType: string,
    direction: "in" | "out",
    messageType: string,
    details: string,
  ): void {
    const key = `${backendType}:${direction}:${messageType}`;
    if (this.driftSeen.has(key)) return;
    this.driftSeen.add(key);

    const drift: DriftEvent = {
      sessionId,
      backendType,
      direction,
      messageType,
      details,
      timestamp: Date.now(),
    };

    this.drifts.push(drift);
    if (this.drifts.length > MAX_DRIFTS) {
      this.drifts.shift();
    }

    console.warn(`[protocol-monitor] Drift detected: ${backendType} ${direction} ${messageType} — ${details}`);
  }

  /** Get a snapshot of current metrics. */
  getSnapshot(): MonitorSnapshot {
    const now = Date.now();
    const windowStart = now - WINDOW_MS;

    const sessionStats: SessionStats[] = [];
    const messageTypeGlobal: Record<string, number> = {};
    const backendBreakdown: Record<string, { messages: number; errors: number }> = {};
    let windowMessages = 0;
    let activeSessions = 0;

    for (const [sessionId, events] of this.sessionEvents) {
      const recentEvents = events.filter((e) => e.timestamp >= windowStart);
      if (recentEvents.length === 0) continue;

      activeSessions++;
      const bt = this.sessionBackends.get(sessionId) || "unknown";
      const typeCount: Record<string, number> = {};
      let errors = 0;

      for (const e of recentEvents) {
        typeCount[e.messageType] = (typeCount[e.messageType] || 0) + 1;
        messageTypeGlobal[e.messageType] = (messageTypeGlobal[e.messageType] || 0) + 1;
        if (e.messageType === "error" || e.messageType === "parse_error") errors++;
      }

      windowMessages += recentEvents.length;

      if (!backendBreakdown[bt]) backendBreakdown[bt] = { messages: 0, errors: 0 };
      backendBreakdown[bt].messages += recentEvents.length;
      backendBreakdown[bt].errors += errors;

      const elapsed = Math.max(1, (now - recentEvents[0].timestamp) / 60_000);
      sessionStats.push({
        sessionId,
        backendType: bt,
        messageCount: recentEvents.length,
        errorCount: errors,
        messagesPerMinute: Math.round(recentEvents.length / elapsed),
        lastMessageAt: recentEvents.at(-1)?.timestamp ?? now,
        messageTypes: typeCount,
      });
    }

    sessionStats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

    return {
      uptime: now - this.startedAt,
      totalMessages: this.totalMessages,
      totalErrors: this.totalErrors,
      globalMessagesPerMinute: WINDOW_MS > 0 ? Math.round((windowMessages / WINDOW_MS) * 60_000) : 0,
      activeSessions,
      sessionStats,
      recentDrifts: [...this.drifts].reverse(),
      messageTypeGlobal,
      backendBreakdown,
    };
  }
}
