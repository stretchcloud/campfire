import { Hono } from "hono";
import { execSync } from "node:child_process";
import { resolveBinary } from "./path-resolver.js";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { TerminalManager } from "./terminal-manager.js";
import * as envManager from "./env-manager.js";
import * as cronStore from "./cron-store.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import { containerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";
import * as settingsManager from "./settings-manager.js";
import { DEFAULT_OPENROUTER_MODEL, getSettings, updateSettings } from "./settings-manager.js";
import { getUsageLimits } from "./usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "./update-checker.js";
import { refreshServiceDefinition } from "./service.js";
import { loadRecording, filterEntries } from "./replay.js";
import * as galleryStore from "./gallery-store.js";
import * as galleryVotes from "./gallery-votes.js";
import type { GalleryFilter } from "./gallery-types.js";
import type { BackendType } from "./session-types.js";
import * as webhookStore from "./webhook-store.js";
import type { WebhookCreateInput } from "./webhook-types.js";
import * as clawhubExport from "./clawhub-export.js";

const UPDATE_CHECK_STALE_MS = 5 * 60 * 1000;

// ─── Public Replay Token Store ──────────────────────────────────────────────
// Maps short tokens to session IDs for shareable replay links.
const publicReplayTokens = new Map<string, { sessionId: string; createdAt: number }>();

function generatePublicReplayToken(sessionId: string): string {
  // Check if a token already exists for this session
  for (const [token, entry] of publicReplayTokens) {
    if (entry.sessionId === sessionId) return token;
  }
  // Generate a URL-safe random token
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
  publicReplayTokens.set(token, { sessionId, createdAt: Date.now() });
  return token;
}

function resolvePublicReplayToken(token: string): string | null {
  const entry = publicReplayTokens.get(token);
  if (!entry) return null;
  // Tokens valid for 30 days
  if (Date.now() - entry.createdAt > 30 * 24 * 60 * 60 * 1000) {
    publicReplayTokens.delete(token);
    return null;
  }
  return entry.sessionId;
}

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

function resolveBranchDiffBases(
  repoRoot: string,
): string[] {
  const options = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;

  try {
    const originHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", options).trim();
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return [`origin/${match[1]}`, match[1]];
    }
  } catch {
    // No remote HEAD ref available, fallback to common local defaults.
  }

  try {
    const branches = execSync("git branch --list main master", options).trim();
    if (branches.includes("main")) return ["main"];
    if (branches.includes("master")) return ["master"];
  } catch {
    // Ignore and use a conservative fallback below.
  }

  return ["main"];
}

export function createRoutes(
  launcher: CliLauncher,
  wsBridge: WsBridge,
  sessionStore: SessionStore,
  worktreeTracker: WorktreeTracker,
  terminalManager: TerminalManager,
  prPoller?: import("./pr-poller.js").PRPoller,
  recorder?: import("./recorder.js").RecorderManager,
  cronScheduler?: import("./cron-scheduler.js").CronScheduler,
  webhookManager?: import("./webhook-manager.js").WebhookManager,
  adapterRegistry?: import("./adapter-registry.js").AdapterRegistry,
) {
  const api = new Hono();

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const backend = body.backend ?? "claude";
      const validBackends = ["claude", "codex", "goose", "aider", "openhands", "openclaw", "opencode"];
      if (!validBackends.includes(backend)) {
        return c.json({ error: `Invalid backend: ${String(backend)}` }, 400);
      }

      // Resolve environment variables from envSlug
      let envVars: Record<string, string> | undefined = body.env;
      if (body.envSlug) {
        const companionEnv = envManager.getEnv(body.envSlug);
        if (companionEnv) {
          console.log(
            `[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
            Object.keys(companionEnv.variables).join(", "),
          );
          envVars = { ...companionEnv.variables, ...body.env };
        } else {
          console.warn(
            `[routes] Environment "${body.envSlug}" not found, ignoring`,
          );
        }
      }

      let cwd = body.cwd;
      let worktreeInfo:
        | {
            isWorktree: boolean;
            repoRoot: string;
            branch: string;
            actualBranch: string;
            worktreePath: string;
          }
        | undefined;

      // If worktree is requested, set up a worktree for the selected branch
      if (body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const result = gitUtils.ensureWorktree(
            repoInfo.repoRoot,
            body.branch,
            {
              baseBranch: repoInfo.defaultBranch,
              createBranch: body.createBranch,
              forceNew: true,
            },
          );
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: body.branch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
          };
        }
      } else if (body.branch && cwd) {
        // Non-worktree: checkout the selected branch in-place
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            throw new Error(`git fetch failed before session create: ${fetchResult.output}`);
          }

          if (repoInfo.currentBranch !== body.branch) {
            gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
          }

          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            // Don't fail session creation if pull fails (e.g. no upstream tracking)
            console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
          }
        }
      }

      // If container mode requested, create and start the container
      let containerInfo: ContainerInfo | undefined;
      if (body.container && backend === "claude") {
        const cConfig: ContainerConfig = {
          image: body.container.image || "companion-dev:latest",
          ports: Array.isArray(body.container.ports)
            ? body.container.ports.map(Number).filter((n: number) => n > 0)
            : [],
          volumes: body.container.volumes,
          env: body.container.env,
        };
        // Use cwd-based name since we don't have sessionId yet
        const containerId = crypto.randomUUID().slice(0, 8);
        containerInfo = containerManager.createContainer(containerId, cwd, cConfig);
      }

      const session = launcher.launch({
        model: body.model,
        permissionMode: body.permissionMode,
        cwd,
        claudeBinary: body.claudeBinary,
        codexBinary: body.codexBinary,
        codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
        codexSandbox: backend === "codex" && body.codexInternetAccess === true
          ? "danger-full-access"
          : "workspace-write",
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        worktreeInfo,
      });

      // Re-track container with real session ID
      if (containerInfo) {
        // The container was created with a temp ID; re-register under the real session ID
        containerManager.retrack(containerInfo.containerId, session.sessionId);
      }

      // Track the worktree mapping
      if (worktreeInfo) {
        worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/sessions", (c) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));
    const enriched = sessions.map((s) => {
      const bridge = bridgeMap.get(s.sessionId);
      return {
        ...s,
        name: names[s.sessionId] ?? s.name,
        gitBranch: bridge?.git_branch || "",
        gitAhead: bridge?.git_ahead || 0,
        gitBehind: bridge?.git_behind || 0,
        totalLinesAdded: bridge?.total_lines_added || 0,
        totalLinesRemoved: bridge?.total_lines_removed || 0,
      };
    });
    return c.json(enriched);
  });

  api.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.patch("/sessions/:id/name", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionNames.setName(id, body.name.trim());
    return c.json({ ok: true, name: body.name.trim() });
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = c.req.param("id");
    const killed = await launcher.kill(id);
    if (!killed)
      return c.json({ error: "Session not found or already exited" }, 404);

    // Clean up container if any
    containerManager.removeContainer(id);

    return c.json({ ok: true });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = c.req.param("id");
    const ok = await launcher.relaunch(id);
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Clean up worktree if no other sessions use it (force: delete is destructive)
    const worktreeResult = cleanupWorktree(id, true);

    prPoller?.unwatch(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    // Clean up worktree if no other sessions use it
    const worktreeResult = cleanupWorktree(id, body.force);

    launcher.setArchived(id, true);
    sessionStore.setArchived(id, true);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/unarchive", (c) => {
    const id = c.req.param("id");
    launcher.setArchived(id, false);
    sessionStore.setArchived(id, false);
    return c.json({ ok: true });
  });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  // GET /api/recordings/:filename — load and parse a recording for replay
  api.get("/recordings/:filename", (c) => {
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    const filename = c.req.param("filename");
    // Prevent path traversal
    if (filename.includes("/") || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(recorder.getRecordingsDir(), filename);
    try {
      const recording = loadRecording(filePath);
      // Extract outgoing browser messages — these are what the UI actually displayed
      const browserEntries = filterEntries(recording.entries, "out", "browser");
      const messages = browserEntries.map((e) => {
        try { return JSON.parse(e.raw); } catch { return null; }
      }).filter(Boolean);
      const timestamps = browserEntries.map((e) => e.ts);
      return c.json({ header: recording.header, messages, timestamps });
    } catch (err: any) {
      return c.json({ error: err?.message || "Failed to load recording" }, 404);
    }
  });

  // GET /api/sessions/:id/history — return persisted message history for replay
  api.get("/sessions/:id/history", (c) => {
    const id = c.req.param("id");
    const persisted = sessionStore.load(id);
    if (!persisted) return c.json({ error: "Session not found" }, 404);
    return c.json({
      messages: persisted.messageHistory || [],
      state: persisted.state || null,
    });
  });

  // ─── Fork ──────────────────────────────────────────────────────

  api.post("/sessions/:id/fork", async (c) => {
    const sourceId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      // 1. Get source session message history (prefer live session, fall back to store)
      const liveSession = wsBridge.getSession(sourceId);
      const persisted = sessionStore.load(sourceId);
      const sourceHistory = liveSession?.messageHistory ?? persisted?.messageHistory ?? [];
      const sourceState = liveSession?.state ?? persisted?.state ?? null;
      if (!sourceState) {
        return c.json({ error: "Source session not found" }, 404);
      }

      // 2. Truncate history to messageIndex if provided
      const messageIndex = typeof body.messageIndex === "number" ? body.messageIndex : sourceHistory.length;
      const forkedHistory = sourceHistory.slice(0, messageIndex);

      // 3. Determine backend and model
      const backend = sourceState.backend_type || "claude";
      const model = body.model || sourceState.model;
      const permissionMode = body.permissionMode || sourceState.permissionMode;
      const cwd = sourceState.cwd || process.cwd();

      // 4. Create worktree if source is git-tracked
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;
      let forkCwd = cwd;
      const repoInfo = gitUtils.getRepoInfo(cwd);
      if (repoInfo) {
        const branchName = body.branch || repoInfo.currentBranch || "main";
        const result = gitUtils.ensureWorktree(repoInfo.repoRoot, branchName, {
          baseBranch: repoInfo.defaultBranch,
          createBranch: true,
          forceNew: true,
        });
        forkCwd = result.worktreePath;
        worktreeInfo = {
          isWorktree: true,
          repoRoot: repoInfo.repoRoot,
          branch: branchName,
          actualBranch: result.actualBranch,
          worktreePath: result.worktreePath,
        };
      }

      // 5. Launch new session
      const session = launcher.launch({
        model,
        permissionMode,
        cwd: forkCwd,
        backendType: backend,
        worktreeInfo,
      });

      // 6. Track worktree
      if (worktreeInfo) {
        worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      // 7. Seed message history so browsers joining the fork see the conversation
      wsBridge.seedMessageHistory(session.sessionId, forkedHistory);

      return c.json({ ...session, forkedFrom: sourceId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to fork session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── Invite links ─────────────────────────────────────────────

  api.post("/sessions/:id/invite", async (c) => {
    const id = c.req.param("id");
    let role: "owner" | "collaborator" | "spectator" = "collaborator";
    try {
      const body = await c.req.json();
      if (body.role === "spectator" || body.role === "collaborator" || body.role === "owner") {
        role = body.role;
      }
    } catch { /* no body, use default */ }
    const token = wsBridge.createInviteToken(id, role);
    if (!token) return c.json({ error: "Session not found" }, 404);

    const protocol = c.req.header("x-forwarded-proto") || "http";
    const host = c.req.header("host") || "localhost:3456";
    const url = `${protocol}://${host}/#/join/${token}`;
    return c.json({ token, url, role });
  });

  api.get("/sessions/join/:token", (c) => {
    const token = c.req.param("token");
    const sessionId = wsBridge.resolveInviteToken(token);
    if (!sessionId) return c.json({ error: "Invalid or expired invite token" }, 404);
    const role = wsBridge.resolveInviteTokenRole(token) || "collaborator";
    return c.json({ session_id: sessionId, token, role });
  });

  // ─── Voting policy ──────────────────────────────────────────

  api.get("/voting-policy", (c) => {
    return c.json({ policy: wsBridge.getVotingPolicy() });
  });

  api.put("/voting-policy", async (c) => {
    const body = await c.req.json();
    const policy = body.policy;
    if (policy !== "majority-rules" && policy !== "any-deny-blocks" && policy !== "owner-decides") {
      return c.json({ error: "Invalid policy. Must be: majority-rules, any-deny-blocks, or owner-decides" }, 400);
    }
    wsBridge.setVotingPolicy(policy);
    return c.json({ policy });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary("claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary("codex") !== null });
    backends.push({ id: "goose", name: "Goose", available: resolveBinary("goose") !== null });
    backends.push({ id: "aider", name: "Aider", available: resolveBinary("aider") !== null });
    backends.push({ id: "openhands", name: "OpenHands", available: resolveBinary("openhands") !== null });
    backends.push({ id: "openclaw", name: "OpenClaw", available: resolveBinary("openclaw") !== null });
    backends.push({ id: "opencode", name: "OpenCode", available: resolveBinary("opencode") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!existsSync(cachePath)) {
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = readFileSync(cachePath, "utf-8");
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Only return visible models, sorted by priority
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((m) => ({
            value: m.slug,
            label: m.display_name || m.slug,
            description: m.description || "",
          }));
        return c.json(models);
      } catch (e) {
        return c.json({ error: "Failed to parse Codex models cache" }, 500);
      }
    }

    // Claude models are hardcoded on the frontend
    return c.json({ error: "Use frontend defaults for this backend" }, 404);
  });

  // ─── Containers ─────────────────────────────────────────────────

  api.get("/containers/status", (c) => {
    const available = containerManager.checkDocker();
    const version = containerManager.getDockerVersion();
    return c.json({ available, version });
  });

  api.get("/containers/images", (c) => {
    const images = containerManager.listImages();
    return c.json(images);
  });

  // ─── Filesystem browsing ─────────────────────────────────────

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
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  // ─── Editor filesystem APIs ─────────────────────────────────────

  /** Recursive directory tree for the editor file explorer */
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
      if (depth > 10) return []; // Safety limit
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
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

  /** Read a single file */
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

  /** Write a single file */
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

  /** Git diff for a single file (unified diff) */
  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const relPath = execSync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || absPath;

      let diff = "";
      const diffBases = resolveBranchDiffBases(repoRoot);
      for (const base of diffBases) {
        try {
          diff = execCaptureStdout(`git diff ${base} -- "${relPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
          break;
        } catch {
          // If a base ref is unavailable, try the next candidate.
        }
      }

      // For untracked files, base-branch diff is empty. Show full file as added.
      if (!diff.trim()) {
        const untracked = execSync(`git ls-files --others --exclude-standard -- "${relPath}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (untracked) {
          diff = execCaptureStdout(`git diff --no-index -- /dev/null "${absPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        }
      }

      return c.json({ path: absPath, diff });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /** Find CLAUDE.md files for a project (root + .claude/) */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    // Resolve to absolute path to prevent path traversal
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

  /** Create or update a CLAUDE.md file */
  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    // Only allow writing CLAUDE.md files
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    // Verify the resolved path ends with CLAUDE.md or .claude/CLAUDE.md
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      // Ensure parent directory exists
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

  // ─── Environments (~/.companion/envs/) ────────────────────────────

  api.get("/envs", (c) => {
    try {
      return c.json(envManager.listEnvs());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/envs/:slug", (c) => {
    const env = envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json(env);
  });

  api.post("/envs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.createEnv(body.name, body.variables || {});
      return c.json(env, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/envs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = envManager.updateEnv(slug, {
        name: body.name,
        variables: body.variables,
      });
      if (!env) return c.json({ error: "Environment not found" }, 404);
      return c.json(env);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/envs/:slug", (c) => {
    const deleted = envManager.deleteEnv(c.req.param("slug"));
    if (!deleted) return c.json({ error: "Environment not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Settings (~/.companion/settings.json) ────────────────────────

  api.get("/settings", (c) => {
    const settings = getSettings();
    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
      moltbookApiKeyConfigured: !!settings.moltbookApiKey?.trim(),
      linearApiKeyConfigured: !!settings.linearApiKey?.trim(),
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.openrouterApiKey !== undefined && typeof body.openrouterApiKey !== "string") {
      return c.json({ error: "openrouterApiKey must be a string" }, 400);
    }
    if (body.openrouterModel !== undefined && typeof body.openrouterModel !== "string") {
      return c.json({ error: "openrouterModel must be a string" }, 400);
    }
    if (body.moltbookApiKey !== undefined && typeof body.moltbookApiKey !== "string") {
      return c.json({ error: "moltbookApiKey must be a string" }, 400);
    }
    if (body.linearApiKey !== undefined && typeof body.linearApiKey !== "string") {
      return c.json({ error: "linearApiKey must be a string" }, 400);
    }
    if (
      body.openrouterApiKey === undefined &&
      body.openrouterModel === undefined &&
      body.moltbookApiKey === undefined &&
      body.linearApiKey === undefined
    ) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    const settings = updateSettings({
      openrouterApiKey:
        typeof body.openrouterApiKey === "string"
          ? body.openrouterApiKey.trim()
          : undefined,
      openrouterModel:
        typeof body.openrouterModel === "string"
          ? (body.openrouterModel.trim() || DEFAULT_OPENROUTER_MODEL)
          : undefined,
      moltbookApiKey:
        typeof body.moltbookApiKey === "string"
          ? body.moltbookApiKey.trim()
          : undefined,
      linearApiKey:
        typeof body.linearApiKey === "string"
          ? body.linearApiKey.trim()
          : undefined,
    });

    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
      moltbookApiKeyConfigured: !!settings.moltbookApiKey?.trim(),
      linearApiKeyConfigured: !!settings.linearApiKey?.trim(),
    });
  });

  // ─── Git operations ─────────────────────────────────────────────────

  api.get("/git/repo-info", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const info = gitUtils.getRepoInfo(path);
    if (!info) return c.json({ error: "Not a git repository" }, 400);
    return c.json(info);
  });

  api.get("/git/branches", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    try {
      return c.json(gitUtils.listBranches(repoRoot));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/git/worktrees", (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    try {
      return c.json(gitUtils.listWorktrees(repoRoot));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.post("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, branch, baseBranch, createBranch } = body;
    if (!repoRoot || !branch)
      return c.json({ error: "repoRoot and branch required" }, 400);
    try {
      const result = gitUtils.ensureWorktree(repoRoot, branch, {
        baseBranch,
        createBranch,
      });
      return c.json(result);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, worktreePath, force } = body;
    if (!repoRoot || !worktreePath)
      return c.json({ error: "repoRoot and worktreePath required" }, 400);
    const result = gitUtils.removeWorktree(repoRoot, worktreePath, { force });
    return c.json(result);
  });

  api.post("/git/fetch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot } = body;
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(gitUtils.gitFetch(repoRoot));
  });

  api.post("/git/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const result = gitUtils.gitPull(cwd);
    // Return refreshed ahead/behind counts
    let git_ahead = 0,
      git_behind = 0;
    try {
      const counts = execSync(
        "git rev-list --left-right --count @{upstream}...HEAD",
        {
          cwd,
          encoding: "utf-8",
          timeout: 3000,
        },
      ).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      git_ahead = ahead || 0;
      git_behind = behind || 0;
    } catch {
      /* no upstream */
    }
    return c.json({ ...result, git_ahead, git_behind });
  });

  // ─── GitHub PR Status ────────────────────────────────────────────────

  api.get("/git/pr-status", async (c) => {
    const cwd = c.req.query("cwd");
    const branch = c.req.query("branch");
    if (!cwd || !branch) return c.json({ error: "cwd and branch required" }, 400);

    // Check poller cache first for instant response
    if (prPoller) {
      const cached = prPoller.getCached(cwd, branch);
      if (cached) return c.json(cached);
    }

    const { isGhAvailable, fetchPRInfoAsync } = await import("./github-pr.js");
    if (!isGhAvailable()) {
      return c.json({ available: false, pr: null });
    }

    const pr = await fetchPRInfoAsync(cwd, branch);
    return c.json({ available: true, pr });
  });

  // ─── Usage Limits ─────────────────────────────────────────────────────

  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        return {
          utilization: l.usedPercent,
          resets_at: l.resetsAt ? new Date(l.resetsAt * 1000).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    // Claude sessions: use existing logic
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  // ─── Update checking ─────────────────────────────────────────────────

  api.get("/update-check", async (c) => {
    const initialState = getUpdateState();
    const needsRefresh =
      initialState.lastChecked === 0
      || Date.now() - initialState.lastChecked > UPDATE_CHECK_STALE_MS;
    if (needsRefresh) {
      await checkForUpdate();
    }

    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
    });
  });

  api.post("/update-check", async (c) => {
    await checkForUpdate();
    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
    });
  });

  api.post("/update", async (c) => {
    const state = getUpdateState();
    if (!state.isServiceMode) {
      return c.json(
        { error: "Update & restart is only available in service mode" },
        400,
      );
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    // Respond immediately, then perform update async
    setTimeout(async () => {
      try {
        console.log(
          `[update] Updating the-companion to ${state.latestVersion}...`,
        );
        const proc = Bun.spawn(
          ["bun", "install", "-g", `the-companion@${state.latestVersion}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          console.error(
            `[update] bun install failed (code ${exitCode}):`,
            stderr,
          );
          setUpdateInProgress(false);
          return;
        }

        // Refresh the service definition so the new unit/plist template
        // (e.g. Restart=always) takes effect for existing installations.
        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }

        console.log(
          "[update] Update successful, restarting service...",
        );

        // Explicitly restart via the service manager in a detached process
        // so the restart survives our own exit.
        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-companion.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.thecompanion.app`]
            : ["launchctl", "kickstart", "-k", "sh.thecompanion.app"];

        Bun.spawn(restartCmd, {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: isLinux
            ? {
                ...process.env,
                XDG_RUNTIME_DIR:
                  process.env.XDG_RUNTIME_DIR ||
                  `/run/user/${uid ?? 1000}`,
              }
            : undefined,
        });

        // Give the spawn a moment to dispatch, then exit cleanly.
        // The service manager restart will kill us if we haven't exited yet.
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[update] Update failed:", err);
        setUpdateInProgress(false);
      }
    }, 100);

    return c.json({
      ok: true,
      message: "Update started. Server will restart shortly.",
    });
  });

  // ─── Helper ─────────────────────────────────────────────────────────

  function cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    // Check if any other sessions still use this worktree
    if (worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    // Auto-remove if clean, or force-remove if requested
    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      console.log(
        `[routes] Worktree ${mapping.worktreePath} is dirty, not auto-removing`,
      );
      // Keep the mapping so the worktree remains trackable
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    // Delete the companion-managed branch if it differs from the conceptual branch
    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(
      mapping.repoRoot,
      mapping.worktreePath,
      { force: dirty, branchToDelete },
    );
    if (result.removed) {
      // Only remove the mapping after successful cleanup
      worktreeTracker.removeBySession(sessionId);
      console.log(
        `[routes] ${dirty ? "Force-removed dirty" : "Auto-removed clean"} worktree ${mapping.worktreePath}`,
      );
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  // ─── Terminal ──────────────────────────────────────────────────────

  api.get("/terminal", (c) => {
    const info = terminalManager.getInfo();
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = terminalManager.spawn(body.cwd, body.cols, body.rows);
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", (c) => {
    terminalManager.kill();
    return c.json({ ok: true });
  });

  // ─── Cron Jobs ──────────────────────────────────────────────────────

  api.get("/cron/jobs", (c) => {
    const jobs = cronStore.listJobs();
    const enriched = jobs.map((j) => ({
      ...j,
      nextRunAt: cronScheduler?.getNextRunTime(j.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/cron/jobs/:id", (c) => {
    const job = cronStore.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({
      ...job,
      nextRunAt: cronScheduler?.getNextRunTime(job.id)?.getTime() ?? null,
    });
  });

  api.post("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const job = cronStore.createJob({
        name: body.name || "",
        prompt: body.prompt || "",
        schedule: body.schedule || "",
        recurring: body.recurring ?? true,
        backendType: body.backendType || "claude",
        model: body.model || "",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        enabled: body.enabled ?? true,
        permissionMode: body.permissionMode || "bypassPermissions",
        codexInternetAccess: body.codexInternetAccess,
      });
      if (job.enabled) cronScheduler?.scheduleJob(job);
      return c.json(job, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      // Only allow user-editable fields — prevent tampering with internal tracking
      const allowed: Record<string, unknown> = {};
      for (const key of ["name", "prompt", "schedule", "recurring", "backendType", "model", "cwd", "envSlug", "enabled", "permissionMode", "codexInternetAccess"] as const) {
        if (key in body) allowed[key] = body[key];
      }
      const job = cronStore.updateJob(id, allowed);
      if (!job) return c.json({ error: "Job not found" }, 404);
      // Stop the old timer (id may differ from job.id after a rename)
      if (job.id !== id) cronScheduler?.stopJob(id);
      cronScheduler?.scheduleJob(job);
      return c.json(job);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/cron/jobs/:id", (c) => {
    const id = c.req.param("id");
    cronScheduler?.stopJob(id);
    const deleted = cronStore.deleteJob(id);
    if (!deleted) return c.json({ error: "Job not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/cron/jobs/:id/toggle", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    const updated = cronStore.updateJob(id, { enabled: !job.enabled });
    if (updated?.enabled) {
      cronScheduler?.scheduleJob(updated);
    } else {
      cronScheduler?.stopJob(id);
    }
    return c.json(updated);
  });

  api.post("/cron/jobs/:id/run", (c) => {
    const id = c.req.param("id");
    const job = cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    cronScheduler?.executeJobManually(id);
    return c.json({ ok: true, message: "Job triggered" });
  });

  api.get("/cron/jobs/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(cronScheduler?.getExecutions(id) ?? []);
  });

  // ─── Gallery ──────────────────────────────────────────────────────────

  api.get("/gallery", (c) => {
    const filter: GalleryFilter = {};
    const backend = c.req.query("backend");
    if (backend) filter.backend = backend as BackendType;
    const minCost = c.req.query("minCost");
    if (minCost) filter.minCost = Number(minCost);
    const maxCost = c.req.query("maxCost");
    if (maxCost) filter.maxCost = Number(maxCost);
    const tags = c.req.query("tags");
    if (tags) filter.tags = tags.split(",").filter(Boolean);
    const featured = c.req.query("featured");
    if (featured === "true") filter.featuredOnly = true;
    const sortBy = c.req.query("sortBy");
    if (sortBy) filter.sortBy = sortBy as GalleryFilter["sortBy"];
    const sortOrder = c.req.query("sortOrder");
    if (sortOrder) filter.sortOrder = sortOrder as "asc" | "desc";

    return c.json(galleryStore.listEntries(filter));
  });

  api.get("/gallery/:id", (c) => {
    const entry = galleryStore.getEntry(c.req.param("id"));
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
    return c.json(entry);
  });

  api.post("/gallery", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { sessionId, name, description, tags } = body;

    if (!sessionId || !name) {
      return c.json({ error: "sessionId and name are required" }, 400);
    }

    // Get session metadata for snapshot
    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    try {
      const entry = galleryStore.createEntry(
        { sessionId, name, description: description || "", tags: tags || [] },
        {
          backendType: session.backendType,
          model: session.model,
          totalCostUsd: wsBridge.getSession(sessionId)?.state.total_cost_usd,
          totalLinesAdded: session.totalLinesAdded,
          totalLinesRemoved: session.totalLinesRemoved,
          numTurns: wsBridge.getSession(sessionId)?.state.num_turns,
          repoRoot: session.repoRoot,
          durationMs: Date.now() - session.createdAt,
        },
      );
      return c.json(entry, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  api.put("/gallery/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const entry = galleryStore.updateEntry(id, body);
      if (!entry) return c.json({ error: "Gallery entry not found" }, 404);
      return c.json(entry);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  api.delete("/gallery/:id", (c) => {
    const id = c.req.param("id");
    const deleted = galleryStore.deleteEntry(id);
    if (!deleted) return c.json({ error: "Gallery entry not found" }, 404);
    galleryVotes.removeEntryVotes(id);
    return c.json({ ok: true });
  });

  api.post("/gallery/:id/vote", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    // Use forwarded IP or remote address for voter hash
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "anonymous";
    const voterId = galleryVotes.getVoterHash(ip);
    const direction = body.direction === -1 ? -1 : 1;

    const newTotal = galleryVotes.recordVote(id, voterId, direction as 1 | -1);
    galleryStore.updateEntry(id, { votes: newTotal });

    return c.json({ votes: newTotal });
  });

  api.post("/gallery/:id/feature", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    const updated = galleryStore.updateEntry(id, { featured: !entry.featured });
    return c.json(updated);
  });

  // ─── ClawHub Integration ────────────────────────────────────────────

  /** Check if the clawhub CLI is available on PATH. */
  api.get("/clawhub/status", (c) => {
    return c.json({ available: clawhubExport.checkClawHubAvailable() });
  });

  /** Export a gallery entry to ClawHub as a skill. */
  api.post("/gallery/:id/export-clawhub", async (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed. Run: npm install -g clawhub" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));

    const result = clawhubExport.exportToClawHub(entry, {
      campfireBaseUrl: body.campfireBaseUrl,
      prompt: body.prompt,
      dryRun: body.dryRun === true,
    });

    if (result.success) {
      return c.json({ ok: true, skillDir: result.skillDir, output: result.output });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  /** Preview SKILL.md content without publishing. */
  api.get("/gallery/:id/skill-preview", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    const markdown = clawhubExport.generateSkillMd(entry, {
      campfireBaseUrl: c.req.query("baseUrl"),
    });
    return c.json({ markdown });
  });

  /** Search ClawHub skills. */
  api.get("/clawhub/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "query parameter 'q' is required" }, 400);

    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed" }, 400);
    }

    const results = clawhubExport.searchClawHub(query);
    return c.json(results);
  });

  /** Install a ClawHub skill by slug. */
  api.post("/clawhub/install", async (c) => {
    if (!clawhubExport.checkClawHubAvailable()) {
      return c.json({ error: "clawhub CLI is not installed" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const slug = body.slug;
    if (!slug) return c.json({ error: "slug is required" }, 400);

    const result = clawhubExport.installClawHubSkill(slug);
    if (result.success) {
      return c.json({ ok: true, output: result.output });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  // ─── Moltbook Integration ──────────────────────────────────────────

  /** Check Moltbook API key status. */
  api.get("/moltbook/status", async (c) => {
    const { moltbookApiKey } = settingsManager.getSettings();
    const moltbook = await import("./moltbook-client.js");
    const status = await moltbook.checkMoltbookStatus(moltbookApiKey);
    return c.json(status);
  });

  /** Post a gallery entry to Moltbook. */
  api.post("/gallery/:id/post-moltbook", async (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    const { moltbookApiKey } = settingsManager.getSettings();
    if (!moltbookApiKey) {
      return c.json({ error: "Moltbook API key not configured. Add it in Settings." }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const baseUrl = body.campfireBaseUrl || `http://localhost:3456`;
    const replayUrl = `${baseUrl}/#/replay/session/${entry.sessionId}`;

    // Build the post content from gallery entry metadata
    const costStr = entry.totalCostUsd > 0 ? `$${entry.totalCostUsd.toFixed(2)}` : "free";
    const durationMin = Math.round(entry.durationMs / 60_000);
    const content = [
      entry.description || `Session: ${entry.name}`,
      "",
      `**Backend:** ${entry.backendType} | **Model:** ${entry.model} | **Cost:** ${costStr} | **Duration:** ${durationMin}m | **Turns:** ${entry.numTurns}`,
      "",
      entry.tags.length > 0 ? `Tags: ${entry.tags.join(", ")}` : "",
    ].filter(Boolean).join("\n");

    const moltbook = await import("./moltbook-client.js");
    const result = await moltbook.postToMoltbook({
      apiKey: moltbookApiKey,
      title: entry.name,
      content,
      replayUrl,
      submolt: body.submolt || "general",
    });

    if (result.ok) {
      return c.json({ ok: true, postUrl: result.postUrl, postId: result.postId });
    }
    return c.json({ ok: false, error: result.error }, 500);
  });

  // ─── Public Replay ────────────────────────────────────────────────

  /** Generate a public replay token for a gallery entry's session. */
  api.post("/gallery/:id/public-link", (c) => {
    const id = c.req.param("id");
    const entry = galleryStore.getEntry(id);
    if (!entry) return c.json({ error: "Gallery entry not found" }, 404);

    // Generate a token that maps to this session ID
    const token = generatePublicReplayToken(entry.sessionId);
    return c.json({ token, url: `/#/public-replay/${token}` });
  });

  /** Resolve a public replay token to session history (no auth required). */
  api.get("/public-replay/:token", (c) => {
    const token = c.req.param("token");
    const sessionId = resolvePublicReplayToken(token);
    if (!sessionId) {
      return c.json({ error: "Invalid or expired replay link" }, 404);
    }

    const persisted = sessionStore.load(sessionId);
    if (!persisted) return c.json({ error: "Session data not found" }, 404);

    // Return session history + gallery entry metadata if available
    const entries = galleryStore.listEntries();
    const galleryEntry = entries.find((e) => e.sessionId === sessionId);

    return c.json({
      messages: persisted.messageHistory || [],
      state: persisted.state || null,
      gallery: galleryEntry
        ? {
            name: galleryEntry.name,
            description: galleryEntry.description,
            backendType: galleryEntry.backendType,
            model: galleryEntry.model,
            totalCostUsd: galleryEntry.totalCostUsd,
            durationMs: galleryEntry.durationMs,
            numTurns: galleryEntry.numTurns,
            tags: galleryEntry.tags,
          }
        : null,
    });
  });

  // ─── Webhooks ──────────────────────────────────────────────────────

  api.get("/webhooks", (c) => {
    return c.json(webhookStore.listWebhooks());
  });

  api.get("/webhooks/:id", (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);
    return c.json(webhook);
  });

  api.post("/webhooks", async (c) => {
    const data = await c.req.json() as WebhookCreateInput;
    try {
      const webhook = webhookStore.createWebhook(data);
      return c.json(webhook, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.put("/webhooks/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json();
    try {
      const webhook = webhookStore.updateWebhook(id, updates);
      if (!webhook) return c.json({ error: "Webhook not found" }, 404);
      return c.json(webhook);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.delete("/webhooks/:id", (c) => {
    const id = c.req.param("id");
    const deleted = webhookStore.deleteWebhook(id);
    if (!deleted) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/webhooks/:id/toggle", (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);
    const updated = webhookStore.updateWebhook(id, { enabled: !webhook.enabled });
    return c.json(updated);
  });

  api.post("/webhooks/:id/test", async (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);

    if (webhookManager) {
      webhookManager.emit("session.completed", "test-session", {
        backendType: "claude",
        model: "claude-sonnet-4-5-20250929",
        totalCostUsd: 0.05,
        numTurns: 3,
        isError: false,
        test: true,
      });
    }
    return c.json({ ok: true });
  });

  // ─── OpenClaw Inbound Webhook ───────────────────────────────────

  /**
   * Receives webhooks from OpenClaw and auto-creates a Campfire session.
   * OpenClaw posts to this endpoint when an agent hook fires,
   * enabling bidirectional event flow between Campfire and OpenClaw.
   *
   * Expected payload (subset of OpenClaw /hooks/agent format):
   *   { message: string, name?: string, model?: string, cwd?: string }
   *
   * Authentication: Bearer token in Authorization header,
   *   validated against CAMPFIRE_OPENCLAW_TOKEN env var.
   */
  api.post("/webhooks/openclaw", async (c) => {
    // Validate token if CAMPFIRE_OPENCLAW_TOKEN is set
    const expectedToken = process.env.CAMPFIRE_OPENCLAW_TOKEN;
    if (expectedToken) {
      const authHeader = c.req.header("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== expectedToken) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
    }

    try {
      const body = await c.req.json() as {
        message?: string;
        name?: string;
        model?: string;
        cwd?: string;
      };

      if (!body.message || !body.message.trim()) {
        return c.json({ ok: false, error: "message is required" }, 400);
      }

      const cwd = body.cwd || process.env.HOME || "/";

      // Create a new session using the openclaw backend
      const session = launcher.launch({
        model: body.model || "default",
        permissionMode: "bypassPermissions",
        cwd,
        backendType: "openclaw",
        env: {},
      });

      // Inject the message as a prompt after a brief delay for initialization
      setTimeout(() => {
        wsBridge.injectUserMessage(session.sessionId, body.message!.trim());
      }, 2000);

      console.log(`[routes] OpenClaw inbound webhook → created session ${session.sessionId} with prompt: "${body.message.trim().slice(0, 80)}..."`);

      return c.json({
        ok: true,
        sessionId: session.sessionId,
        name: body.name || "OpenClaw Hook",
      }, 202);
    } catch (err) {
      console.error("[routes] OpenClaw inbound webhook error:", err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── OpenClaw Channel Inbound ────────────────────────────────────

  /**
   * Receives agent messages from the OpenClaw channel plugin.
   * When OpenClaw sends a response through the Campfire channel,
   * it POSTs here to inject the message into the browser session.
   */
  api.post("/openclaw/inbound", async (c) => {
    try {
      const body = await c.req.json() as {
        sessionId?: string;
        senderId?: string;
        text?: string;
        metadata?: Record<string, unknown>;
      };

      if (!body.sessionId || !body.text) {
        return c.json({ ok: false, error: "sessionId and text are required" }, 400);
      }

      // Inject the agent message into the browser session via WsBridge
      wsBridge.injectAgentMessage(body.sessionId, body.text, body.metadata);

      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Adapter Registry ─────────────────────────────────────────────

  api.get("/adapters", (c) => {
    if (!adapterRegistry) return c.json([]);
    return c.json(adapterRegistry.listInstalled());
  });

  api.post("/adapters/install", async (c) => {
    if (!adapterRegistry) return c.json({ error: "Adapter registry not available" }, 500);
    const { npmPackage } = await c.req.json() as { npmPackage: string };
    if (!npmPackage) return c.json({ error: "npmPackage is required" }, 400);

    try {
      const adapter = await adapterRegistry.install(npmPackage);
      return c.json(adapter, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.delete("/adapters/:name", (c) => {
    if (!adapterRegistry) return c.json({ error: "Adapter registry not available" }, 500);
    const name = c.req.param("name");
    const removed = adapterRegistry.uninstall(name);
    if (!removed) return c.json({ error: "Adapter not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Collective Intelligence: Semantic Memory ──────────────────────────────

  api.get("/sessions/:id/memory", async (c) => {
    const { queryFragments, getConsolidatedKnowledge, getSessionFragments } = await import("./semantic-memory.js");
    const sessionId = c.req.param("id");
    const [fragments, consolidated] = await Promise.all([
      getSessionFragments(sessionId),
      getConsolidatedKnowledge(""), // cross-session consolidated
    ]);
    return c.json({ fragments, consolidated });
  });

  api.post("/sessions/:id/memory", async (c) => {
    const { storeFragment } = await import("./semantic-memory.js");
    const sessionId = c.req.param("id");
    const body = await c.req.json() as { content: string; type: string; tags?: string[]; gitContext?: Record<string, unknown> };
    if (!body.content) return c.json({ error: "content is required" }, 400);
    const fragment = await storeFragment({
      sessionId,
      agentId: "human",
      backendType: "claude",
      type: (body.type as "observation" | "hypothesis" | "decision" | "pattern") ?? "observation",
      content: body.content,
      tags: body.tags ?? [],
      gitContext: (body.gitContext as unknown as import("./semantic-memory.js").GitContext) ?? { branch: "unknown", files: [], repoRoot: "" },
    });
    return c.json({ fragment }, 201);
  });

  api.get("/sessions/:id/memory/query", async (c) => {
    const { queryFragments } = await import("./semantic-memory.js");
    const sessionId = c.req.param("id");
    const q = c.req.query("q") ?? "";
    const limit = parseInt(c.req.query("limit") ?? "10", 10);
    const results = await queryFragments(q, { sessionId, limit });
    return c.json({ results });
  });

  api.post("/sessions/:id/memory/consolidate", async (c) => {
    const { consolidateSession } = await import("./semantic-memory.js");
    const sessionId = c.req.param("id");
    const session = wsBridge.getSession(sessionId);
    const repoRoot = session?.state.cwd ?? "";
    const consolidated = await consolidateSession(sessionId, repoRoot);
    return c.json({ consolidated, count: consolidated.length });
  });

  api.get("/memory/global", async (c) => {
    const { getConsolidatedKnowledge } = await import("./semantic-memory.js");
    const tag = c.req.query("tag");
    const knowledge = await getConsolidatedKnowledge("", tag);
    return c.json({ knowledge });
  });

  // ─── Collective Intelligence: Deliberation ─────────────────────────────────

  api.get("/sessions/:id/deliberations", (c) => {
    const { deliberationEngine } = require("./deliberation-engine.js") as typeof import("./deliberation-engine.js");
    const sessionId = c.req.param("id");
    const active = deliberationEngine.getActiveProposals(sessionId);
    return c.json({ active, resolved: [] });
  });

  api.get("/sessions/:id/deliberations/:proposalId", (c) => {
    const { deliberationEngine } = require("./deliberation-engine.js") as typeof import("./deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const proposal = deliberationEngine.getProposal(proposalId);
    if (!proposal) return c.json({ error: "Not found" }, 404);
    const responses = deliberationEngine.getResponses(proposalId);
    return c.json({ proposal, responses });
  });

  api.post("/sessions/:id/deliberations/:proposalId/respond", async (c) => {
    const { deliberationEngine } = await import("./deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const body = await c.req.json() as { stance: string; reasoning: string; suggestedAlternative?: string; concerns?: string[] };
    const response = deliberationEngine.addResponse({
      proposalId,
      responderId: "human",
      responderType: "human",
      timestamp: Date.now(),
      stance: body.stance as "agree" | "disagree" | "suggest_alternative" | "abstain",
      reasoning: body.reasoning,
      suggestedAlternative: body.suggestedAlternative,
      concerns: body.concerns,
    });
    if (!response) return c.json({ error: "Proposal not found or already resolved" }, 404);
    return c.json({ response });
  });

  api.post("/sessions/:id/deliberations/:proposalId/resolve", async (c) => {
    const { deliberationEngine } = await import("./deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const resolution = deliberationEngine.resolveById(proposalId);
    if (!resolution) return c.json({ error: "Proposal not found or already resolved" }, 404);
    return c.json({ resolution });
  });

  // ─── Collective Intelligence: Capability Routing ───────────────────────────

  api.post("/sessions/route-task", async (c) => {
    const { capabilityDiscovery } = await import("./capability-discovery.js");
    const body = await c.req.json() as { taskDescription: string; availableSessions?: string[]; constraints?: Record<string, unknown> };
    if (!body.taskDescription) return c.json({ error: "taskDescription is required" }, 400);
    // If no sessions specified, use all connected sessions
    const available = body.availableSessions ?? wsBridge.getConnectedSessionIds();
    const result = await capabilityDiscovery.route({
      taskDescription: body.taskDescription,
      availableSessions: available,
      constraints: body.constraints as Record<string, unknown>,
    });
    return c.json(result);
  });

  api.get("/capabilities", async (c) => {
    const { capabilityDiscovery } = await import("./capability-discovery.js");
    return c.json({ sessions: capabilityDiscovery.getAllCapabilities() });
  });

  api.get("/capabilities/history", async (c) => {
    const { capabilityDiscovery } = await import("./capability-discovery.js");
    const backendType = c.req.query("backendType") as import("./session-types.js").BackendType | undefined;
    const taskType = c.req.query("taskType");
    const executions = capabilityDiscovery.getExecutionHistory({ backendType, taskType });
    const total = executions.length;
    const successes = executions.filter((e) => e.outcome === "success").length;
    return c.json({ executions, successRate: total > 0 ? successes / total : 0, total });
  });

  api.post("/capabilities/feedback", async (c) => {
    const { capabilityDiscovery } = await import("./capability-discovery.js");
    const body = await c.req.json() as { sessionId: string; taskId: string; feedback: "positive" | "negative" | "neutral"; backendType?: string; taskDescription?: string };
    capabilityDiscovery.recordFeedback(body.taskId, body.sessionId, (body.backendType as import("./session-types.js").BackendType) ?? "claude", body.taskDescription ?? "", body.feedback);
    return c.json({ ok: true });
  });

  // ─── Collective Intelligence: Shared Context ───────────────────────────────

  api.get("/sessions/:id/context/stream", (c) => {
    const { sharedContextManager } = require("./shared-context.js") as typeof import("./shared-context.js");
    const sessionId = c.req.param("id");
    const stream = sharedContextManager.get(sessionId);
    return c.json({ fragments: stream?.getAllFragments() ?? [] });
  });

  api.get("/sessions/:id/context/consensus", (c) => {
    const { sharedContextManager } = require("./shared-context.js") as typeof import("./shared-context.js");
    const sessionId = c.req.param("id");
    const stream = sharedContextManager.get(sessionId);
    if (!stream) return c.json({ error: "No active context stream for this session" }, 404);
    return c.json(stream.getConsensusState());
  });

  api.get("/sessions/:id/context/thread/:fragmentId", (c) => {
    const { sharedContextManager } = require("./shared-context.js") as typeof import("./shared-context.js");
    const sessionId = c.req.param("id");
    const fragmentId = c.req.param("fragmentId");
    const stream = sharedContextManager.get(sessionId);
    if (!stream) return c.json({ error: "No active context stream for this session" }, 404);
    const thread = stream.getThread(fragmentId);
    return c.json({ thread });
  });

  // ─── Prompt Library ─────────────────────────────────────────────────

  api.get("/prompts", async (c) => {
    const { listPrompts } = await import("./prompt-manager.js");
    const cwd = c.req.query("cwd");
    return c.json(listPrompts(cwd ? { cwd } : undefined));
  });

  api.post("/prompts", async (c) => {
    const { createPrompt } = await import("./prompt-manager.js");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const scope = body.scope === "project" ? "project" : "global";
    const projectPath = scope === "project" && typeof body.projectPath === "string" ? body.projectPath : undefined;
    const prompt = createPrompt(body.name.trim(), body.content.trim(), scope, projectPath);
    return c.json(prompt, 201);
  });

  api.put("/prompts/:id", async (c) => {
    const { updatePrompt } = await import("./prompt-manager.js");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.content === "string") updates.content = body.content.trim();
    if (body.scope === "global" || body.scope === "project") updates.scope = body.scope;
    if (typeof body.projectPath === "string") updates.projectPath = body.projectPath;
    const updated = updatePrompt(id, updates as Parameters<typeof updatePrompt>[1]);
    if (!updated) return c.json({ error: "Prompt not found" }, 404);
    return c.json(updated);
  });

  api.delete("/prompts/:id", async (c) => {
    const { deletePrompt } = await import("./prompt-manager.js");
    const id = c.req.param("id");
    const deleted = deletePrompt(id);
    if (!deleted) return c.json({ error: "Prompt not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Linear Integration ──────────────────────────────────────────────

  api.get("/linear/connection", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ connected: false });
    }
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `query { viewer { id name email } teams { nodes { id key name } } }`,
        }),
      });
      const data = await res.json() as { data?: { viewer?: { name: string; email: string }; teams?: { nodes: Array<{ id: string; key: string; name: string }> } }; errors?: unknown[] };
      if (data.errors || !data.data?.viewer) {
        return c.json({ connected: false });
      }
      return c.json({
        connected: true,
        viewer: data.data.viewer,
        teams: data.data.teams?.nodes ?? [],
      });
    } catch {
      return c.json({ connected: false });
    }
  });

  api.get("/linear/issues", async (c) => {
    const { linearApiKey } = getSettings();
    if (!linearApiKey?.trim()) {
      return c.json({ error: "Linear API key not configured" }, 401);
    }
    const query = c.req.query("query") ?? "";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10), 50);
    try {
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": linearApiKey,
        },
        body: JSON.stringify({
          query: `
            query SearchIssues($query: String!, $first: Int!) {
              issueSearch(query: $query, first: $first) {
                nodes {
                  id
                  identifier
                  title
                  url
                  state { name }
                  team { id key name }
                }
              }
            }
          `,
          variables: { query, first: limit },
        }),
      });
      const data = await res.json() as { data?: { issueSearch?: { nodes: unknown[] } }; errors?: unknown[] };
      if (data.errors) {
        return c.json({ error: "Linear API error" }, 502);
      }
      return c.json({ issues: data.data?.issueSearch?.nodes ?? [] });
    } catch (e) {
      return c.json({ error: "Failed to reach Linear API" }, 502);
    }
  });

  return api;
}
