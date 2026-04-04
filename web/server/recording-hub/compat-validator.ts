/**
 * Protocol compatibility validator for session recordings.
 *
 * Analyzes recorded messages to detect protocol drift — catches when
 * backend CLIs change their message format between versions.
 * Supports ALL 7 backends (not just Claude/Codex like companion).
 */

import type { Recording } from "../replay.js";
import type { RecordingEntry } from "../recorder.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProtocolDiff {
  entryIndex: number;
  messageType: string;
  kind: "missing_field" | "extra_field" | "type_mismatch" | "unexpected_type";
  field?: string;
  details: string;
}

export interface ValidationResult {
  compatible: boolean;
  backendType: string;
  totalMessages: number;
  checkedMessages: number;
  diffs: ProtocolDiff[];
  messageTypeBreakdown: Record<string, { count: number; issues: number }>;
}

// ─── Ignored Fields (timestamps, IDs, costs — vary per session) ─────────────

const IGNORED_FIELDS = new Set([
  "ts", "timestamp", "created_at", "updated_at", "session_id",
  "uuid", "id", "request_id", "client_msg_id",
  "duration_ms", "duration_api_ms", "cost_usd", "total_cost_usd",
  "api_tokens", "input_tokens", "output_tokens",
  "cache_read_input_tokens", "cache_creation_input_tokens",
  "seq", "last_seq",
]);

// ─── Expected Shapes per Message Type ───────────────────────────────────────

// Required fields for known message types (applies to all backends)
const REQUIRED_FIELDS: Record<string, string[]> = {
  session_init: ["session"],
  assistant: ["message"],
  result: ["data"],
  stream_event: ["event"],
  permission_request: ["request"],
  permission_cancelled: ["request_id"],
  status_change: ["status"],
  cli_connected: [],
  cli_disconnected: [],
  error: ["message"],
  tool_progress: ["tool_use_id", "tool_name"],
  presence_update: ["viewers"],
  role_assigned: ["role", "viewerId"],
  vote_update: ["request_id", "votes"],
  vote_resolved: ["request_id", "result"],
  mcp_status: ["servers"],
  session_name_update: ["name"],
  pr_status_update: ["available"],
};

// ─── Validator ──────────────────────────────────────────────────────────────

function validateEntry(
  entry: RecordingEntry, index: number,
  diffs: ProtocolDiff[], breakdown: Record<string, { count: number; issues: number }>,
): void {
  if (entry.dir !== "out" || entry.ch !== "browser") return;
  const parsed = safeParse(entry);
  if (!parsed) return;

  const msgType = typeof parsed.type === "string" ? parsed.type : "unknown";
  if (!breakdown[msgType]) breakdown[msgType] = { count: 0, issues: 0 };
  breakdown[msgType].count++;

  const required = REQUIRED_FIELDS[msgType];
  if (!required) {
    diffs.push({ entryIndex: index, messageType: msgType, kind: "unexpected_type", details: `Unknown message type: ${msgType}` });
    breakdown[msgType].issues++;
    return;
  }

  for (const field of required) {
    if (!(field in parsed)) {
      diffs.push({ entryIndex: index, messageType: msgType, kind: "missing_field", field, details: `Required field "${field}" missing from ${msgType}` });
      breakdown[msgType].issues++;
    }
  }
}

export function validateRecording(recording: Recording): ValidationResult {
  const breakdown: Record<string, { count: number; issues: number }> = {};
  const diffs: ProtocolDiff[] = [];

  for (let i = 0; i < recording.entries.length; i++) {
    validateEntry(recording.entries[i], i, diffs, breakdown);
  }

  const checked = Object.values(breakdown).reduce((sum, b) => sum + b.count, 0);

  return {
    compatible: diffs.length === 0,
    backendType: recording.header.backend_type || "unknown",
    totalMessages: recording.entries.length,
    checkedMessages: checked,
    diffs,
    messageTypeBreakdown: breakdown,
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
