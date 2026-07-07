/**
 * MCP injection policy — default-deny for auto-injected servers plus a
 * static scan for suspicious configurations (inspired by MetaHarness's
 * default-deny MCP dispatch and `mcp-scan` threat model).
 *
 * Threat model: `detected_environment.mcpServers` is persisted in session
 * state and accepted in session-create payloads, so a tampered session file
 * or crafted API call could otherwise smuggle an arbitrary MCP server into
 * a session without the user ever configuring it. Auto-injection therefore
 * only admits servers that exactly match the curated ENVIRONMENT_RULES
 * catalog and pass the scan. User-initiated `mcp_set_servers` is never
 * blocked — the scan runs there in warn-only mode for visibility.
 *
 * Escape hatch: CAMPFIRE_MCP_AUTO_INJECT_POLICY=permissive restores the old
 * scan-free behavior (findings are still logged).
 */

import type { McpServerConfig } from "./session-types.js";
import { ENVIRONMENT_RULES } from "./environment-rules.js";

export interface McpScanFinding {
  server: string;
  severity: "block" | "warn";
  reason: string;
}

export interface AutoInjectionVerdict {
  allowed: Record<string, McpServerConfig>;
  blocked: McpScanFinding[];
}

/** Interpreters we consider reasonable launchers for stdio MCP servers. */
const SAFE_STDIO_COMMANDS = new Set([
  "npx", "bunx", "node", "bun", "deno", "uvx", "python", "python3",
]);

/** Shell metacharacters that have no business inside a command or argv element. */
const SHELL_META_RE = /[;&|`$<>\\]/;

/**
 * The curated auto-injection allowlist, derived directly from
 * ENVIRONMENT_RULES so it can never drift from the catalog. Keyed by rule id
 * with the exact expected config serialized for comparison.
 */
const CURATED_SERVERS: Map<string, string> = new Map(
  ENVIRONMENT_RULES
    .filter((rule) => rule.mcpServer)
    .map((rule) => [rule.id, JSON.stringify(rule.mcpServer)]),
);

function isLocalhostUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

/** Statically scan a single MCP server config for suspicious properties. */
export function scanMcpServerConfig(name: string, config: McpServerConfig): McpScanFinding[] {
  const findings: McpScanFinding[] = [];

  if (config.type === "stdio" || config.command) {
    const command = config.command ?? "";
    const argv = config.args ?? [];

    if (SHELL_META_RE.test(command)) {
      findings.push({ server: name, severity: "block", reason: `command contains shell metacharacters: ${command}` });
    }
    for (const arg of argv) {
      if (SHELL_META_RE.test(arg)) {
        findings.push({ server: name, severity: "block", reason: `argument contains shell metacharacters: ${arg}` });
      }
    }
    // Inline-eval flags let a "safe" interpreter run arbitrary code passed as data.
    if (argv.some((a) => a === "-e" || a === "--eval" || a === "-p")) {
      findings.push({ server: name, severity: "block", reason: "argument list contains an inline-eval flag" });
    }
    const binary = command.split("/").pop() ?? command;
    if (command && !SAFE_STDIO_COMMANDS.has(binary)) {
      findings.push({ server: name, severity: "warn", reason: `command "${command}" is not a recognized MCP launcher` });
    }
  }

  if (config.url) {
    if (config.url.startsWith("http://") && !isLocalhostUrl(config.url)) {
      findings.push({ server: name, severity: "block", reason: `plaintext http URL to non-local host: ${config.url}` });
    }
  }

  return findings;
}

/** Scan a full server map. Never blocks — used for user-initiated sets. */
export function scanMcpServers(servers: Record<string, McpServerConfig>): McpScanFinding[] {
  return Object.entries(servers).flatMap(([name, config]) => scanMcpServerConfig(name, config));
}

function isPermissive(): boolean {
  return process.env.CAMPFIRE_MCP_AUTO_INJECT_POLICY === "permissive";
}

/**
 * Default-deny evaluation for auto-injected (environment-detected) servers.
 * A server is admitted only when it exactly matches its curated catalog
 * entry AND the static scan raises no blocking findings.
 */
export function evaluateAutoInjection(servers: Record<string, McpServerConfig>): AutoInjectionVerdict {
  const allowed: Record<string, McpServerConfig> = {};
  const blocked: McpScanFinding[] = [];

  for (const [name, config] of Object.entries(servers)) {
    const findings = scanMcpServerConfig(name, config);
    const blocking = findings.filter((f) => f.severity === "block");
    const curated = CURATED_SERVERS.get(name);
    const matchesCatalog = curated !== undefined && curated === JSON.stringify(config);

    if (isPermissive()) {
      // Escape hatch: admit everything, but keep the findings visible.
      allowed[name] = config;
      blocked.push(...blocking.map((f) => ({ ...f, severity: "warn" as const })));
      continue;
    }

    if (!matchesCatalog) {
      blocked.push({
        server: name,
        severity: "block",
        reason: curated
          ? "config does not match the curated catalog entry for this rule"
          : "server is not in the curated auto-injection catalog",
      });
      continue;
    }
    if (blocking.length > 0) {
      blocked.push(...blocking);
      continue;
    }
    allowed[name] = config;
  }

  return { allowed, blocked };
}
