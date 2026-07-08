import { describe, expect, it } from "vitest";
import { isClaudeSessionMarker, scrubClaudeSessionEnv } from "./env-sanitizer.js";

// Regression coverage for the desktop-app 401 bug: a Campfire server started
// from inside a Claude Code session inherited the host session's SDK env
// (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH, …).
// A `claude` CLI spawned with those markers expects host-managed OAuth,
// skips its keychain credentials, and fails every API call with
// `401 authentication_failed`. The sanitizer strips the markers at server
// bootstrap while preserving deliberate user configuration.
describe("env-sanitizer", () => {
  it("removes Claude session runtime markers observed in the real incident", () => {
    const env: Record<string, string | undefined> = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "4d5e82e1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-code",
      CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: "1",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      CLAUDE_CODE_OAUTH_SCOPES: "user:inference",
      CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
      CLAUDE_AGENT_SDK_VERSION: "0.3.20",
      CLAUDE_EFFORT: "xhigh",
      CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: "false",
    };
    const removed = scrubClaudeSessionEnv(env);

    expect(Object.keys(env)).toEqual([]);
    expect(removed).toContain("CLAUDECODE");
    expect(removed).toContain("CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH");
    expect(removed).toHaveLength(11);
  });

  it("preserves deliberate user configuration and unrelated variables", () => {
    const env: Record<string, string | undefined> = {
      // Explicit auth override must survive — Campfire settings inject it too.
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-user-set",
      // Feature flag Campfire sets for itself at bootstrap.
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      // Anthropic vars are user config (keys, proxies), never session markers.
      ANTHROPIC_API_KEY: "sk-ant-user",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      HOME: "/Users/someone",
      PATH: "/usr/bin",
    };
    const before = { ...env };
    const removed = scrubClaudeSessionEnv(env);

    expect(removed).toEqual([]);
    expect(env).toEqual(before);
  });

  it("classifies marker keys by prefix, not an exhaustive list", () => {
    // Future SDK versions add new CLAUDE_CODE_* markers; the prefix rule must
    // catch them without a code change.
    expect(isClaudeSessionMarker("CLAUDE_CODE_SOME_FUTURE_FLAG")).toBe(true);
    expect(isClaudeSessionMarker("CLAUDE_AGENT_FUTURE")).toBe(true);
    expect(isClaudeSessionMarker("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(isClaudeSessionMarker("CLAUDEX_UNRELATED")).toBe(false);
    expect(isClaudeSessionMarker("MY_CLAUDE_CODE_THING")).toBe(false);
  });
});
