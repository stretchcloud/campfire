// Re-export shim — the actual route implementations live in routes/*.ts
// This file preserves the original import path for backwards compatibility.
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { TerminalManager } from "./terminal-manager.js";
import { createRoutes as _createRoutes } from "./routes/index.js";

/**
 * Legacy positional-args signature preserved for backwards compatibility.
 * New code should import from `./routes/index.js` and pass a deps object.
 */
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
  agentExecutor?: import("./agent-executor.js").AgentExecutor,
  protocolMonitor?: import("./protocol-monitor.js").ProtocolMonitor,
  agentMcpBridge?: import("./agent-mcp-bridge.js").AgentMcpBridge,
) {
  return _createRoutes({
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    terminalManager,
    prPoller,
    recorder,
    cronScheduler,
    webhookManager,
    adapterRegistry,
    agentExecutor,
    protocolMonitor,
    agentMcpBridge,
  });
}
