/**
 * Recording Hub Store — metadata index overlay on existing recordings.
 *
 * Unlike companion (separate ~/.companion/hub/ storage), this extends
 * the existing ~/.campfire/recordings/ with an index.json for metadata,
 * tags, and summaries. No duplicate file storage.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadRecording, type Recording } from "../replay.js";
import type { RecorderManager } from "../recorder.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HubRecordingMeta {
  id: string;
  filename: string;
  filePath: string;
  sessionId: string;
  backendType: string;
  startedAt: number;
  duration: number;
  entryCount: number;
  tags: string[];
  importedAt: number;
  messageTypeSummary: Record<string, number>;
}

export interface HubRecordingSummary extends HubRecordingMeta {
  toolNames: string[];
  permissionCount: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const CAMPFIRE_DIR = join(homedir(), ".campfire");
const RECORDINGS_DIR = process.env.CAMPFIRE_RECORDINGS_DIR || join(CAMPFIRE_DIR, "recordings");
const INDEX_PATH = join(RECORDINGS_DIR, "hub-index.json");

// ─── Store ──────────────────────────────────────────────────────────────────

let index: HubRecordingMeta[] = [];
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(INDEX_PATH)) {
      const raw = readFileSync(INDEX_PATH, "utf-8");
      index = JSON.parse(raw);
    }
  } catch {
    index = [];
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listHubRecordings(): HubRecordingMeta[] {
  ensureLoaded();
  return [...index].sort((a, b) => b.importedAt - a.importedAt);
}

export function getHubRecording(id: string): HubRecordingMeta | null {
  ensureLoaded();
  return index.find((r) => r.id === id) || null;
}

export function importRecording(filePath: string): HubRecordingMeta {
  const recording = loadRecording(filePath);
  const meta = buildMeta(recording, filePath);

  ensureLoaded();
  // Deduplicate by filename
  const existing = index.findIndex((r) => r.filename === meta.filename);
  if (existing >= 0) {
    index[existing] = meta;
  } else {
    index.push(meta);
  }
  persist();
  return meta;
}

export function uploadRecording(content: string, originalFilename?: string): HubRecordingMeta {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const filename = originalFilename || `uploaded_${Date.now()}_${randomUUID().slice(0, 6)}.jsonl`;
  const destPath = join(RECORDINGS_DIR, filename);
  writeFileSync(destPath, content, "utf-8");

  const recording = loadRecording(destPath);
  const meta = buildMeta(recording, destPath);

  ensureLoaded();
  index.push(meta);
  persist();
  return meta;
}

export function updateTags(id: string, tags: string[]): HubRecordingMeta | null {
  ensureLoaded();
  const entry = index.find((r) => r.id === id);
  if (!entry) return null;
  entry.tags = tags;
  persist();
  return entry;
}

export function deleteHubRecording(id: string): boolean {
  ensureLoaded();
  const idx = index.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  index.splice(idx, 1);
  persist();
  return true;
}

function extractToolNames(parsed: Record<string, unknown>, toolNames: Set<string>): void {
  const msg = parsed.message as Record<string, unknown> | undefined;
  const content = msg?.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolNames.add(block.name);
    }
  }
}

function extractSummaryFromRecording(recording: Recording): { toolNames: string[]; permissionCount: number } {
  const toolNames = new Set<string>();
  let permissionCount = 0;

  for (const entry of recording.entries) {
    try {
      const parsed = JSON.parse(entry.raw) as Record<string, unknown>;
      if (parsed.type === "permission_request") permissionCount++;
      if (parsed.type === "assistant") extractToolNames(parsed, toolNames);
    } catch { /* skip malformed */ }
  }

  return { toolNames: [...toolNames].sort((a, b) => a.localeCompare(b)), permissionCount };
}

export function getSummary(id: string): HubRecordingSummary | null {
  ensureLoaded();
  const meta = index.find((r) => r.id === id);
  if (!meta) return null;

  try {
    const recording = loadRecording(meta.filePath);
    const { toolNames, permissionCount } = extractSummaryFromRecording(recording);
    return { ...meta, toolNames, permissionCount };
  } catch {
    return { ...meta, toolNames: [], permissionCount: 0 };
  }
}

/** Import all existing auto-recordings into the hub index. */
export function indexExistingRecordings(recorder: RecorderManager): number {
  const recordings = recorder.listRecordings();
  let imported = 0;
  ensureLoaded();
  const existingFilenames = new Set(index.map((r) => r.filename));

  for (const rec of recordings) {
    if (existingFilenames.has(rec.filename)) continue;
    try {
      const filePath = join(RECORDINGS_DIR, rec.filename);
      if (!existsSync(filePath)) continue;
      const recording = loadRecording(filePath);
      const meta = buildMeta(recording, filePath);
      index.push(meta);
      imported++;
    } catch { /* skip corrupt files */ }
  }

  if (imported > 0) persist();
  return imported;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildMeta(recording: Recording, filePath: string): HubRecordingMeta {
  const entries = recording.entries;
  const duration = entries.length > 1 ? entries[entries.length - 1].ts - entries[0].ts : 0;

  const typeSummary: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.dir !== "out" || entry.ch !== "browser") continue;
    try {
      const parsed = JSON.parse(entry.raw) as Record<string, unknown>;
      const t = typeof parsed.type === "string" ? parsed.type : "unknown";
      typeSummary[t] = (typeSummary[t] || 0) + 1;
    } catch { /* skip */ }
  }

  return {
    id: randomUUID().slice(0, 12),
    filename: basename(filePath),
    filePath,
    sessionId: recording.header.session_id,
    backendType: recording.header.backend_type || "unknown",
    startedAt: recording.header.started_at,
    duration,
    entryCount: entries.length,
    tags: [],
    importedAt: Date.now(),
    messageTypeSummary: typeSummary,
  };
}
