import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendType } from "./session-types.js";

export type RaceStatus = "running" | "completed" | "failed" | "cancelled";
export type RaceEntryStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export interface RaceEntry {
  id: string;
  sessionId: string;
  backendType: BackendType;
  model?: string;
  worktreePath: string;
  branch: string;
  status: RaceEntryStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  outputSummary?: string;
  filesChanged?: string[];
  metrics?: {
    wallClockMs: number;
    costUsd: number;
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    testsPassed?: number;
    testsFailed?: number;
    lintWarnings?: number;
    lintErrors?: number;
  };
}

export interface RaceResult {
  raceId: string;
  prompt: string;
  repoRoot: string;
  baseBranch: string;
  status: RaceStatus;
  createdAt: number;
  completedAt?: number;
  entries: RaceEntry[];
  winnerId?: string;
  error?: string;
}

const RACES_DIR = join(homedir(), ".campfire", "races");

function ensureDir(): void {
  mkdirSync(RACES_DIR, { recursive: true });
}

export function listRaces(): RaceResult[] {
  ensureDir();
  return readdirSync(RACES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => getRace(file.replace(/\.json$/, "")))
    .filter((race): race is RaceResult => race !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getRace(id: string): RaceResult | null {
  ensureDir();
  try {
    return JSON.parse(readFileSync(join(RACES_DIR, `${id}.json`), "utf-8")) as RaceResult;
  } catch {
    return null;
  }
}

export function saveRace(race: RaceResult): void {
  ensureDir();
  writeFileSync(join(RACES_DIR, `${race.raceId}.json`), JSON.stringify(race, null, 2), "utf-8");
}

export function deleteRace(id: string): boolean {
  const path = join(RACES_DIR, `${id}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
