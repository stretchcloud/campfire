import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as envManager from "../env-manager.js";
import * as gitUtils from "../git-utils.js";
import * as sessionNames from "../session-names.js";
import { containerManager, type ContainerConfig, type ContainerInfo } from "../container-manager.js";
import { seedClaudeAuth } from "../claude-container-auth.js";
import { seedCodexAuth } from "../codex-container-auth.js";
import { pullImage, imageExistsLocally } from "../image-pull-manager.js";

export function registerSessionRoutes(api: Hono, deps: RouteDeps): void {
  const { launcher, wsBridge, sessionStore, worktreeTracker, prPoller } = deps;

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
        codexReasoningEffort: backend === "codex" ? body.codexReasoningEffort : undefined,
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        worktreeInfo,
      });

      // Re-track container with real session ID
      if (containerInfo) {
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

  // Detect running Claude Code processes that could be adopted
  api.get("/sessions/detect", async (c) => {
    try {
      const detected = await launcher.detectRunningProcesses();
      return c.json(detected);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 500);
    }
  });

  // Adopt an existing running Claude Code process
  api.post("/sessions/adopt", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const session = await launcher.adopt({
        pid: body.pid ? Number(body.pid) : undefined,
        cwd: body.cwd,
        model: body.model,
        cliSessionId: body.cliSessionId,
      });

      // Set a name if provided
      if (body.name) {
        sessionNames.setName(session.sessionId, body.name);
      }

      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to adopt session:", msg);
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
    containerManager.removeContainer(id);
    const worktreeResult = cleanupWorktree(worktreeTracker, id, true);
    prPoller?.unwatch(id);
    launcher.removeSession(id);
    wsBridge.closeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    await launcher.kill(id);
    containerManager.removeContainer(id);
    prPoller?.unwatch(id);
    const worktreeResult = cleanupWorktree(worktreeTracker, id, body.force);
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

  // ─── Fork ──────────────────────────────────────────────────────
  api.post("/sessions/:id/fork", async (c) => {
    const sourceId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const liveSession = wsBridge.getSession(sourceId);
      const persisted = sessionStore.load(sourceId);
      const sourceHistory = liveSession?.messageHistory ?? persisted?.messageHistory ?? [];
      const sourceState = liveSession?.state ?? persisted?.state ?? null;
      if (!sourceState) {
        return c.json({ error: "Source session not found" }, 404);
      }

      const messageIndex = typeof body.messageIndex === "number" ? body.messageIndex : sourceHistory.length;
      const forkedHistory = sourceHistory.slice(0, messageIndex);

      const backend = sourceState.backend_type || "claude";
      const model = body.model || sourceState.model;
      const permissionMode = body.permissionMode || sourceState.permissionMode;
      const cwd = sourceState.cwd || process.cwd();

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

      const session = launcher.launch({
        model,
        permissionMode,
        cwd: forkCwd,
        backendType: backend,
        worktreeInfo,
      });

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

  // ─── SSE session creation with progress ─────────────────────────────
  api.post("/sessions/create-with-progress", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const backend = body.backend ?? "claude";
    const image = body.container?.image || "companion-dev:latest";

    // Set up SSE stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function sendEvent(type: string, data: Record<string, unknown>) {
          const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(msg));
        }

        try {
          // Step 1: Check image
          sendEvent("step", { step: "checking_image", message: `Checking image ${image}...` });
          const exists = await imageExistsLocally(image);

          // Step 2: Pull image if needed
          if (!exists) {
            sendEvent("step", { step: "pulling_image", message: `Pulling ${image}...` });
            const pulled = await pullImage(image, (progress) => {
              sendEvent("step", {
                step: "pulling_image",
                message: progress.message || progress.status,
                percent: progress.percent,
                layer: progress.layer,
              });
            });
            if (!pulled) {
              sendEvent("error", { error: `Failed to pull image ${image}` });
              controller.close();
              return;
            }
          }

          // Step 3: Create container
          sendEvent("step", { step: "creating_container", message: "Creating container..." });
          const cwd = body.cwd || process.cwd();
          let containerInfo: ContainerInfo | undefined;
          if (body.container) {
            const cConfig: ContainerConfig = {
              image,
              ports: Array.isArray(body.container.ports)
                ? body.container.ports.map(Number).filter((n: number) => n > 0)
                : [],
              volumes: body.container.volumes,
              env: body.container.env,
            };
            const containerId = crypto.randomUUID().slice(0, 8);
            containerInfo = containerManager.createContainer(containerId, cwd, cConfig);
          }

          // Step 4: Seed auth
          if (containerInfo) {
            sendEvent("step", { step: "seeding_auth", message: "Seeding authentication..." });
            if (backend === "claude") {
              seedClaudeAuth(containerInfo.containerId);
            } else if (backend === "codex") {
              seedCodexAuth(containerInfo.containerId);
            }
          }

          // Step 5: Launch agent
          sendEvent("step", { step: "launching_agent", message: "Launching agent..." });

          let envVars: Record<string, string> | undefined = body.env;
          if (body.envSlug) {
            const companionEnv = envManager.getEnv(body.envSlug);
            if (companionEnv) {
              envVars = { ...companionEnv.variables, ...body.env };
            }
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
            codexReasoningEffort: backend === "codex" ? body.codexReasoningEffort : undefined,
            allowedTools: body.allowedTools,
            env: envVars,
            backendType: backend,
          });

          if (containerInfo) {
            containerManager.retrack(containerInfo.containerId, session.sessionId);
          }

          sendEvent("done", { sessionId: session.sessionId, session });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendEvent("error", { error: msg });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });
}

// ─── Helper ─────────────────────────────────────────────────────────
export function cleanupWorktree(
  worktreeTracker: RouteDeps["worktreeTracker"],
  sessionId: string,
  force?: boolean,
): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
  const mapping = worktreeTracker.getBySession(sessionId);
  if (!mapping) return undefined;

  if (worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
    worktreeTracker.removeBySession(sessionId);
    return { cleaned: false, path: mapping.worktreePath };
  }

  const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
  if (dirty && !force) {
    console.log(
      `[routes] Worktree ${mapping.worktreePath} is dirty, not auto-removing`,
    );
    return { cleaned: false, dirty: true, path: mapping.worktreePath };
  }

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
    worktreeTracker.removeBySession(sessionId);
    console.log(
      `[routes] ${dirty ? "Force-removed dirty" : "Auto-removed clean"} worktree ${mapping.worktreePath}`,
    );
  }
  return { cleaned: result.removed, path: mapping.worktreePath };
}
