import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { SessionStore } from "../session-store.js";
import type { WorktreeTracker } from "../worktree-tracker.js";
import type { TerminalManager } from "../terminal-manager.js";
import type { PRPoller } from "../pr-poller.js";
import type { RecorderManager } from "../recorder.js";
import type { CronScheduler } from "../cron-scheduler.js";
import type { WebhookManager } from "../webhook-manager.js";
import type { AdapterRegistry } from "../adapter-registry.js";

export interface RouteDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  worktreeTracker: WorktreeTracker;
  terminalManager: TerminalManager;
  prPoller?: PRPoller;
  recorder?: RecorderManager;
  cronScheduler?: CronScheduler;
  webhookManager?: WebhookManager;
  adapterRegistry?: AdapterRegistry;
}

export type RegisterRoutes = (api: Hono, deps: RouteDeps) => void;
