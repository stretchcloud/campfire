/**
 * Skills Manager — reads Claude Code plugins/skills from ~/.claude/plugins/
 * and provides CRUD operations for the Skills Management UI.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGINS_DIR = join(homedir(), ".claude", "plugins");
const INSTALLED_FILE = join(PLUGINS_DIR, "installed_plugins.json");
const BLOCKLIST_FILE = join(PLUGINS_DIR, "blocklist.json");
const CACHE_DIR = join(PLUGINS_DIR, "cache");

export interface PluginInfo {
  /** Plugin identifier, e.g., "frontend-design@claude-plugins-official" */
  id: string;
  /** Plugin name */
  name: string;
  /** Plugin description */
  description: string;
  /** Marketplace source */
  marketplace: string;
  /** Author name */
  author?: string;
  /** Install path on disk */
  installPath: string;
  /** Version string */
  version: string;
  /** When installed */
  installedAt: string;
  /** Whether the plugin is blocked */
  blocked: boolean;
  /** Block reason (if blocked) */
  blockReason?: string;
  /** Skills provided by this plugin */
  skills: SkillInfo[];
  /** Commands provided by this plugin */
  commands: CommandInfo[];
}

export interface SkillInfo {
  name: string;
  description?: string;
  path: string;
}

export interface CommandInfo {
  name: string;
  path: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, Array<{
    scope: string;
    installPath: string;
    version: string;
    installedAt: string;
    lastUpdated: string;
    gitCommitSha?: string;
  }>>;
}

interface BlocklistFile {
  fetchedAt: string;
  plugins: Array<{
    plugin: string;
    added_at: string;
    reason: string;
    text: string;
  }>;
}

function readJSON<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readPluginJson(installPath: string): { name?: string; description?: string; author?: { name?: string } } {
  const pluginJsonPath = join(installPath, ".claude-plugin", "plugin.json");
  return readJSON(pluginJsonPath) ?? {};
}

function discoverSkills(installPath: string): SkillInfo[] {
  const skillsDir = join(installPath, "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: SkillInfo[] = [];
  try {
    for (const entry of readdirSync(skillsDir)) {
      const skillDir = join(skillsDir, entry);
      if (!statSync(skillDir).isDirectory()) continue;
      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      // Try to extract description from SKILL.md frontmatter
      let description: string | undefined;
      try {
        const content = readFileSync(skillMd, "utf-8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
        }
      } catch {}

      skills.push({ name: entry, description, path: skillDir });
    }
  } catch {}
  return skills;
}

function discoverCommands(installPath: string): CommandInfo[] {
  const commandsDir = join(installPath, "commands");
  if (!existsSync(commandsDir)) return [];

  const commands: CommandInfo[] = [];
  try {
    for (const entry of readdirSync(commandsDir)) {
      if (!entry.endsWith(".md")) continue;
      commands.push({
        name: entry.replace(/\.md$/, ""),
        path: join(commandsDir, entry),
      });
    }
  } catch {}
  return commands;
}

/** List all installed plugins with their skills and commands. */
export function listPlugins(): PluginInfo[] {
  const installed = readJSON<InstalledPluginsFile>(INSTALLED_FILE);
  if (!installed?.plugins) return [];

  const blocklist = readJSON<BlocklistFile>(BLOCKLIST_FILE);
  const blockedSet = new Map<string, string>();
  if (blocklist?.plugins) {
    for (const b of blocklist.plugins) {
      blockedSet.set(b.plugin, b.reason);
    }
  }

  const results: PluginInfo[] = [];
  for (const [id, installs] of Object.entries(installed.plugins)) {
    if (!installs || installs.length === 0) continue;
    const latest = installs[0]; // First install entry
    const [name, marketplace] = id.split("@");

    const pluginJson = readPluginJson(latest.installPath);
    const skills = discoverSkills(latest.installPath);
    const commands = discoverCommands(latest.installPath);

    results.push({
      id,
      name: pluginJson.name || name,
      description: pluginJson.description || "",
      marketplace: marketplace || "unknown",
      author: pluginJson.author?.name,
      installPath: latest.installPath,
      version: latest.version,
      installedAt: latest.installedAt,
      blocked: blockedSet.has(id),
      blockReason: blockedSet.get(id),
      skills,
      commands,
    });
  }
  return results;
}

/** Get a single plugin by ID. */
export function getPlugin(id: string): PluginInfo | null {
  const all = listPlugins();
  return all.find((p) => p.id === id) ?? null;
}

/** Read the content of a skill's SKILL.md file. */
export function readSkillContent(pluginId: string, skillName: string): string | null {
  const plugin = getPlugin(pluginId);
  if (!plugin) return null;
  const skill = plugin.skills.find((s) => s.name === skillName);
  if (!skill) return null;

  const skillMd = join(skill.path, "SKILL.md");
  try {
    return readFileSync(skillMd, "utf-8");
  } catch {
    return null;
  }
}

/** Read the content of a command file. */
export function readCommandContent(pluginId: string, commandName: string): string | null {
  const plugin = getPlugin(pluginId);
  if (!plugin) return null;
  const cmd = plugin.commands.find((c) => c.name === commandName);
  if (!cmd) return null;

  try {
    return readFileSync(cmd.path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Enable/disable a plugin by modifying ~/.companion/skills-config.json.
 * (This is a Campfire-level toggle, not modifying Claude's own config.)
 */
const SKILLS_CONFIG_FILE = join(homedir(), ".companion", "skills-config.json");

interface SkillsConfig {
  disabled: string[]; // List of plugin IDs that are disabled in Campfire
}

function readSkillsConfig(): SkillsConfig {
  return readJSON<SkillsConfig>(SKILLS_CONFIG_FILE) ?? { disabled: [] };
}

function writeSkillsConfig(config: SkillsConfig): void {
  const dir = join(homedir(), ".companion");
  if (!existsSync(dir)) {
    const { mkdirSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SKILLS_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function isPluginDisabled(pluginId: string): boolean {
  const config = readSkillsConfig();
  return config.disabled.includes(pluginId);
}

export function setPluginDisabled(pluginId: string, disabled: boolean): void {
  const config = readSkillsConfig();
  if (disabled && !config.disabled.includes(pluginId)) {
    config.disabled.push(pluginId);
  } else if (!disabled) {
    config.disabled = config.disabled.filter((id) => id !== pluginId);
  }
  writeSkillsConfig(config);
}

export function getDisabledPlugins(): string[] {
  return readSkillsConfig().disabled;
}
