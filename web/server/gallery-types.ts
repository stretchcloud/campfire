import type { BackendType } from "./session-types.js";

// ─── Gallery Entry ─────────────────────────────────────────────────────────

export interface GalleryEntry {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  tags: string[];
  featured: boolean;
  votes: number;
  createdAt: number;
  updatedAt: number;
  // Denormalized session snapshot for fast listing
  backendType: BackendType;
  model: string;
  totalCostUsd: number;
  durationMs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  numTurns: number;
  repoRoot?: string;
}

export interface GalleryEntryCreateInput {
  sessionId: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface GallerySessionSnapshot {
  backendType?: BackendType;
  model?: string;
  totalCostUsd?: number;
  durationMs?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  numTurns?: number;
  repoRoot?: string;
}

export interface GalleryFilter {
  backend?: BackendType;
  minCost?: number;
  maxCost?: number;
  tags?: string[];
  featuredOnly?: boolean;
  sortBy?: "votes" | "cost" | "recent" | "duration";
  sortOrder?: "asc" | "desc";
}
