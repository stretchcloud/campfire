/**
 * Maps git repositories to Linear teams/projects.
 * Persisted to ~/.companion/linear-projects.json
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface ProjectMapping {
  repoRoot: string;
  teamId: string;
  teamKey: string;
  teamName: string;
  projectId?: string;
  projectName?: string;
  updatedAt: number;
}

interface MappingsFile {
  mappings: ProjectMapping[];
}

const STORE_DIR = join(homedir(), ".companion");
const STORE_PATH = join(STORE_DIR, "linear-projects.json");

function loadMappings(): MappingsFile {
  if (!existsSync(STORE_PATH)) return { mappings: [] };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return { mappings: [] };
  }
}

function saveMappings(data: MappingsFile): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Get the Linear project mapping for a git repo root. */
export function getProjectForRepo(repoRoot: string): ProjectMapping | null {
  const { mappings } = loadMappings();
  return mappings.find((m) => m.repoRoot === repoRoot) ?? null;
}

/** Set or update the Linear project mapping for a git repo root. */
export function setProjectForRepo(repoRoot: string, mapping: Omit<ProjectMapping, "repoRoot" | "updatedAt">): ProjectMapping {
  const data = loadMappings();
  const existing = data.mappings.findIndex((m) => m.repoRoot === repoRoot);
  const entry: ProjectMapping = {
    ...mapping,
    repoRoot,
    updatedAt: Date.now(),
  };
  if (existing >= 0) {
    data.mappings[existing] = entry;
  } else {
    data.mappings.push(entry);
  }
  saveMappings(data);
  return entry;
}

/** Remove the mapping for a git repo root. */
export function removeProjectMapping(repoRoot: string): boolean {
  const data = loadMappings();
  const idx = data.mappings.findIndex((m) => m.repoRoot === repoRoot);
  if (idx < 0) return false;
  data.mappings.splice(idx, 1);
  saveMappings(data);
  return true;
}

/** List all repo-to-project mappings. */
export function listMappings(): ProjectMapping[] {
  return loadMappings().mappings;
}
