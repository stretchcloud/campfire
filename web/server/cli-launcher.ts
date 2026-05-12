import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType, DetectedEnvironment } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { GooseAdapter } from "./goose-adapter.js";
import { AiderAdapter } from "./aider-adapter.js";
import { OpenHandsAdapter } from "./openhands-adapter.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { ClaudeStdioAdapter } from "./claude-stdio-adapter.js";
import type { AgentAdapter } from "./adapter-types.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import {
  getLegacyCodexHome,
  resolveCampfireCodexSessionHome,
} from "./codex-home.js";
import { getSettings } from "./settings-manager.js";
import { detectEnvironment } from "./environment-detector.js";

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  archived?: boolean;
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path */
  repoRoot?: string;
  /** Conceptual branch this session is working on (what user selected) */
  branch?: string;
  /** Actual git branch in the worktree (may differ for -wt-N branches) */
  actualBranch?: string;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Claude transport used for this session. Undefined means legacy persisted data. */
  claudeTransport?: "stdio" | "sdk-url";
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Reasoning effort for Codex o-series models */
  codexReasoningEffort?: "low" | "medium" | "high";
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Environment variables injected at session creation (persisted for relaunch) */
  sessionEnv?: Record<string, string>;
  /** Session that spawned this one, when used as a sub-agent. */
  parentSessionId?: string;
  /** Orchestration role assigned by Campfire. */
  orchestrationRole?: "lead" | "subagent" | "race_entry";
  /** Environment detections computed for the session cwd. */
  detectedEnvironment?: DetectedEnvironment;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  gooseBinary?: string;
  aiderBinary?: string;
  openhandsBinary?: string;
  openclawBinary?: string;
  opencodeBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Reasoning effort for Codex o-series models (low/medium/high). */
  codexReasoningEffort?: "low" | "medium" | "high";
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Docker container ID — when set, CLI is spawned inside the container via docker exec */
  containerId?: string;
  /** Pre-resolved worktree info from the session creation flow */
  worktreeInfo?: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
  };
  parentSessionId?: string;
  orchestrationRole?: "lead" | "subagent" | "race_entry";
  detectedEnvironment?: DetectedEnvironment;
}

/**
 * Manages CLI backend processes (Claude Code/Codex/Goose/etc. via stdio,
 * with legacy Claude --sdk-url WebSocket available by environment flag).
 */
function useClaudeSdkUrlTransport(): boolean {
  return process.env.CAMPFIRE_CLAUDE_TRANSPORT === "sdk-url";
}

/** Build Claude Code CLI arguments for the legacy --sdk-url transport. */
function buildClaudeSdkUrlArgs(sdkUrl: string, options: LaunchOptions & { resumeSessionId?: string }): string[] {
  const args = ["--sdk-url", sdkUrl, "--print", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
    if (options.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  }
  if (options.allowedTools) {
    for (const tool of options.allowedTools) args.push("--allowedTools", tool);
  }
  return args;
}

/** Build Claude Code CLI arguments for the long-lived stdio transport. */
function buildClaudeStdioArgs(options: LaunchOptions & { resumeSessionId?: string }): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
    if (options.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  }
  if (options.allowedTools) {
    for (const tool of options.allowedTools) args.push("--allowedTools", tool);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  return args;
}

function applyClaudeAuthEnv(env: Record<string, string | undefined>): void {
  const settings = getSettings();
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && settings.claudeOAuthToken.trim()) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeOAuthToken.trim();
  }
  if (!env.ANTHROPIC_API_KEY && settings.anthropicApiKey.trim()) {
    env.ANTHROPIC_API_KEY = settings.anthropicApiKey.trim();
  }
}

/** Build docker exec spawn command for running CLI inside a container. */
function buildContainerSpawn(
  sessionId: string, binary: string, args: string[], sdkUrl: string | null,
  options: LaunchOptions & { containerId: string }, env: Record<string, string | undefined>,
): { spawnCmd: string[]; spawnEnv: Record<string, string | undefined>; spawnCwd: string | undefined } {
  const containerSdkUrl = sdkUrl?.replace("localhost", "host.docker.internal") ?? null;
  const containerArgs = containerSdkUrl ? args.map((a) => a === sdkUrl ? containerSdkUrl : a) : args;
  const dockerArgs = ["docker", "exec", "-i"];
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      dockerArgs.push("-e", `${k}=${v}`);
    }
  }
  const innerCmd = [binary, ...containerArgs].map((a) => a.includes(" ") ? `'${a}'` : a).join(" ");
  const installSteps = [
    `command -v claude >/dev/null 2>&1 || {`,
    `  command -v npm >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true; };`,
    `  npm install -g @anthropic-ai/claude-code@latest 2>/dev/null || true;`,
    `}`,
  ].join(" ");
  dockerArgs.push(
    "-e", `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin`,
    "-w", "/workspace",
    options.containerId,
    "bash", "-lc", `${installSteps}; ${innerCmd}`,
  );
  console.log(`[cli-launcher] Spawning session ${sessionId} INSIDE container ${options.containerId}`);
  return { spawnCmd: dockerArgs, spawnEnv: { ...process.env, PATH: getEnrichedPath() }, spawnCwd: undefined };
}

export class CliLauncher {
  private readonly sessions = new Map<string, SdkSessionInfo>();
  private readonly processes = new Map<string, Subprocess>();
  private readonly port: number;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private onAdapter: ((sessionId: string, adapter: AgentAdapter, backendType: BackendType) => void) | null = null;
  private onExited: ((sessionId: string, exitCode: number | null) => void) | null = null;

  constructor(port: number) {
    this.port = port;
  }

  /** Register a callback for when an adapter is created (WsBridge needs to attach it). */
  onAdapterCreated(cb: (sessionId: string, adapter: AgentAdapter, backendType: BackendType) => void): void {
    this.onAdapter = cb;
  }

  /** Register a callback for when a CLI process exits (used by proactive keepalive). */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): void {
    this.onExited = cb;
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Persist launcher state to disk. */
  private persistState(): void {
    if (!this.store) return;
    const data = Array.from(this.sessions.values());
    this.store.saveLauncher(data);
  }

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    let changed = false;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Check if the process is still alive
      if (info.pid && info.state !== "exited") {
        try {
          process.kill(info.pid, 0); // signal 0 = just check if alive
          if (info.backendType === "claude" && info.claudeTransport === "stdio") {
            try { process.kill(info.pid, "SIGTERM"); } catch {}
            info.state = "exited";
            info.exitCode = -1;
            info.pid = undefined;
            changed = true;
          } else {
            info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
            recovered++;
            changed = true;
          }
          this.sessions.set(info.sessionId, info);
        } catch {
          // Process is dead
          info.state = "exited";
          info.exitCode = -1;
          info.pid = undefined;
          changed = true;
          this.sessions.set(info.sessionId, info);
        }
      } else {
        // Already exited or no PID
        this.sessions.set(info.sessionId, info);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }

    // Also recover sessions from individual session store files that are
    // missing from launcher.json (e.g. after a crash before launcher.json
    // was written). This prevents data loss on VM crash or power loss.
    const storeRecovered = this.recoverFromStoreFiles();
    if (changed || storeRecovered > 0) this.persistState();

    return recovered + storeRecovered;
  }

  /** Scan individual session store files for sessions missing from launcher.json. */
  private recoverFromStoreFiles(): number {
    if (!this.store) return 0;
    const storeFiles = this.store.loadAll();
    let count = 0;
    for (const persisted of storeFiles) {
      if (this.sessions.has(persisted.id)) continue;
      const info: SdkSessionInfo = {
        sessionId: persisted.id,
        state: "exited",
        exitCode: -1,
        model: persisted.state?.model,
        permissionMode: persisted.state?.permissionMode,
        cwd: persisted.state?.cwd || "",
        createdAt: 0,
        archived: persisted.archived,
        backendType: persisted.state?.backend_type,
      };
      this.sessions.set(persisted.id, info);
      count++;
    }
    if (count > 0) {
      console.log(`[cli-launcher] Recovered ${count} additional session(s) from session store files`);
      this.persistState();
    }
    return count;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";
    const launchOptions = backendType === "codex" && !options.model?.trim()
      ? { ...options, model: undefined }
      : options;
    const detectedEnvironment = launchOptions.detectedEnvironment ?? detectEnvironment(cwd);

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: launchOptions.model,
      permissionMode: launchOptions.permissionMode,
      cwd,
      createdAt: Date.now(),
      backendType,
      parentSessionId: launchOptions.parentSessionId,
      orchestrationRole: launchOptions.orchestrationRole,
      detectedEnvironment,
      claudeTransport: backendType === "claude"
        ? (useClaudeSdkUrlTransport() ? "sdk-url" : "stdio")
        : undefined,
    };

    if (backendType === "codex") {
      info.codexInternetAccess = launchOptions.codexInternetAccess === true;
      info.codexSandbox = launchOptions.codexSandbox;
      info.codexReasoningEffort = launchOptions.codexReasoningEffort;
    }

    // Persist env vars so they survive server restarts and relaunches
    if (launchOptions.env && Object.keys(launchOptions.env).length > 0) {
      info.sessionEnv = launchOptions.env;
    }

    // Store worktree metadata if provided
    if (launchOptions.worktreeInfo) {
      info.isWorktree = launchOptions.worktreeInfo.isWorktree;
      info.repoRoot = launchOptions.worktreeInfo.repoRoot;
      info.branch = launchOptions.worktreeInfo.branch;
      info.actualBranch = launchOptions.worktreeInfo.actualBranch;
    }

    this.sessions.set(sessionId, info);

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, launchOptions);
    } else if (backendType === "goose") {
      this.spawnGoose(sessionId, info, launchOptions);
    } else if (backendType === "aider") {
      this.spawnAider(sessionId, info, launchOptions);
    } else if (backendType === "openhands") {
      this.spawnOpenHands(sessionId, info, launchOptions);
    } else if (backendType === "openclaw") {
      this.spawnOpenClaw(sessionId, info, launchOptions);
    } else if (backendType === "opencode") {
      this.spawnOpenCode(sessionId, info, launchOptions);
    } else {
      this.spawnCLI(sessionId, info, launchOptions);
    }
    return info;
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(sessionId: string): Promise<boolean> {
    const info = this.sessions.get(sessionId);
    if (!info) return false;

    // Kill old process if still alive
    const oldProc = this.processes.get(sessionId);
    if (oldProc) {
      try {
        oldProc.kill("SIGTERM");
        await Promise.race([
          oldProc.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      try { process.kill(info.pid, "SIGTERM"); } catch {}
    }

    info.state = "starting";

    // Persisted env vars are re-injected on every relaunch
    const relaunchEnv = info.sessionEnv;

    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
        codexReasoningEffort: info.codexReasoningEffort,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else if (info.backendType === "goose") {
      this.spawnGoose(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else if (info.backendType === "aider") {
      this.spawnAider(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else if (info.backendType === "openhands") {
      this.spawnOpenHands(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else if (info.backendType === "openclaw") {
      this.spawnOpenClaw(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else if (info.backendType === "opencode") {
      this.spawnOpenCode(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    } else {
      this.spawnCLI(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        resumeSessionId: info.cliSessionId,
        env: relaunchEnv,
        detectedEnvironment: info.detectedEnvironment,
      });
    }
    return true;
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private prepareClaudeLaunch(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): string | null {
    let binary = options.claudeBinary || "claude";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return null;
    }

    // Inject CLAUDE.md guardrails for worktree sessions
    if (info.isWorktree && info.branch) {
      this.injectWorktreeGuardrails(
        info.cwd,
        info.actualBranch || info.branch,
        info.repoRoot || "",
        info.actualBranch && info.actualBranch !== info.branch ? info.branch : undefined,
      );
    }

    return binary;
  }

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): void {
    const binary = this.prepareClaudeLaunch(sessionId, info, options);
    if (!binary) return;

    if (useClaudeSdkUrlTransport()) {
      this.spawnClaudeSdkUrl(sessionId, info, options, binary);
    } else {
      this.spawnClaudeStdio(sessionId, info, options, binary);
    }
  }

  private spawnClaudeSdkUrl(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
    binary: string,
  ): void {
    info.claudeTransport = "sdk-url";
    const sdkUrl = `ws://localhost:${this.port}/ws/cli/${sessionId}`;
    const args = buildClaudeSdkUrlArgs(sdkUrl, options);

    // Always pass -p "" for headless mode. When relaunching, also pass --resume
    // to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }
    args.push("-p", "");

    // Use enriched PATH so spawned CLI processes inherit the user's
    // full PATH (nvm, volta, etc.) regardless of how the server started.
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: undefined,
      ...options.env,
      PATH: getEnrichedPath(),
    };
    applyClaudeAuthEnv(env);

    const { spawnCmd, spawnEnv, spawnCwd } = options.containerId
      ? buildContainerSpawn(sessionId, binary, args, sdkUrl, options as LaunchOptions & { containerId: string }, env)
      : { spawnCmd: [binary, ...args], spawnEnv: env, spawnCwd: info.cwd };

    if (!options.containerId) {
      console.log(`[cli-launcher] Spawning session ${sessionId}: ${binary} ${args.join(" ")}`);
    }

    let proc: Subprocess;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      console.error(`[cli-launcher] Failed to spawn Claude session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      info.state = "exited";
      info.exitCode = 127;
      this.processes.delete(sessionId);
      this.persistState();
      return;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Stream stdout/stderr for debugging
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // If the process exited almost immediately with --resume, the resume likely failed.
        // Clear cliSessionId so the next relaunch starts fresh.
        const uptime = Date.now() - spawnedAt;
        if (uptime < 5000 && options.resumeSessionId) {
          console.error(`[cli-launcher] Session ${sessionId} exited immediately after --resume (${uptime}ms). Clearing cliSessionId for fresh start.`);
          session.cliSessionId = undefined;
        }
      }
      // Notify proactive keepalive
      this.onExited?.(sessionId, exitCode);
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  private spawnClaudeStdio(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
    binary: string,
  ): void {
    info.claudeTransport = "stdio";
    const args = buildClaudeStdioArgs(options);

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: undefined,
      ...options.env,
      PATH: getEnrichedPath(),
    };
    applyClaudeAuthEnv(env);

    const { spawnCmd, spawnEnv, spawnCwd } = options.containerId
      ? buildContainerSpawn(sessionId, binary, args, null, options as LaunchOptions & { containerId: string }, env)
      : { spawnCmd: [binary, ...args], spawnEnv: env, spawnCwd: info.cwd };

    if (!options.containerId) {
      console.log(`[cli-launcher] Spawning Claude stdio session ${sessionId}: ${binary} ${args.join(" ")}`);
    }

    let proc: Subprocess;
    try {
      proc = Bun.spawn(spawnCmd, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      console.error(`[cli-launcher] Failed to spawn Claude stdio session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      info.state = "exited";
      info.exitCode = 127;
      info.cliSessionId = undefined;
      this.processes.delete(sessionId);
      this.persistState();
      return;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    const adapter = new ClaudeStdioAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      recorder: this.recorder ?? undefined,
    });

    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Claude stdio session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "claude");
    }

    info.state = "connected";

    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Claude stdio session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        const uptime = Date.now() - spawnedAt;
        if (uptime < 5000 && options.resumeSessionId) {
          console.error(`[cli-launcher] Claude stdio session ${sessionId} exited immediately after --resume (${uptime}ms). Clearing cliSessionId for fresh start.`);
          session.cliSessionId = undefined;
        }
      }
      this.onExited?.(sessionId, exitCode);
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdio.
   */
  private prepareCodexHome(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !existsSync(legacyHome)) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          copyFileSync(src, dest);
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          cpSync(src, dest, { recursive: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }
  }

  private async spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const model = options.model?.trim() ? options.model : undefined;
    let binary = options.codexBinary || "codex";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    const args: string[] = ["app-server"];
    const internetEnabled = options.codexInternetAccess === true;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    const codexHome = resolveCampfireCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    this.prepareCodexHome(codexHome);

    // The codex binary is a Node.js script with `#!/usr/bin/env node` shebang.
    // When Bun.spawn executes it, the kernel resolves `node` via /usr/bin/env
    // which may find the system Node (e.g. v12) instead of the nvm-managed one.
    // To guarantee the correct Node version, we resolve the `node` binary that
    // lives alongside `codex` and spawn `node <codex.js>` directly.
    const binaryDir = resolve(binary, "..");
    const siblingNode = join(binaryDir, "node");
    const enrichedPath = getEnrichedPath();
    const spawnPath = [binaryDir, ...enrichedPath.split(":")].filter(Boolean).join(":");

    // Determine whether to invoke node explicitly or use the binary directly.
    // If a `node` binary exists next to `codex`, use it to bypass shebang issues.
    let spawnCmd: string[];
    // Resolve the real path of the codex script (follows symlinks)
    let codexScript: string;
    try {
      codexScript = realpathSync(binary);
    } catch {
      codexScript = binary;
    }

    // Find a Node.js binary to run codex — Bun.spawn doesn't reliably handle
    // Node.js shebang scripts with stdio pipes. Check sibling first, then PATH.
    let nodeForCodex = siblingNode;
    if (!existsSync(nodeForCodex)) {
      const systemNode = resolveBinary("node");
      nodeForCodex = systemNode || "";
    }

    if (nodeForCodex && existsSync(nodeForCodex)) {
      spawnCmd = [nodeForCodex, codexScript, ...args];
    } else {
      spawnCmd = [binary, ...args];
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: undefined,
      ...options.env,
      CODEX_HOME: codexHome,
      PATH: spawnPath,
    };

    console.log(`[cli-launcher] Spawning Codex session ${sessionId}: ${spawnCmd.join(" ")}`);

    // Use Node's child_process.spawn instead of Bun.spawn for Codex.
    // Bun.spawn has compatibility issues with stdio pipes to Node.js
    // child processes — the transport closes prematurely.
    const { spawn: nodeSpawn } = await import("node:child_process");
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
    const nodeProc = nodeSpawn(spawnCmd[0], spawnCmd.slice(1), {
      cwd: info.cwd,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let processExited = false;
    const markProcessExited = (exitCode: number): void => {
      if (processExited) return;
      processExited = true;
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    };
    const procExited = new Promise<number>((resolve) => {
      nodeProc.once("error", (err) => {
        console.error(`[cli-launcher] Codex session ${sessionId} failed to spawn: ${err.message}`);
        markProcessExited(127);
        resolve(127);
      });
      nodeProc.once("exit", (code) => {
        const exitCode = code ?? 1;
        markProcessExited(exitCode);
        resolve(exitCode);
      });
    });

    // Wrap Node child_process into a Bun-compatible Subprocess interface
    const proc = {
      pid: nodeProc.pid ?? 0,
      stdin: new WritableStream({
        write(chunk: Uint8Array) {
          return new Promise<void>((resolve, reject) => {
            nodeProc.stdin!.write(chunk, (err) => err ? reject(err) : resolve());
          });
        },
      }),
      stdout: new ReadableStream({
        start(controller) {
          nodeProc.stdout!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          nodeProc.stdout!.on("end", () => controller.close());
          nodeProc.stdout!.on("error", (err) => controller.error(err));
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          nodeProc.stderr!.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          nodeProc.stderr!.on("end", () => controller.close());
          nodeProc.stderr!.on("error", (err) => controller.error(err));
        },
      }),
      exited: procExited,
      kill(signal?: string) { nodeProc.kill(signal as NodeJS.Signals); },
      ref() { nodeProc.ref(); },
      unref() { nodeProc.unref(); },
    } as unknown as Subprocess;

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      reasoningEffort: options.codexReasoningEffort,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "codex");
    }

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionId} exited (code=${exitCode})`);
    });

    this.persistState();
  }

  /**
   * Spawn a Goose ACP subprocess for a session.
   * Uses stdio JSON-RPC — same pattern as Codex.
   */
  private spawnGoose(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    let binary = options.gooseBinary || "goose";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Spawn: goose acp --with-builtin developer --with-builtin memory
    const args: string[] = [
      "acp",
      "--with-builtin", "developer",
      "--with-builtin", "memory",
    ];

    const enrichedPath = getEnrichedPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: undefined,
      ...options.env,
      PATH: enrichedPath,
    };

    // Set Goose provider/model via environment if specified
    if (options.model) {
      env.GOOSE_MODEL = options.model;
    }

    console.log(`[cli-launcher] Spawning Goose session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the GooseAdapter which handles JSON-RPC and message translation
    const adapter = new GooseAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      gooseSessionId: info.cliSessionId,
      recorder: this.recorder ?? undefined,
    });

    // Handle init errors
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Goose session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "goose");
    }

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Goose session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  private spawnAider(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    let binary = options.aiderBinary || "aider";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Spawn: aider --no-pretty --yes --no-auto-commits [--model MODEL]
    const args: string[] = ["--no-pretty", "--yes", "--no-auto-commits"];
    if (options.model) {
      args.push("--model", options.model);
    }

    const enrichedPath = getEnrichedPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      PATH: enrichedPath,
    };

    console.log(`[cli-launcher] Spawning Aider session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    const adapter = new AiderAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      recorder: this.recorder ?? undefined,
    });

    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "aider");
    }

    info.state = "connected";

    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Aider session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  private spawnOpenHands(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    let binary = options.openhandsBinary || "openhands";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Spawn: openhands acp
    const args: string[] = ["acp"];

    const enrichedPath = getEnrichedPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      PATH: enrichedPath,
    };

    if (options.model) {
      env.OPENHANDS_MODEL = options.model;
    }

    console.log(`[cli-launcher] Spawning OpenHands session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    const adapter = new OpenHandsAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      recorder: this.recorder ?? undefined,
    });

    adapter.onInitError((error) => {
      console.error(`[cli-launcher] OpenHands session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
      }
      this.persistState();
    });

    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "openhands");
    }

    info.state = "connected";

    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] OpenHands session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  /**
   * Spawn an OpenCode ACP subprocess for a session.
   * Uses stdio JSON-RPC (ACP) — same pattern as Goose and OpenHands.
   * CLI command: opencode acp
   */
  private spawnOpenCode(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    let binary = options.opencodeBinary || "opencode";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Spawn: opencode acp
    const args: string[] = ["acp"];

    const enrichedPath = getEnrichedPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      PATH: enrichedPath,
    };

    // Set OpenCode model via environment if specified
    if (options.model) {
      env.OPENCODE_MODEL = options.model;
    }

    console.log(`[cli-launcher] Spawning OpenCode session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the OpenCodeAdapter which handles ACP JSON-RPC and message translation
    const adapter = new OpenCodeAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      opencodeSessionId: info.cliSessionId,
      recorder: this.recorder ?? undefined,
    });

    adapter.onInitError((error) => {
      console.error(`[cli-launcher] OpenCode session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "opencode");
    }

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] OpenCode session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  private spawnOpenClaw(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    let binary = options.openclawBinary || "openclaw";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Spawn: openclaw acp
    const args: string[] = ["acp"];

    const enrichedPath = getEnrichedPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      PATH: enrichedPath,
    };

    // Pass Gateway URL and token via environment if available
    if (options.model) {
      env.OPENCLAW_MODEL = options.model;
    }

    console.log(`[cli-launcher] Spawning OpenClaw session ${sessionId}: ${binary} ${args.join(" ")}`);

    const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    const adapter = new OpenClawAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      permissionMode: options.permissionMode,
      openclawSessionId: info.cliSessionId,
      recorder: this.recorder ?? undefined,
    });

    adapter.onInitError((error) => {
      console.error(`[cli-launcher] OpenClaw session ${sessionId} init failed: ${error}`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    if (this.onAdapter) {
      this.onAdapter(sessionId, adapter, "openclaw");
    }

    info.state = "connected";

    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] OpenClaw session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
    });

    this.persistState();
  }

  /**
   * Inject a CLAUDE.md file into the worktree with branch guardrails.
   * Only injects into actual worktree directories, never the main repo.
   */
  private injectWorktreeGuardrails(worktreePath: string, branch: string, repoRoot: string, parentBranch?: string): void {
    // Safety: never inject guardrails into the main repository itself
    if (worktreePath === repoRoot) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path is the main repo (${repoRoot})`);
      return;
    }

    // Safety: only inject if the worktree directory actually exists (created by git worktree add)
    if (!existsSync(worktreePath)) {
      console.warn(`[cli-launcher] Skipping guardrails injection: worktree path does not exist (${worktreePath})`);
      return;
    }

    const branchLabel = parentBranch
      ? `\`${branch}\` (created from \`${parentBranch}\`)`
      : `\`${branch}\``;

    const MARKER_START = "<!-- WORKTREE_GUARDRAILS_START -->";
    const MARKER_END = "<!-- WORKTREE_GUARDRAILS_END -->";
    const guardrails = `${MARKER_START}
# Worktree Session — Branch Guardrails

You are working on branch: ${branchLabel}
This is a git worktree. The main repository is at: \`${repoRoot}\`

**Rules:**
1. DO NOT run \`git checkout\`, \`git switch\`, or any command that changes the current branch
2. All your work MUST stay on the \`${branch}\` branch
3. When committing, commit to \`${branch}\` only
4. If you need to reference code from another branch, use \`git show other-branch:path/to/file\`
${MARKER_END}`;

    const claudeDir = join(worktreePath, ".claude");
    const claudeMdPath = join(claudeDir, "CLAUDE.md");

    try {
      mkdirSync(claudeDir, { recursive: true });

      if (existsSync(claudeMdPath)) {
        const existing = readFileSync(claudeMdPath, "utf-8");
        // Replace existing guardrails section or append
        if (existing.includes(MARKER_START)) {
          const before = existing.substring(0, existing.indexOf(MARKER_START));
          const afterIdx = existing.indexOf(MARKER_END);
          const after = afterIdx >= 0 ? existing.substring(afterIdx + MARKER_END.length) : "";
          writeFileSync(claudeMdPath, before + guardrails + after, "utf-8");
        } else {
          writeFileSync(claudeMdPath, existing + "\n\n" + guardrails, "utf-8");
        }
      } else {
        writeFileSync(claudeMdPath, guardrails, "utf-8");
      }
      console.log(`[cli-launcher] Injected worktree guardrails for branch ${branch}`);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to inject worktree guardrails:`, e);
    }
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Mark a session as exited without requiring a live child process.
   * Used when an automatic relaunch is known to be impossible, such as when
   * the persisted working directory was removed.
   */
  markSessionExited(sessionId: string, exitCode: number | null = 1): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.state = "exited";
    session.exitCode = exitCode;
    session.pid = undefined;
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      this.persistState();
    }
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.persistState();
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }

  /** Get the port this launcher is using. */
  getPort(): number {
    return this.port;
  }
}
