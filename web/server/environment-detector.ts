import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DetectedEnvironment, McpServerConfig } from "./session-types.js";
import { ENVIRONMENT_RULES, toDetectedRule, type PackageJsonLike, type ProjectContext } from "./environment-rules.js";

const ENV_FILES = [".env", ".env.local", ".env.development"];
const MAX_ENV_BYTES = 256 * 1024;

function readPackageJson(cwd: string): PackageJsonLike | undefined {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJsonLike;
  } catch {
    return undefined;
  }
}

function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([\w.-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }
  return vars;
}

function readEnvVars(cwd: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const file of ENV_FILES) {
    const path = join(cwd, file);
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_ENV_BYTES) continue;
      Object.assign(envVars, parseEnvContent(readFileSync(path, "utf-8")));
    } catch {
      // Ignore unreadable env files. Detection is best effort.
    }
  }
  return envVars;
}

function addIfExists(cwd: string, relPath: string, files: Set<string>, dirs: Set<string>): void {
  const path = join(cwd, relPath);
  try {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) dirs.add(relPath);
    if (stat.isFile()) files.add(relPath);
  } catch {
    // Ignore transient filesystem errors.
  }
}

function collectProjectContext(cwd: string): ProjectContext {
  const files = new Set<string>();
  const dirs = new Set<string>();

  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isFile()) files.add(entry.name);
      if (entry.isDirectory()) dirs.add(entry.name);
    }
  } catch {
    // Leave sets empty; downstream rules will simply not match.
  }

  addIfExists(cwd, "prisma/schema.prisma", files, dirs);
  addIfExists(cwd, ".github/workflows", files, dirs);

  return {
    cwd,
    files,
    dirs,
    packageJson: readPackageJson(cwd),
    envVars: readEnvVars(cwd),
  };
}

export function detectEnvironment(cwd: string): DetectedEnvironment {
  const ctx = collectProjectContext(cwd);
  const rules = [];
  const mcpServers: Record<string, McpServerConfig> = {};

  for (const rule of ENVIRONMENT_RULES) {
    if (!rule.detect(ctx)) continue;
    rules.push(toDetectedRule(rule, ctx.envVars));
    if (rule.mcpServer) {
      mcpServers[rule.id] = rule.mcpServer;
    }
  }

  return {
    cwd,
    scannedAt: Date.now(),
    rules,
    mcpServers,
  };
}
