import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { resolveBinary } from "../path-resolver.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { containerManager } from "../container-manager.js";
import { getUsageLimits } from "../usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
} from "../update-checker.js";
import { refreshServiceDefinition } from "../service.js";

const UPDATE_CHECK_STALE_MS = 5 * 60 * 1000;

export function registerSystemRoutes(api: Hono, deps: RouteDeps): void {
  const { wsBridge, terminalManager } = deps;

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

  api.get("/containers/list", (c) => {
    return c.json(containerManager.listContainers());
  });

  api.post("/containers/:sessionId/stop", async (c) => {
    const sessionId = c.req.param("sessionId");
    await containerManager.removeContainer(sessionId);
    return c.json({ ok: true });
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
      return c.json({ error: "Update & restart is only available in service mode" }, 400);
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    setTimeout(async () => {
      try {
        console.log(`[update] Updating the-campfire to ${state.latestVersion}...`);
        const proc = Bun.spawn(
          ["bun", "install", "-g", `the-campfire@${state.latestVersion}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          console.error(`[update] bun install failed (code ${exitCode}):`, stderr);
          setUpdateInProgress(false);
          return;
        }
        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }
        console.log("[update] Update successful, restarting service...");
        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-campfire.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.campfire.app`]
            : ["launchctl", "kickstart", "-k", "sh.campfire.app"];

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
}
