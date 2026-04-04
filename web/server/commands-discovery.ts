/**
 * Commands Discovery — scans the filesystem for slash commands and skills.
 *
 * Discovers:
 * - Slash commands: .md files in ~/.claude/commands/ and {cwd}/.claude/commands/
 * - Skills: directories with SKILL.md in ~/.claude/skills/
 *
 * Returns structured data with names, descriptions, source labels,
 * and file paths. Used to pre-populate session state before CLI connects.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredCommand {
  name: string;
  description: string;
  source: "user" | "project";
  path: string;
}

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  path: string;
}

export interface DiscoveryResult {
  commands: DiscoveredCommand[];
  skills: DiscoveredSkill[];
  slashCommandNames: string[];
  skillSlugs: string[];
}

// ─── Discovery ──────────────────────────────────────────────────────────────

export function discoverCommandsAndSkills(cwd?: string): DiscoveryResult {
  const commands: DiscoveredCommand[] = [];
  const skills: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  // User-level commands: ~/.claude/commands/*.md
  const userCommandsDir = join(homedir(), ".claude", "commands");
  for (const cmd of scanCommands(userCommandsDir, "user")) {
    if (!seen.has(cmd.name)) {
      commands.push(cmd);
      seen.add(cmd.name);
    }
  }

  // Project-level commands: {cwd}/.claude/commands/*.md
  if (cwd) {
    const projectCommandsDir = join(cwd, ".claude", "commands");
    for (const cmd of scanCommands(projectCommandsDir, "project")) {
      if (!seen.has(cmd.name)) {
        commands.push(cmd);
        seen.add(cmd.name);
      }
    }
  }

  // User-level skills: ~/.claude/skills/*/SKILL.md
  const userSkillsDir = join(homedir(), ".claude", "skills");
  skills.push(...scanSkills(userSkillsDir));

  commands.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    commands,
    skills,
    slashCommandNames: commands.map((c) => c.name),
    skillSlugs: skills.map((s) => s.slug),
  };
}

/** Read a specific command file's content. */
export function readCommandContent(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ─── Scanners ───────────────────────────────────────────────────────────────

function scanCommands(dir: string, source: "user" | "project"): DiscoveredCommand[] {
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return files.map((f) => {
      const filePath = join(dir, f);
      const name = basename(f, ".md");
      const description = extractFirstLine(filePath);
      return { name, description, source, path: filePath };
    });
  } catch {
    return [];
  }
}

function scanSkills(dir: string): DiscoveredSkill[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const results: DiscoveredSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const { name, description } = parseSkillFrontmatter(skillMd);
      results.push({
        slug: entry.name,
        name: name || entry.name,
        description,
        path: skillMd,
      });
    }
    return results;
  } catch {
    return [];
  }
}

function extractFirstLine(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    // Skip frontmatter (---...---) if present
    const stripped = content.replace(/^---[\s\S]*?---\n?/, "").trim();
    const firstLine = stripped.split("\n")[0]?.trim() || "";
    // Remove markdown heading prefix
    return firstLine.replace(/^#+\s*/, "").slice(0, 120);
  } catch {
    return "";
  }
}

function parseSkillFrontmatter(filePath: string): { name: string; description: string } {
  try {
    const content = readFileSync(filePath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return { name: "", description: "" };
    const frontmatter = match[1];
    // Use simple line-by-line parsing instead of backtracking regex
    let name = "";
    let description = "";
    for (const line of frontmatter.split("\n")) {
      if (line.startsWith("name:")) name = line.slice(5).trim();
      else if (line.startsWith("description:")) description = line.slice(12).trim();
    }
    return { name, description };
  } catch {
    return { name: "", description: "" };
  }
}
