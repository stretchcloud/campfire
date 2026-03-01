/**
 * DmuxConfig — CRUD operations for project-local .dmux/dmux.config.json.
 *
 * Follows the env-manager.ts pattern but operates on project-local config files.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface DmuxConfigFile {
  session_name?: string;
  project_root?: string;
  panes?: Array<{
    id?: string;
    slug?: string;
    agent?: string;
    pane_id?: string;
    tmux_target?: string;
    branch?: string;
    worktree?: string;
    status?: string;
  }>;
  default_prompt?: string;
  branch_prefix?: string;
  auto_restart?: boolean;
}

/**
 * Read the dmux config file for a given project directory.
 * Returns null if the file doesn't exist or is invalid JSON.
 */
export function readDmuxConfig(cwd: string): DmuxConfigFile | null {
  try {
    const configPath = join(cwd, ".dmux", "dmux.config.json");
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as DmuxConfigFile;
  } catch {
    return null;
  }
}

/**
 * Write a complete dmux config file for a given project directory.
 * Creates the .dmux directory if it doesn't exist.
 */
export function writeDmuxConfig(cwd: string, config: DmuxConfigFile): void {
  const configPath = join(cwd, ".dmux", "dmux.config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Merge partial updates into an existing dmux config.
 * Returns the merged config, or null if there's no existing config to update.
 */
export function updateDmuxConfig(
  cwd: string,
  updates: Partial<DmuxConfigFile>,
): DmuxConfigFile | null {
  const existing = readDmuxConfig(cwd);
  if (!existing) return null;

  const merged: DmuxConfigFile = { ...existing, ...updates };
  writeDmuxConfig(cwd, merged);
  return merged;
}
