process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { TerminalManager } from "./terminal-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";
import { getSettings } from "./settings-manager.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { AgentExecutor } from "./agent-executor.js";
import { AgentMcpBridge } from "./agent-mcp-bridge.js";
import { SubSessionManager } from "./sub-session-manager.js";
import { ProtocolMonitor } from "./protocol-monitor.js";
import { ProactiveKeepalive } from "./proactive-keepalive.js";
import { securityHeaders, rateLimiter } from "./security-middleware.js";
import { isAuthEnabled, verifyToken } from "./auth.js";
import { WebhookManager } from "./webhook-manager.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { collectiveIntelligenceLayer } from "./collective-intelligence.js";
import { startPeriodicCheck, setServiceMode } from "./update-checker.js";
import { isRunningAsService } from "./service.js";
import { DmuxWatcher } from "./dmux-watcher.js";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__CAMPFIRE_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT, INTERNAL_DEV_BACKEND_PORT } from "./constants.js";

// In dev mode, the backend listens on an internal port (Vite proxies to it).
// In production, the backend IS the user-facing server on DEFAULT_PORT.
const port = Number(process.env.PORT)
  || (process.env.NODE_ENV === "production"
    ? DEFAULT_PORT
    : (Number(process.env.__CAMPFIRE_INTERNAL_PORT) || INTERNAL_DEV_BACKEND_PORT));
const sessionStore = new SessionStore();
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const terminalManager = new TerminalManager();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const webhookManager = new WebhookManager();
const adapterRegistry = new AdapterRegistry();
const agentExecutor = new AgentExecutor(launcher, wsBridge);
const subSessionManager = new SubSessionManager(launcher, wsBridge);
const agentMcpBridge = new AgentMcpBridge(wsBridge, subSessionManager, { port, packageRoot });
const protocolMonitor = new ProtocolMonitor();
// Proactive keepalive — auto-relaunches crashed CLI sessions with exponential backoff.
const _keepalive = new ProactiveKeepalive(launcher);
process.on("SIGTERM", () => _keepalive.destroy());
const dmuxWatcher = new DmuxWatcher();

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
wsBridge.setWebhookManager(webhookManager);
wsBridge.setProtocolMonitor(protocolMonitor);
wsBridge.setCollectiveIntelligence(collectiveIntelligenceLayer);
wsBridge.setAgentMcpBridge(agentMcpBridge);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// When an adapter is created (Codex, Goose, etc.), attach it to the WsBridge
launcher.onAdapterCreated((sessionId, adapter, backendType) => {
  wsBridge.attachAdapter(sessionId, adapter, backendType);
});

// Start watching PRs when git info is resolved for a session
wsBridge.onSessionGitInfoReadyCallback((sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
const relaunchingSet = new Set<string>();
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;
  if (info && info.state !== "starting") {
    relaunchingSet.add(sessionId);
    console.log(`[server] Auto-relaunching CLI for session ${sessionId}`);
    wsBridge.notifyLaunching(sessionId);
    try {
      await launcher.relaunch(sessionId);
    } finally {
      setTimeout(() => relaunchingSet.delete(sessionId), 5000);
    }
  }
});

// Auto-generate session title after first turn completes
wsBridge.onFirstTurnCompletedCallback(async (sessionId, firstUserMessage) => {
  // Don't overwrite a name that was already set (manual rename or prior auto-name)
  if (sessionNames.getName(sessionId)) return;
  if (!getSettings().openrouterApiKey.trim()) return;
  const info = launcher.getSession(sessionId);
  const model = info?.model || "claude-sonnet-4-5-20250929";
  console.log(`[server] Auto-naming session ${sessionId} via OpenRouter with model ${model}...`);
  const title = await generateSessionTitle(firstUserMessage, model);
  // Re-check: a manual rename may have occurred while we were generating
  if (title && !sessionNames.getName(sessionId)) {
    console.log(`[server] Auto-named session ${sessionId}: "${title}"`);
    sessionNames.setName(sessionId, title);
    wsBridge.broadcastNameUpdate(sessionId, title);
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

app.onError((err, c) => {
  console.error(`[server] ${c.req.method} ${c.req.path} error:`, err);
  return c.json({ error: err.message }, 500);
});

app.use("/*", securityHeaders);
app.use("/api/*", rateLimiter);
app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, webhookManager, adapterRegistry, agentExecutor, protocolMonitor, agentMcpBridge));

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

// ── WebSocket auth helper ──────────────────────────────────────────────────
// When auth is enabled, all WebSocket upgrades (except CLI from localhost)
// require a valid session token. Returns null if authorized, or a 401 Response.
function checkWsAuth(request: Request, wsUrl: URL, allowLocalCli = false): Response | null {
  if (!isAuthEnabled()) return null;
  if (allowLocalCli) {
    const host = request.headers.get("host") || "";
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return null;
  }
  const token = wsUrl.searchParams.get("auth_token")
    || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (token && verifyToken(token)) return null;
  return new Response("Unauthorized", { status: 401 });
}

// ── WebSocket upgrade routing (extracted for cognitive complexity) ──────────

const CLI_RE = /^\/ws\/cli\/([a-f0-9-]+)$/;
const BROWSER_RE = /^\/ws\/browser\/([a-f0-9-]+)$/;
const TERMINAL_RE = /^\/ws\/terminal\/([a-f0-9-]+)$/;

type WsServer = { upgrade: (req: Request, opts: { data: SocketData; headers?: HeadersInit }) => boolean };

function upgradeOrFail(server: WsServer, req: Request, data: SocketData): Response | undefined {
  return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

function handleCliWs(req: Request, url: URL, server: WsServer, sessionId: string): Response | undefined {
  const authReject = checkWsAuth(req, url, true);
  if (authReject) return authReject;
  return upgradeOrFail(server, req, { kind: "cli", sessionId });
}

function handleBrowserWs(req: Request, url: URL, server: WsServer, sessionId: string): Response | undefined {
  const inviteToken = url.searchParams.get("token");
  const role = inviteToken ? wsBridge.resolveInviteTokenRole(inviteToken) : undefined;
  if (!role) {
    const authReject = checkWsAuth(req, url);
    if (authReject) return authReject;
  }
  return upgradeOrFail(server, req, { kind: "browser", sessionId, _joinRole: role } as SocketData);
}

function handleTerminalWs(req: Request, url: URL, server: WsServer, terminalId: string): Response | undefined {
  const authReject = checkWsAuth(req, url);
  if (authReject) return authReject;
  return upgradeOrFail(server, req, { kind: "terminal", terminalId });
}

function handleDmuxWs(req: Request, url: URL, server: WsServer): Response | undefined {
  const authReject = checkWsAuth(req, url);
  if (authReject) return authReject;
  return upgradeOrFail(server, req, { kind: "dmux", cwd: url.searchParams.get("cwd") || "" });
}

function handleWsUpgrade(req: Request, url: URL, server: WsServer): Response | undefined {
  const cliMatch = CLI_RE.exec(url.pathname);
  if (cliMatch) return handleCliWs(req, url, server, cliMatch[1]);

  const browserMatch = BROWSER_RE.exec(url.pathname);
  if (browserMatch) return handleBrowserWs(req, url, server, browserMatch[1]);

  const termMatch = TERMINAL_RE.exec(url.pathname);
  if (termMatch) return handleTerminalWs(req, url, server, termMatch[1]);

  if (url.pathname === "/ws/dmux") return handleDmuxWs(req, url, server);

  return undefined;
}

const server = Bun.serve<SocketData>({
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    const wsResult = handleWsUpgrade(req, url, server);
    if (wsResult) return wsResult;

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    // Disable Bun's built-in ping timeout to prevent idle CLI connections from being killed (code 1006)
    idleTimeout: 0,
    sendPings: false,
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      } else if (data.kind === "dmux") {
        const client = { cwd: data.cwd, send: (d: string) => ws.send(d) };
        (ws as unknown as { _dmuxClient: typeof client })._dmuxClient = client;
        dmuxWatcher.addClient(client);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      } else if (data.kind === "dmux") {
        try {
          const parsed = JSON.parse(typeof msg === "string" ? msg : msg.toString());
          const client = (ws as unknown as { _dmuxClient: import("./dmux-watcher.js").DmuxWatchClient })._dmuxClient;
          if (client) dmuxWatcher.handleMessage(client, parsed);
        } catch {
          // Ignore malformed messages
        }
      }
    },
    close(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      } else if (data.kind === "dmux") {
        const client = (ws as unknown as { _dmuxClient: import("./dmux-watcher.js").DmuxWatchClient })._dmuxClient;
        if (client) dmuxWatcher.removeClient(client);
      }
    },
  },
});

console.log(`Server running on http://localhost:${server.port}`);
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: open http://localhost:4567 (Vite proxies to this backend)");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();
agentExecutor.startAll();

// ── Update checker ──────────────────────────────────────────────────────────
startPeriodicCheck();
if (isRunningAsService()) {
  setServiceMode(true);
  console.log("[server] Running as background service (auto-update available)");
}

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = 10_000;
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      wsBridge.notifyLaunching(info.sessionId);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
