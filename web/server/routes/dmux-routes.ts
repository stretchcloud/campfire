import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { resolveBinary } from "../path-resolver.js";
import { dmuxManager } from "../dmux-manager.js";
import type { DmuxLaunchConfig } from "../dmux-manager.js";
import { readDmuxConfig, writeDmuxConfig, updateDmuxConfig } from "../dmux-config.js";
import type { DmuxConfigFile } from "../dmux-config.js";
import { DmuxPaneRecorder, listDmuxRecordings, loadDmuxRecording } from "../dmux-recorder.js";

// Track active recorder at module level (one recording at a time)
let activeRecorder: DmuxPaneRecorder | null = null;

export function registerDmuxRoutes(api: Hono, _deps: RouteDeps): void {
  // ─── Prerequisites check (moved from system-routes) ───────────────
  api.get("/dmux/prereqs", (c) => {
    const dmuxPath = resolveBinary("dmux");
    const tmuxPath = resolveBinary("tmux");
    return c.json({
      dmux: { available: dmuxPath !== null, path: dmuxPath },
      tmux: { available: tmuxPath !== null, path: tmuxPath },
    });
  });

  // ─── Session status ───────────────────────────────────────────────
  api.get("/dmux/status", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd query parameter is required" }, 400);
    const status = dmuxManager.getStatus(cwd);
    return c.json(status);
  });

  // ─── Available agents ─────────────────────────────────────────────
  api.get("/dmux/agents", (c) => {
    const agents = dmuxManager.getAvailableAgents();
    return c.json(agents);
  });

  // ─── Focus a pane ─────────────────────────────────────────────────
  api.post("/dmux/pane/focus", async (c) => {
    const body = await c.req.json<{ tmuxTarget: string }>();
    if (!body.tmuxTarget) return c.json({ error: "tmuxTarget is required" }, 400);
    const ok = dmuxManager.focusPane(body.tmuxTarget);
    return c.json({ ok });
  });

  // ─── Send keys to a pane ──────────────────────────────────────────
  api.post("/dmux/pane/send", async (c) => {
    const body = await c.req.json<{ tmuxTarget: string; keys: string; enter?: boolean }>();
    if (!body.tmuxTarget || !body.keys) {
      return c.json({ error: "tmuxTarget and keys are required" }, 400);
    }
    const ok = dmuxManager.sendToPane(body.tmuxTarget, body.keys, body.enter);
    return c.json({ ok });
  });

  // ─── Launch dmux ──────────────────────────────────────────────────
  api.post("/dmux/launch", async (c) => {
    const config = await c.req.json<DmuxLaunchConfig>();
    if (!config.cwd) return c.json({ error: "cwd is required" }, 400);
    const command = dmuxManager.buildLaunchCommand(config);
    return c.json({ command });
  });

  // ─── Config CRUD ──────────────────────────────────────────────────

  api.get("/dmux/config", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd query parameter is required" }, 400);
    const config = readDmuxConfig(cwd);
    return c.json(config || {});
  });

  api.patch("/dmux/config", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd query parameter is required" }, 400);
    const updates = await c.req.json<Partial<DmuxConfigFile>>();
    const merged = updateDmuxConfig(cwd, updates);
    if (!merged) return c.json({ error: "No existing config to update" }, 404);
    return c.json(merged);
  });

  api.put("/dmux/config", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd query parameter is required" }, 400);
    const config = await c.req.json<DmuxConfigFile>();
    writeDmuxConfig(cwd, config);
    return c.json({ ok: true });
  });

  // ─── Recording ────────────────────────────────────────────────────

  api.post("/dmux/recording/start", async (c) => {
    const body = await c.req.json<{ cwd: string }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);

    if (activeRecorder) {
      return c.json({ error: "A recording is already in progress" }, 409);
    }

    const status = dmuxManager.getStatus(body.cwd);
    const paneTargets = status.panes.map((p) => p.tmuxTarget);
    const sessionName = status.sessionName || "unknown";

    activeRecorder = new DmuxPaneRecorder(body.cwd, sessionName, paneTargets);
    return c.json({ ok: true });
  });

  api.post("/dmux/recording/stop", (c) => {
    if (!activeRecorder) {
      return c.json({ filename: null });
    }
    const filename = activeRecorder.getFilename();
    activeRecorder.close();
    activeRecorder = null;
    return c.json({ filename });
  });

  api.get("/dmux/recordings", (c) => {
    const list = listDmuxRecordings();
    return c.json(list);
  });

  api.get("/dmux/recordings/:filename", (c) => {
    const filename = c.req.param("filename");
    const data = loadDmuxRecording(filename);
    if (!data) return c.json({ error: "Recording not found" }, 404);
    return c.json(data);
  });
}
