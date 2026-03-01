/**
 * DmuxPaneRecorder — JSONL recording of pane output for replay.
 *
 * Follows the recorder.ts pattern. Stores recordings in ~/.companion/dmux-recordings/.
 */

import { mkdirSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_DIR = join(homedir(), ".companion", "dmux-recordings");
const RECORDING_FILENAME_RE = /^[A-Za-z0-9._-]+\.jsonl$/;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DmuxRecordingHeader {
  _header: true;
  version: 1;
  cwd: string;
  sessionName: string;
  startedAt: number;
  panes: string[];
}

export interface DmuxRecordingEntry {
  ts: number;
  tmuxTarget: string;
  data: string;
}

export interface DmuxRecordingMeta {
  filename: string;
  cwd: string;
  sessionName: string;
  startedAt: number;
  panes: string[];
}

export interface DmuxRecordingData {
  header: DmuxRecordingHeader;
  entries: DmuxRecordingEntry[];
}

function getRecordingsDir(): string {
  return process.env.COMPANION_DMUX_RECORDINGS_DIR || DEFAULT_DIR;
}

function isValidHeader(value: unknown): value is DmuxRecordingHeader {
  if (!value || typeof value !== "object") return false;
  const header = value as Partial<DmuxRecordingHeader>;
  return (
    header._header === true
    && header.version === 1
    && typeof header.cwd === "string"
    && typeof header.sessionName === "string"
    && typeof header.startedAt === "number"
    && Array.isArray(header.panes)
    && header.panes.every((pane) => typeof pane === "string")
  );
}

function isValidEntry(value: unknown): value is DmuxRecordingEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DmuxRecordingEntry>;
  return (
    typeof entry.ts === "number"
    && typeof entry.tmuxTarget === "string"
    && typeof entry.data === "string"
  );
}

function getRecordingPath(filename: string): string | null {
  if (!RECORDING_FILENAME_RE.test(filename)) return null;
  return join(getRecordingsDir(), filename);
}

// ─── DmuxPaneRecorder ─────────────────────────────────────────────────────────

/**
 * Records pane output to a JSONL file.
 * First line is a header, subsequent lines are timestamped entries.
 */
export class DmuxPaneRecorder {
  readonly filePath: string;
  private closed = false;

  constructor(cwd: string, sessionName: string, paneTargets: string[]) {
    const dir = getRecordingsDir();
    mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = randomBytes(3).toString("hex");
    const filename = `dmux_${timestamp}_${suffix}.jsonl`;
    this.filePath = join(dir, filename);

    const header: DmuxRecordingHeader = {
      _header: true,
      version: 1,
      cwd,
      sessionName,
      startedAt: Date.now(),
      panes: paneTargets,
    };
    appendFileSync(this.filePath, JSON.stringify(header) + "\n");
  }

  /** Record a pane output entry. */
  record(tmuxTarget: string, data: string): void {
    if (this.closed) return;
    const entry: DmuxRecordingEntry = {
      ts: Date.now(),
      tmuxTarget,
      data,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  /** Close the recorder (no more entries will be written). */
  close(): void {
    this.closed = true;
  }

  /** Get the filename (basename) of the recording. */
  getFilename(): string {
    return basename(this.filePath);
  }
}

// ─── Listing & loading ────────────────────────────────────────────────────────

/**
 * List all dmux recordings with their header metadata.
 */
export function listDmuxRecordings(): DmuxRecordingMeta[] {
  const dir = getRecordingsDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const results: DmuxRecordingMeta[] = [];

    for (const filename of files) {
      try {
        const raw = readFileSync(join(dir, filename), "utf-8");
        const firstLine = raw.split("\n")[0];
        const header = JSON.parse(firstLine);
        if (isValidHeader(header)) {
          results.push({
            filename,
            cwd: header.cwd,
            sessionName: header.sessionName,
            startedAt: header.startedAt,
            panes: header.panes,
          });
        }
      } catch {
        // Skip corrupt files
      }
    }

    return results.sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

/**
 * Load a complete dmux recording by filename.
 */
export function loadDmuxRecording(filename: string): DmuxRecordingData | null {
  const filePath = getRecordingPath(filename);
  if (!filePath) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    if (lines.length === 0) return null;

    const header = JSON.parse(lines[0]);
    if (!isValidHeader(header)) return null;

    const entries: DmuxRecordingEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const parsed = JSON.parse(lines[i]);
        if (isValidEntry(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // Skip corrupt entries
      }
    }

    return { header, entries };
  } catch {
    return null;
  }
}
