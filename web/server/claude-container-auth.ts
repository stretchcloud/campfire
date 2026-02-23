/**
 * Seed Claude Code authentication into a Docker container.
 * Copies the user's ~/.claude/ directory into the container's /root/.claude/
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/**
 * Copy Claude Code auth config from host into a running container.
 * @param containerId Docker container ID or name
 * @returns true if auth was seeded successfully
 */
export function seedClaudeAuth(containerId: string): boolean {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    console.warn("[claude-container-auth] ~/.claude/ not found, skipping auth seeding");
    return false;
  }

  try {
    // Ensure target directory exists inside container
    execSync(`docker exec ${containerId} mkdir -p /root/.claude`, {
      timeout: 10_000,
    });

    // Copy host's .claude directory contents into the container
    execSync(`docker cp "${claudeDir}/." ${containerId}:/root/.claude/`, {
      timeout: 30_000,
    });

    console.log(`[claude-container-auth] Seeded Claude auth into container ${containerId}`);
    return true;
  } catch (err) {
    console.error(`[claude-container-auth] Failed to seed auth into container ${containerId}:`, err);
    return false;
  }
}
