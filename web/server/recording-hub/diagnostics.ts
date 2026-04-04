/**
 * Recording diagnostics — analyzes session recordings for health issues.
 *
 * Goes beyond companion's disconnection-only analysis to include:
 * - Disconnection patterns and data gaps
 * - Message rate anomalies
 * - Permission response time analysis
 * - Cost tracking per turn
 */

import type { Recording } from "../replay.js";
import type { RecordingEntry } from "../recorder.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  ts: number;
  event: string;
  channel: "cli" | "browser";
  detail?: string;
}

export interface DataGap {
  startTs: number;
  endTs: number;
  gapMs: number;
  channel: "cli" | "browser";
  messagesBefore: number;
  messagesAfter: number;
}

export interface DisconnectionEvent {
  ts: number;
  channel: "cli" | "browser";
  gapMs: number;
  messagesLostEstimate: number;
}

export interface PermissionTiming {
  requestTs: number;
  responseTs: number | null;
  responseTimeMs: number | null;
  toolName: string;
}

export interface DiagnosticsReport {
  sessionId: string;
  backendType: string;
  totalDuration: number;
  totalMessages: number;
  messageRate: number;
  disconnections: DisconnectionEvent[];
  dataGaps: DataGap[];
  patterns: string[];
  permissionTimings: PermissionTiming[];
  avgPermissionResponseMs: number | null;
  messageTypeDistribution: Record<string, number>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CLI_GAP_THRESHOLD_MS = 30_000;
const BROWSER_GAP_THRESHOLD_MS = 15_000;

// ─── Diagnostics ────────────────────────────────────────────────────────────

export function analyzeRecording(recording: Recording): DiagnosticsReport {
  const entries = recording.entries;
  if (entries.length === 0) {
    return emptyReport(recording);
  }

  const firstTs = entries[0].ts;
  const lastTs = entries[entries.length - 1].ts;
  const totalDuration = lastTs - firstTs;

  // Message type distribution
  const typeDistribution: Record<string, number> = {};
  for (const entry of entries) {
    const parsed = safeParse(entry);
    const msgType = parsed?.type as string || entry.ch;
    typeDistribution[msgType] = (typeDistribution[msgType] || 0) + 1;
  }

  // Data gaps per channel
  const dataGaps = findDataGaps(entries);

  // Disconnection events
  const disconnections = findDisconnections(entries);

  // Permission timing analysis
  const permissionTimings = analyzePermissions(entries);

  // Patterns
  const patterns = detectPatterns(disconnections, dataGaps, entries);

  // Average permission response time
  const responded = permissionTimings.filter((p) => p.responseTimeMs !== null);
  const avgPermissionResponseMs = responded.length > 0
    ? Math.round(responded.reduce((sum, p) => sum + (p.responseTimeMs || 0), 0) / responded.length)
    : null;

  return {
    sessionId: recording.header.session_id,
    backendType: recording.header.backend_type || "unknown",
    totalDuration,
    totalMessages: entries.length,
    messageRate: totalDuration > 0 ? Math.round((entries.length / totalDuration) * 60_000) : 0,
    disconnections,
    dataGaps,
    patterns,
    permissionTimings,
    avgPermissionResponseMs,
    messageTypeDistribution: typeDistribution,
  };
}

export function buildTimeline(recording: Recording): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const entry of recording.entries) {
    const parsed = safeParse(entry);
    const msgType = parsed?.type as string || "data";
    events.push({
      ts: entry.ts,
      event: msgType,
      channel: entry.ch,
      detail: entry.dir,
    });
  }
  return events;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findDataGaps(entries: RecordingEntry[]): DataGap[] {
  const gaps: DataGap[] = [];
  const byChannel = new Map<string, RecordingEntry[]>();

  for (const e of entries) {
    const list = byChannel.get(e.ch) || [];
    list.push(e);
    byChannel.set(e.ch, list);
  }

  for (const [ch, channelEntries] of byChannel) {
    const threshold = ch === "cli" ? CLI_GAP_THRESHOLD_MS : BROWSER_GAP_THRESHOLD_MS;
    for (let i = 1; i < channelEntries.length; i++) {
      const gapMs = channelEntries[i].ts - channelEntries[i - 1].ts;
      if (gapMs > threshold) {
        gaps.push({
          startTs: channelEntries[i - 1].ts,
          endTs: channelEntries[i].ts,
          gapMs,
          channel: ch as "cli" | "browser",
          messagesBefore: i,
          messagesAfter: channelEntries.length - i,
        });
      }
    }
  }

  return gaps.sort((a, b) => a.startTs - b.startTs);
}

function findDisconnections(entries: RecordingEntry[]): DisconnectionEvent[] {
  const disconnections: DisconnectionEvent[] = [];

  for (const entry of entries) {
    const parsed = safeParse(entry);
    if (!parsed) continue;
    const msgType = parsed.type as string;
    if (msgType === "cli_disconnected" || msgType === "cli_connected") {
      if (msgType === "cli_disconnected") {
        disconnections.push({
          ts: entry.ts,
          channel: entry.ch,
          gapMs: 0,
          messagesLostEstimate: 0,
        });
      }
    }
  }

  return disconnections;
}

function analyzePermissions(entries: RecordingEntry[]): PermissionTiming[] {
  const pending = new Map<string, { ts: number; toolName: string }>();
  const timings: PermissionTiming[] = [];

  for (const entry of entries) {
    const parsed = safeParse(entry);
    if (!parsed) continue;
    const msgType = parsed.type as string;

    if (msgType === "permission_request") {
      const req = parsed.request as Record<string, unknown> | undefined;
      const requestId = req?.request_id as string || parsed.request_id as string;
      const toolName = req?.tool_name as string || "unknown";
      if (requestId) pending.set(requestId, { ts: entry.ts, toolName });
    }

    if (msgType === "permission_response" || msgType === "permission_cancelled") {
      const requestId = parsed.request_id as string;
      const req = pending.get(requestId);
      if (req) {
        timings.push({
          requestTs: req.ts,
          responseTs: entry.ts,
          responseTimeMs: entry.ts - req.ts,
          toolName: req.toolName,
        });
        pending.delete(requestId);
      }
    }
  }

  // Add unresolved permissions
  for (const [, req] of pending) {
    timings.push({
      requestTs: req.ts,
      responseTs: null,
      responseTimeMs: null,
      toolName: req.toolName,
    });
  }

  return timings;
}

function detectPatterns(
  disconnections: DisconnectionEvent[],
  gaps: DataGap[],
  entries: RecordingEntry[],
): string[] {
  const patterns: string[] = [];

  if (disconnections.length >= 3) {
    patterns.push(`Frequent disconnections: ${disconnections.length} events detected`);
  }

  const cliGaps = gaps.filter((g) => g.channel === "cli");
  if (cliGaps.length >= 2) {
    patterns.push(`CLI data gaps: ${cliGaps.length} periods with no CLI messages (>${CLI_GAP_THRESHOLD_MS / 1000}s each)`);
  }

  const browserGaps = gaps.filter((g) => g.channel === "browser");
  if (browserGaps.length >= 2) {
    patterns.push(`Browser data gaps: ${browserGaps.length} periods with no browser messages`);
  }

  if (entries.length > 0) {
    const duration = (entries.at(-1)?.ts ?? 0) - entries[0].ts;
    if (duration > 0 && entries.length / duration < 0.001) {
      patterns.push("Very low message rate — possible idle or stalled session");
    }
  }

  if (patterns.length === 0) {
    patterns.push("No anomalies detected");
  }

  return patterns;
}

function emptyReport(recording: Recording): DiagnosticsReport {
  return {
    sessionId: recording.header.session_id,
    backendType: recording.header.backend_type || "unknown",
    totalDuration: 0,
    totalMessages: 0,
    messageRate: 0,
    disconnections: [],
    dataGaps: [],
    patterns: ["Empty recording"],
    permissionTimings: [],
    avgPermissionResponseMs: null,
    messageTypeDistribution: {},
  };
}

function safeParse(entry: RecordingEntry): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(entry.raw);
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}
