import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type {
  SessionState,
  BrowserIncomingMessage,
  PermissionRequest,
  BufferedBrowserEvent,
} from "./session-types.js";

// ─── Serializable session shape ─────────────────────────────────────────────

export interface PersistedSession {
  id: string;
  state: SessionState;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  pendingPermissions: [string, PermissionRequest][];
  eventBuffer?: BufferedBrowserEvent[];
  nextEventSeq?: number;
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  archived?: boolean;
}

// ─── Store ──────────────────────────────────────────────────────────────────

// Persistent storage: ~/.campfire/sessions/ (survives reboots, unlike /tmp/)
const PERSISTENT_DIR = join(homedir(), ".campfire", "sessions");
// Legacy location (may contain data from older installs or pre-migration)
const LEGACY_DIR = join(tmpdir(), "vibe-sessions");
const DEFAULT_DIR = process.env.CAMPFIRE_SESSION_DIR || PERSISTENT_DIR;

export class SessionStore {
  private readonly dir: string;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_DIR;
    mkdirSync(this.dir, { recursive: true });
    // Migrate data from legacy /tmp/ location if it exists and persistent dir is empty
    this.migrateFromLegacy();
  }

  /** One-time migration: copy session files from /tmp/vibe-sessions/ to ~/.campfire/sessions/ */
  private migrateFromLegacy(): void {
    // Skip if using custom dir or legacy dir doesn't exist
    if (this.dir !== PERSISTENT_DIR) return;
    if (!existsSync(LEGACY_DIR)) return;

    try {
      const legacyFiles = readdirSync(LEGACY_DIR).filter((f) => f.endsWith(".json"));
      const currentFiles = new Set(readdirSync(this.dir).filter((f) => f.endsWith(".json")));
      let migrated = 0;

      for (const file of legacyFiles) {
        if (currentFiles.has(file)) continue; // don't overwrite existing
        try {
          cpSync(join(LEGACY_DIR, file), join(this.dir, file));
          migrated++;
        } catch { /* skip individual file errors */ }
      }

      if (migrated > 0) {
        console.log(`[session-store] Migrated ${migrated} session(s) from ${LEGACY_DIR} to ${this.dir}`);
      }
    } catch { /* legacy dir not readable, skip */ }
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Debounced write — batches rapid changes (e.g. multiple stream events). */
  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.saveSync(session);
    }, 150);
    this.debounceTimers.set(session.id, timer);
  }

  /** Immediate write — use for critical state changes. */
  saveSync(session: PersistedSession): void {
    try {
      writeFileSync(this.filePath(session.id), JSON.stringify(session), "utf-8");
    } catch (err) {
      console.error(`[session-store] Failed to save session ${session.id}:`, err);
    }
  }

  /** Load a single session from disk. */
  load(sessionId: string): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath(sessionId), "utf-8");
      return JSON.parse(raw) as PersistedSession;
    } catch {
      return null;
    }
  }

  /** Load all sessions from disk. */
  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "launcher.json");
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), "utf-8");
          sessions.push(JSON.parse(raw));
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  /** Set the archived flag on a persisted session. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    this.saveSync(session);
    return true;
  }

  /** Remove a session file from disk. */
  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {
      // File may not exist
    }
  }

  /** Persist launcher state (separate file). */
  saveLauncher(data: unknown): void {
    try {
      writeFileSync(join(this.dir, "launcher.json"), JSON.stringify(data), "utf-8");
    } catch (err) {
      console.error("[session-store] Failed to save launcher state:", err);
    }
  }

  /** Load launcher state. */
  loadLauncher<T>(): T | null {
    try {
      const raw = readFileSync(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  get directory(): string {
    return this.dir;
  }
}
