import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { execSync } from "node:child_process";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { containerManager } from "../container-manager.js";
import { mapContainerPath } from "../session-git-info.js";
import { homedir } from "node:os";

function execCaptureStdout(
  command: string,
  options: { cwd: string; encoding: "utf-8"; timeout: number },
): string {
  try {
    return execSync(command, options);
  } catch (err: unknown) {
    const maybe = err as { stdout?: Buffer | string };
    if (typeof maybe.stdout === "string") return maybe.stdout;
    if (maybe.stdout && Buffer.isBuffer(maybe.stdout)) {
      return maybe.stdout.toString("utf-8");
    }
    throw err;
  }
}

function resolveBranchDiffBases(repoRoot: string): string[] {
  const options = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;

  try {
    const originHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", options).trim();
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return [`origin/${match[1]}`, match[1]];
    }
  } catch {
    // No remote HEAD ref available
  }

  try {
    const branches = execSync("git branch --list main master", options).trim();
    if (branches.includes("main")) return ["main"];
    if (branches.includes("master")) return ["master"];
  } catch {
    // Ignore
  }

  return ["main"];
}

export function registerFsRoutes(api: Hono, deps: RouteDeps): void {
  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(rawPath);
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        { error: "Cannot read directory", path: basePath, dirs: [], home: homedir() },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({ name: entry.name, path: fullPath, type: "directory", children });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read file" },
        404,
      );
    }
  });

  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = resolve(filePath);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const sessionId = c.req.query("session_id") || undefined;
    let absPath = resolve(filePath);
    if (sessionId) {
      const session = deps.wsBridge.getSession(sessionId);
      const sessionCwd = session?.state.cwd;
      const launchInfo = deps.launcher.getSession(sessionId);
      const hostCwd = launchInfo?.cwd;
      const containerInfo = containerManager.getContainer(sessionId);
      if (containerInfo) {
        absPath = resolve(
          mapContainerPath(absPath, [{
            hostPath: containerInfo.hostCwd,
            containerPath: containerInfo.containerCwd,
          }]),
        );
      } else if (sessionCwd && hostCwd && sessionCwd !== hostCwd) {
        const resolvedSessionCwd = resolve(sessionCwd);
        const resolvedHostCwd = resolve(hostCwd);
        if (absPath === resolvedSessionCwd || absPath.startsWith(`${resolvedSessionCwd}/`)) {
          absPath = resolve(resolvedHostCwd, relative(resolvedSessionCwd, absPath));
        }
      }
    }
    // Optional base ref provided by the frontend (e.g. the commit at session start)
    const baseRef = c.req.query("base");
    // If "known_changed=1", the frontend asserts this file was modified by the session.
    // Enables the synthetic diff fallback when all git strategies return empty.
    const knownChanged = c.req.query("known_changed") === "1";
    const fileExists = existsSync(absPath);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const relPath = relative(repoRoot, absPath);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) {
        if (knownChanged) {
          try {
            const content = readFileSync(absPath, "utf-8");
            if (content != null) {
              const lines = content.split("\n");
              const header = [
                `diff --git a/${absPath} b/${absPath}`,
                "new file mode 100644",
                "--- /dev/null",
                `+++ b/${absPath}`,
                `@@ -0,0 +1,${lines.length} @@`,
              ];
              const diff = header.join("\n") + "\n" + lines.map((l) => `+${l}`).join("\n") + "\n";
              return c.json({ path: absPath, diff, exists: fileExists });
            }
          } catch {
            // Ignore
          }
        }
        return c.json({ path: absPath, diff: "", exists: fileExists });
      }

      const opts = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;
      let diff = "";

      // If a specific base ref was provided (e.g. session start commit), use it
      if (baseRef) {
        try {
          diff = execCaptureStdout(`git diff ${baseRef} -- "${relPath}"`, opts);
        } catch {
          // Invalid ref — fall through to other strategies
        }
      }

      // 1. Try uncommitted working-tree changes (staged + unstaged vs HEAD)
      if (!diff.trim()) {
        try {
          diff = execCaptureStdout(`git diff HEAD -- "${relPath}"`, opts);
        } catch {
          // HEAD may not exist (initial commit) — ignore
        }
      }

      // 2. Try branch-base diff (for feature branches diffing against main)
      if (!diff.trim()) {
        const diffBases = resolveBranchDiffBases(repoRoot);
        for (const base of diffBases) {
          try {
            // Use merge-base to get only the branch's own changes
            const mergeBase = execSync(`git merge-base ${base} HEAD`, opts).trim();
            if (mergeBase) {
              diff = execCaptureStdout(`git diff ${mergeBase} -- "${relPath}"`, opts);
              if (diff.trim()) break;
            }
          } catch {
            // Try next candidate
          }
        }
      }

      // 3. Check for untracked files
      if (!diff.trim()) {
        const untracked = execSync(`git ls-files --others --exclude-standard -- "${relPath}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (untracked) {
          diff = execCaptureStdout(`git diff --no-index -- /dev/null "${absPath}"`, opts);
        }
      }

      // 4. Final fallback: if the frontend asserts this file was changed but all git
      // strategies returned empty (e.g. file created and committed on the same branch),
      // generate a synthetic "new file" diff from the current file contents.
      if (!diff.trim() && knownChanged) {
        try {
          const content = readFileSync(absPath, "utf-8");
          if (content != null) {
            const lines = content.split("\n");
            const header = [
              `diff --git a/${relPath} b/${relPath}`,
              "new file mode 100644",
              "--- /dev/null",
              `+++ b/${relPath}`,
              `@@ -0,0 +1,${lines.length} @@`,
            ];
            diff = header.join("\n") + "\n" + lines.map((l) => `+${l}`).join("\n") + "\n";
          }
        } catch {
          // File doesn't exist or can't be read
        }
      }

      return c.json({ path: absPath, diff, exists: fileExists });
    } catch {
      if (knownChanged) {
        try {
          const content = readFileSync(absPath, "utf-8");
          if (content != null) {
            const lines = content.split("\n");
            const header = [
              `diff --git a/${absPath} b/${absPath}`,
              "new file mode 100644",
              "--- /dev/null",
              `+++ b/${absPath}`,
              `@@ -0,0 +1,${lines.length} @@`,
            ];
            const diff = header.join("\n") + "\n" + lines.map((l) => `+${l}`).join("\n") + "\n";
            return c.json({ path: absPath, diff, exists: fileExists });
          }
        } catch {
          // Ignore
        }
      }
      return c.json({ path: absPath, diff: "", exists: fileExists });
    }
  });

  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const resolvedCwd = resolve(cwd);

    const candidates = [
      join(resolvedCwd, "CLAUDE.md"),
      join(resolvedCwd, ".claude", "CLAUDE.md"),
    ];

    const files: { path: string; content: string }[] = [];
    for (const p of candidates) {
      try {
        const content = await readFile(p, "utf-8");
        files.push({ path: p, content });
      } catch {
        // file doesn't exist — skip
      }
    }

    return c.json({ cwd: resolvedCwd, files });
  });

  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });
}
