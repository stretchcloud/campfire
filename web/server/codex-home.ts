import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_CAMPFIRE_CODEX_HOME = join(
  homedir(),
  ".campfire",
  "codex-home",
);

export function getLegacyCodexHome(): string {
  return join(homedir(), ".codex");
}

export function resolveCampfireCodexHome(explicitCodexHome?: string): string {
  // Intentionally do NOT fall back to process.env.CODEX_HOME here.
  // That env var points to the user's global Codex home (~/.codex), which
  // would break per-session isolation by nesting session dirs inside it.
  return resolve(explicitCodexHome || DEFAULT_CAMPFIRE_CODEX_HOME);
}

export function resolveCampfireCodexSessionHome(
  sessionId: string,
  explicitCodexHome?: string,
): string {
  return join(resolveCampfireCodexHome(explicitCodexHome), sessionId);
}
