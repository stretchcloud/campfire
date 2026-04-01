import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_CAMPFIRE_CODEX_HOME,
  getLegacyCodexHome,
  resolveCampfireCodexHome,
  resolveCampfireCodexSessionHome,
} from "./codex-home.js";

describe("codex-home", () => {
  it("DEFAULT_CAMPFIRE_CODEX_HOME points to ~/.campfire/codex-home", () => {
    expect(DEFAULT_CAMPFIRE_CODEX_HOME).toBe(
      join(homedir(), ".campfire", "codex-home"),
    );
  });

  it("getLegacyCodexHome returns ~/.codex", () => {
    expect(getLegacyCodexHome()).toBe(join(homedir(), ".codex"));
  });

  it("resolveCampfireCodexHome returns default when no explicit path given", () => {
    expect(resolveCampfireCodexHome()).toBe(DEFAULT_CAMPFIRE_CODEX_HOME);
  });

  it("resolveCampfireCodexHome uses explicit path when provided", () => {
    const custom = "/tmp/my-codex-home";
    expect(resolveCampfireCodexHome(custom)).toBe(custom);
  });

  // Regression: resolveCampfireCodexHome must NOT read process.env.CODEX_HOME
  // because that points to the user's global ~/.codex and would break per-session isolation.
  it("resolveCampfireCodexHome ignores process.env.CODEX_HOME", () => {
    const original = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/tmp/global-codex";
      expect(resolveCampfireCodexHome()).toBe(DEFAULT_CAMPFIRE_CODEX_HOME);
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("resolveCampfireCodexSessionHome appends sessionId to base", () => {
    const sessionId = "abc-123";
    expect(resolveCampfireCodexSessionHome(sessionId)).toBe(
      join(DEFAULT_CAMPFIRE_CODEX_HOME, sessionId),
    );
  });

  it("resolveCampfireCodexSessionHome uses explicit path", () => {
    const custom = "/tmp/my-codex-home";
    const sessionId = "xyz-789";
    expect(resolveCampfireCodexSessionHome(sessionId, custom)).toBe(
      join(custom, sessionId),
    );
  });
});
