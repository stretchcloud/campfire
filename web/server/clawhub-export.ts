import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GalleryEntry } from "./gallery-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClawHubSkillMeta {
  name: string;
  description: string;
  emoji: string;
  homepage: string;
  cost: string;
  duration: string;
  model: string;
  backend: string;
  turns: number;
  prompt?: string;
  replayUrl?: string;
}

export interface ClawHubSearchResult {
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
}

// ─── ClawHub CLI availability ───────────────────────────────────────────────

/** Check if the `clawhub` CLI is available on PATH. */
export function checkClawHubAvailable(): boolean {
  try {
    execSync("clawhub --version", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ─── SKILL.md generation ────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
}

/**
 * Generate SKILL.md content from a gallery entry.
 * This creates a ClawHub-compatible skill definition that
 * links back to Campfire for replay and details.
 */
export function generateSkillMd(
  entry: GalleryEntry,
  options?: {
    campfireBaseUrl?: string;
    prompt?: string;
  },
): string {
  const baseUrl = options?.campfireBaseUrl || "http://localhost:3456";
  const cost = `$${entry.totalCostUsd.toFixed(2)}`;
  const duration = formatDuration(entry.durationMs);
  const replayUrl = `${baseUrl}/#/replay/session/${entry.sessionId}`;
  const galleryUrl = `${baseUrl}/#/gallery`;

  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`name: ${entry.id}`);
  lines.push(`description: ${entry.description || entry.name}`);
  lines.push("metadata:");
  lines.push("  openclaw:");
  lines.push('    emoji: "🔥"');
  lines.push(`    homepage: "${galleryUrl}"`);
  lines.push("user-invocable: true");
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${entry.name}`);
  lines.push("");

  // Stats line
  lines.push(`**Cost:** ${cost} | **Duration:** ${duration} | **Model:** ${entry.model} | **Backend:** ${entry.backendType} | **Turns:** ${entry.numTurns}`);
  lines.push("");

  // Description
  if (entry.description) {
    lines.push("## What happened");
    lines.push("");
    lines.push(entry.description);
    lines.push("");
  }

  // Tags
  if (entry.tags.length > 0) {
    lines.push(`**Tags:** ${entry.tags.join(", ")}`);
    lines.push("");
  }

  // Lines changed
  if (entry.totalLinesAdded > 0 || entry.totalLinesRemoved > 0) {
    lines.push(`**Lines changed:** +${entry.totalLinesAdded} / -${entry.totalLinesRemoved}`);
    lines.push("");
  }

  // Replay link
  lines.push("## Replay");
  lines.push("");
  lines.push(`View the full session replay at: ${replayUrl}`);
  lines.push("");

  // Original prompt
  if (options?.prompt) {
    lines.push("## Prompt");
    lines.push("");
    lines.push(options.prompt);
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("*Exported from [Campfire](https://github.com/your-org/campfire)*");
  lines.push("");

  return lines.join("\n");
}

// ─── Export to ClawHub ──────────────────────────────────────────────────────

/**
 * Export a gallery entry to ClawHub.
 * Writes SKILL.md to a temp directory and runs `clawhub publish`.
 */
export function exportToClawHub(
  entry: GalleryEntry,
  options?: {
    campfireBaseUrl?: string;
    prompt?: string;
    dryRun?: boolean;
  },
): { success: boolean; skillDir: string; output?: string; error?: string } {
  const skillDir = join(tmpdir(), `campfire-clawhub-${entry.id}`);
  mkdirSync(skillDir, { recursive: true });

  const skillMd = generateSkillMd(entry, options);
  writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf-8");

  if (options?.dryRun) {
    return { success: true, skillDir };
  }

  try {
    const output = execSync(`clawhub publish "${skillDir}"`, {
      cwd: skillDir,
      timeout: 30_000,
      encoding: "utf-8",
    });
    return { success: true, skillDir, output: output.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, skillDir, error: msg };
  }
}

// ─── Search ClawHub ─────────────────────────────────────────────────────────

/**
 * Search ClawHub skills via the CLI.
 * Returns parsed results from `clawhub search <query>`.
 */
export function searchClawHub(query: string): ClawHubSearchResult[] {
  try {
    const output = execSync(`clawhub search "${query.replace(/"/g, '\\"')}" --json`, {
      timeout: 15_000,
      encoding: "utf-8",
    });

    // Parse JSON output from clawhub CLI
    const parsed = JSON.parse(output.trim());
    if (Array.isArray(parsed)) {
      return parsed.map((item: Record<string, unknown>) => ({
        name: String(item.name || ""),
        description: String(item.description || ""),
        version: String(item.version || "0.0.0"),
        author: item.author ? String(item.author) : undefined,
        downloads: typeof item.downloads === "number" ? item.downloads : undefined,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Install a ClawHub skill by slug.
 */
export function installClawHubSkill(slug: string): { success: boolean; output?: string; error?: string } {
  try {
    const output = execSync(`clawhub install "${slug.replace(/"/g, '\\"')}"`, {
      timeout: 30_000,
      encoding: "utf-8",
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
