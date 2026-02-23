/**
 * Seed Codex authentication into a Docker container.
 * Copies the user's ~/.codex/ directory into the container's /root/.codex/
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

/**
 * Copy Codex auth config from host into a running container.
 * @param containerId Docker container ID or name
 * @returns true if auth was seeded successfully
 */
export function seedCodexAuth(containerId: string): boolean {
  const codexDir = join(homedir(), ".codex");
  if (!existsSync(codexDir)) {
    console.warn("[codex-container-auth] ~/.codex/ not found, skipping auth seeding");
    return false;
  }

  try {
    // Ensure target directory exists inside container
    execSync(`docker exec ${containerId} mkdir -p /root/.codex`, {
      timeout: 10_000,
    });

    // Copy host's .codex directory contents into the container
    execSync(`docker cp "${codexDir}/." ${containerId}:/root/.codex/`, {
      timeout: 30_000,
    });

    console.log(`[codex-container-auth] Seeded Codex auth into container ${containerId}`);
    return true;
  } catch (err) {
    console.error(`[codex-container-auth] Failed to seed auth into container ${containerId}:`, err);
    return false;
  }
}
