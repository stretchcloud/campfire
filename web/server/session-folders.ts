/**
 * Session Folders — user-defined groups for organizing sessions.
 * Stored in ~/.companion/session-folders.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FOLDERS_FILE = join(homedir(), ".companion", "session-folders.json");

export interface SessionFolder {
  id: string;
  name: string;
  color?: string;
  sessionIds: string[];
  createdAt: number;
}

interface FoldersData {
  folders: SessionFolder[];
}

function ensureDir(): void {
  const dir = join(homedir(), ".companion");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): FoldersData {
  try {
    if (!existsSync(FOLDERS_FILE)) return { folders: [] };
    return JSON.parse(readFileSync(FOLDERS_FILE, "utf-8"));
  } catch {
    return { folders: [] };
  }
}

function save(data: FoldersData): void {
  ensureDir();
  writeFileSync(FOLDERS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function listFolders(): SessionFolder[] {
  return load().folders;
}

export function createFolder(name: string, color?: string): SessionFolder {
  const data = load();
  const folder: SessionFolder = {
    id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    color,
    sessionIds: [],
    createdAt: Date.now(),
  };
  data.folders.push(folder);
  save(data);
  return folder;
}

export function updateFolder(id: string, updates: { name?: string; color?: string }): SessionFolder | null {
  const data = load();
  const folder = data.folders.find((f) => f.id === id);
  if (!folder) return null;
  if (updates.name !== undefined) folder.name = updates.name;
  if (updates.color !== undefined) folder.color = updates.color;
  save(data);
  return folder;
}

export function deleteFolder(id: string): boolean {
  const data = load();
  const index = data.folders.findIndex((f) => f.id === id);
  if (index === -1) return false;
  data.folders.splice(index, 1);
  save(data);
  return true;
}

export function addSessionToFolder(folderId: string, sessionId: string): boolean {
  const data = load();
  // Remove from any other folder first
  for (const folder of data.folders) {
    folder.sessionIds = folder.sessionIds.filter((s) => s !== sessionId);
  }
  const folder = data.folders.find((f) => f.id === folderId);
  if (!folder) return false;
  folder.sessionIds.push(sessionId);
  save(data);
  return true;
}

export function removeSessionFromFolder(sessionId: string): boolean {
  const data = load();
  let removed = false;
  for (const folder of data.folders) {
    const len = folder.sessionIds.length;
    folder.sessionIds = folder.sessionIds.filter((s) => s !== sessionId);
    if (folder.sessionIds.length < len) removed = true;
  }
  if (removed) save(data);
  return removed;
}

export function getSessionFolder(sessionId: string): SessionFolder | null {
  const data = load();
  return data.folders.find((f) => f.sessionIds.includes(sessionId)) ?? null;
}
