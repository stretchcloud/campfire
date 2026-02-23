/**
 * Git info resolution for Docker containers.
 * Runs git commands inside containers via `docker exec`.
 */

import { execSync } from "node:child_process";

export interface ContainerGitInfo {
  branch: string;
  isWorktree: boolean;
  repoRoot: string;
  ahead: number;
  behind: number;
}

/**
 * Resolve git information from inside a Docker container.
 * @param containerId Docker container ID or name
 * @param containerCwd Working directory inside the container
 * @returns Git info or null if not a git repo
 */
export function containerGitInfo(
  containerId: string,
  containerCwd: string,
): ContainerGitInfo | null {
  try {
    const branch = dockerExec(containerId, containerCwd,
      "git rev-parse --abbrev-ref HEAD").trim();

    if (!branch) return null;

    let isWorktree = false;
    try {
      const gitDir = dockerExec(containerId, containerCwd,
        "git rev-parse --git-dir").trim();
      isWorktree = gitDir.includes("/worktrees/");
    } catch { /* ignore */ }

    let repoRoot = "";
    try {
      repoRoot = dockerExec(containerId, containerCwd,
        "git rev-parse --show-toplevel").trim();
    } catch { /* ignore */ }

    let ahead = 0;
    let behind = 0;
    try {
      const counts = dockerExec(containerId, containerCwd,
        "git rev-list --left-right --count @{upstream}...HEAD").trim();
      const [b, a] = counts.split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    } catch { /* no upstream */ }

    return { branch, isWorktree, repoRoot, ahead, behind };
  } catch {
    return null;
  }
}

/**
 * Map a path inside a container to the corresponding host path.
 * @param containerPath Path inside the container
 * @param containerInfo Container metadata (mount points)
 * @returns Host path or the original container path if no mapping found
 */
export function mapContainerPath(
  containerPath: string,
  mountMappings: Array<{ hostPath: string; containerPath: string }>,
): string {
  for (const mount of mountMappings) {
    if (containerPath.startsWith(mount.containerPath)) {
      return containerPath.replace(mount.containerPath, mount.hostPath);
    }
  }
  return containerPath;
}

/** Run a command inside a Docker container and return stdout. */
function dockerExec(
  containerId: string,
  cwd: string,
  command: string,
): string {
  return execSync(`docker exec -w "${cwd}" ${containerId} ${command}`, {
    encoding: "utf-8",
    timeout: 5000,
  });
}
