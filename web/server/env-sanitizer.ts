/**
 * Scrub Claude Code host-session runtime markers from an environment.
 *
 * When the Campfire server is started from inside a Claude Code session (an
 * agent-run terminal, `open`-ing the desktop app from such a shell, a dev
 * server launched by an agent), it inherits that session's SDK environment:
 * CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH,
 * CLAUDE_CODE_OAUTH_SCOPES, and friends. A `claude` CLI spawned with those
 * markers believes a host process manages its OAuth tokens, skips its own
 * keychain credentials, and every API call fails with
 * `401 authentication_failed`.
 *
 * These markers describe a *session runtime*, never user configuration, so
 * the server strips them from its own process.env at bootstrap — before any
 * backend CLI, adapter, or terminal is spawned. Deliberate user configuration
 * is preserved:
 *   - CLAUDE_CODE_OAUTH_TOKEN            explicit auth override (also injected
 *                                        from Campfire settings)
 *   - CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS  feature flag Campfire itself sets
 */

const ALLOWLIST = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
]);

/** True when the key is a Claude Code session runtime marker to remove. */
export function isClaudeSessionMarker(key: string): boolean {
  if (ALLOWLIST.has(key)) return false;
  return (
    key === "CLAUDECODE" ||
    key === "CLAUDE_EFFORT" ||
    key.startsWith("CLAUDE_CODE_") ||
    key.startsWith("CLAUDE_AGENT_")
  );
}

/**
 * Remove Claude session markers in place. Returns the removed keys (sorted)
 * so the caller can log what was scrubbed.
 */
export function scrubClaudeSessionEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const removed = Object.keys(env).filter(isClaudeSessionMarker).sort();
  for (const key of removed) delete env[key];
  return removed;
}
