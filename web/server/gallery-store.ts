import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  GalleryEntry,
  GalleryEntryCreateInput,
  GallerySessionSnapshot,
  GalleryFilter,
} from "./gallery-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const CAMPFIRE_DIR = join(homedir(), ".campfire");
const GALLERY_DIR = join(CAMPFIRE_DIR, "gallery");

function ensureDir(): void {
  mkdirSync(GALLERY_DIR, { recursive: true });
}

function filePath(id: string): string {
  return join(GALLERY_DIR, `${id}.json`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listEntries(filter?: GalleryFilter): GalleryEntry[] {
  ensureDir();
  try {
    const files = readdirSync(GALLERY_DIR).filter(
      (f) => f.endsWith(".json") && f !== "votes.json",
    );
    let entries: GalleryEntry[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(GALLERY_DIR, file), "utf-8");
        entries.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }

    if (filter) {
      entries = applyFilter(entries, filter);
    } else {
      // Default sort: votes descending
      entries.sort((a, b) => b.votes - a.votes);
    }

    return entries;
  } catch {
    return [];
  }
}

export function getEntry(id: string): GalleryEntry | null {
  ensureDir();
  try {
    const raw = readFileSync(filePath(id), "utf-8");
    return JSON.parse(raw) as GalleryEntry;
  } catch {
    return null;
  }
}

export function createEntry(
  input: GalleryEntryCreateInput,
  snapshot: GallerySessionSnapshot,
): GalleryEntry {
  if (!input.name || !input.name.trim()) throw new Error("Entry name is required");
  if (!input.sessionId || !input.sessionId.trim())
    throw new Error("Session ID is required");

  const id = slugify(input.name.trim());
  if (!id) throw new Error("Entry name must contain alphanumeric characters");

  ensureDir();
  if (existsSync(filePath(id))) {
    throw new Error(`A gallery entry with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const entry: GalleryEntry = {
    id,
    sessionId: input.sessionId.trim(),
    name: input.name.trim(),
    description: (input.description || "").trim(),
    tags: (input.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    featured: false,
    votes: 0,
    createdAt: now,
    updatedAt: now,
    backendType: snapshot.backendType || "claude",
    model: snapshot.model || "unknown",
    totalCostUsd: snapshot.totalCostUsd || 0,
    durationMs: snapshot.durationMs || 0,
    totalLinesAdded: snapshot.totalLinesAdded || 0,
    totalLinesRemoved: snapshot.totalLinesRemoved || 0,
    numTurns: snapshot.numTurns || 0,
    repoRoot: snapshot.repoRoot,
  };

  writeFileSync(filePath(id), JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export function updateEntry(
  id: string,
  updates: Partial<GalleryEntry>,
): GalleryEntry | null {
  ensureDir();
  const existing = getEntry(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Entry name must contain alphanumeric characters");

  // If name changed, check for slug collision
  if (newId !== id && existsSync(filePath(newId))) {
    throw new Error(`A gallery entry with a similar name already exists ("${newId}")`);
  }

  const entry: GalleryEntry = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    createdAt: existing.createdAt,
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      unlinkSync(filePath(id));
    } catch {
      /* ok */
    }
  }

  writeFileSync(filePath(newId), JSON.stringify(entry, null, 2), "utf-8");
  return entry;
}

export function deleteEntry(id: string): boolean {
  ensureDir();
  if (!existsSync(filePath(id))) return false;
  try {
    unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}

// ─── Filtering & Sorting ────────────────────────────────────────────────────

function applyFilter(entries: GalleryEntry[], filter: GalleryFilter): GalleryEntry[] {
  let result = entries;

  if (filter.backend) {
    result = result.filter((e) => e.backendType === filter.backend);
  }
  if (filter.minCost !== undefined) {
    result = result.filter((e) => e.totalCostUsd >= filter.minCost!);
  }
  if (filter.maxCost !== undefined) {
    result = result.filter((e) => e.totalCostUsd <= filter.maxCost!);
  }
  if (filter.tags && filter.tags.length > 0) {
    const filterTags = new Set(filter.tags.map((t) => t.toLowerCase()));
    result = result.filter((e) => e.tags.some((t) => filterTags.has(t)));
  }
  if (filter.featuredOnly) {
    result = result.filter((e) => e.featured);
  }

  const sortBy = filter.sortBy || "votes";
  const sortOrder = filter.sortOrder || "desc";
  const multiplier = sortOrder === "asc" ? 1 : -1;

  result.sort((a, b) => {
    switch (sortBy) {
      case "votes":
        return (a.votes - b.votes) * multiplier;
      case "cost":
        return (a.totalCostUsd - b.totalCostUsd) * multiplier;
      case "recent":
        return (a.createdAt - b.createdAt) * multiplier;
      case "duration":
        return (a.durationMs - b.durationMs) * multiplier;
      default:
        return (a.votes - b.votes) * multiplier;
    }
  });

  return result;
}
