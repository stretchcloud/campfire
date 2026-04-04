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
import type { BackendType } from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { GooseAdapter } from "./goose-adapter.js";
import { AiderAdapter } from "./aider-adapter.js";
import { OpenHandsAdapter } from "./openhands-adapter.js";
import { OpenClawAdapter } from "./openclaw-adapter.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import type { AgentAdapter } from "./adapter-types.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import {
  getLegacyCodexHome,
  resolveCampfireCodexSessionHome,
} from "./codex-home.js";

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
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio).
 */
export class CliLauncher {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  private port: number;
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
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Check if the process is still alive
      if (info.pid && info.state !== "exited") {
        try {
          process.kill(info.pid, 0); // signal 0 = just check if alive
          info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
          this.sessions.set(info.sessionId, info);
          recovered++;
        } catch {
          // Process is dead
          info.state = "exited";
          info.exitCode = -1;
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
    return recovered;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
      backendType,
    };

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
      info.codexReasoningEffort = options.codexReasoningEffort;
    }

    // Store worktree metadata if provided
    if (options.worktreeInfo) {
      info.isWorktree = options.worktreeInfo.isWorktree;
      info.repoRoot = options.worktreeInfo.repoRoot;
      info.branch = options.worktreeInfo.branch;
      info.actualBranch = options.worktreeInfo.actualBranch;
    }

    this.sessions.set(sessionId, info);

    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, options);
    } else if (backendType === "goose") {
      this.spawnGoose(sessionId, info, options);
    } else if (backendType === "aider") {
      this.spawnAider(sessionId, info, options);
    } else if (backendType === "openhands") {
      this.spawnOpenHands(sessionId, info, options);
    } else if (backendType === "openclaw") {
      this.spawnOpenClaw(sessionId, info, options);
    } else if (backendType === "opencode") {
      this.spawnOpenCode(sessionId, info, options);
    } else {
      this.spawnCLI(sessionId, info, options);
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

    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
        codexReasoningEffort: info.codexReasoningEffort,
      });
    } else if (info.backendType === "goose") {
      this.spawnGoose(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
      });
    } else if (info.backendType === "aider") {
      this.spawnAider(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
      });
    } else if (info.backendType === "openhands") {
      this.spawnOpenHands(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
      });
    } else if (info.backendType === "openclaw") {
      this.spawnOpenClaw(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
      });
    } else if (info.backendType === "opencode") {
      this.spawnOpenCode(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
      });
    } else {
      this.spawnCLI(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        resumeSessionId: info.cliSessionId,
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

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): void {
    let binary = options.claudeBinary || "claude";
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

    const sdkUrl = `ws://localhost:${this.port}/ws/cli/${sessionId}`;

    const args: string[] = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
      // bypassPermissions requires --dangerously-skip-permissions flag
      if (options.permissionMode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
      }
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
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

    // If a containerId is provided, run the CLI inside the container via docker exec
    let spawnCmd: string[];
    let spawnEnv: Record<string, string | undefined>;
    let spawnCwd: string | undefined;

    if (options.containerId) {
      // Run the CLI inside the Docker container via docker exec.
      // The --sdk-url uses host.docker.internal so the CLI inside the container
      // can connect back to the Campfire server running on the host.
      const containerSdkUrl = sdkUrl.replace("localhost", "host.docker.internal");
      const containerArgs = args.map((a) => a === sdkUrl ? containerSdkUrl : a);
      const dockerArgs = ["docker", "exec", "-i"];
      // Pass environment variables via -e flags
      if (options.env) {
        for (const [k, v] of Object.entries(options.env)) {
          dockerArgs.push("-e", `${k}=${v}`);
        }
      }
      // Set PATH, working directory, container ID, and shell command in one push
      const innerCmd = [binary, ...containerArgs].map((a) => a.includes(" ") ? `'${a}'` : a).join(" ");
      // Install Node + Claude Code if not present (handles images without npm like python:slim)
      const installSteps = [
        `command -v claude >/dev/null 2>&1 || {`,
        `  command -v npm >/dev/null 2>&1 || {`,
        `    apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true;`,
        `  };`,
        `  npm install -g @anthropic-ai/claude-code@latest 2>/dev/null || true;`,
        `}`,
      ].join(" ");
      const installAndRun = `${installSteps}; ${innerCmd}`;
      dockerArgs.push(
        "-e", `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin`,
        "-w", "/workspace",
        options.containerId,
        "bash", "-lc", installAndRun,
      );
      spawnCmd = dockerArgs;
      spawnEnv = { ...process.env, PATH: getEnrichedPath() };
      spawnCwd = undefined;
      console.log(`[cli-launcher] Spawning session ${sessionId} INSIDE container ${options.containerId}`);
    } else {
      spawnCmd = [binary, ...args];
      spawnEnv = env;
      spawnCwd = info.cwd;
      console.log(`[cli-launcher] Spawning session ${sessionId}: ${binary} ${args.join(" ")}`);
    }

    const proc = Bun.spawn(spawnCmd, {
      cwd: spawnCwd,
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

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

  private spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
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
    if (existsSync(siblingNode)) {
      // Resolve the real path of the codex script (follows symlinks)
      // so node can load it as an ES module with the correct package.json context.
      let codexScript: string;
      try {
        codexScript = realpathSync(binary);
      } catch {
        codexScript = binary;
      }
      spawnCmd = [siblingNode, codexScript, ...args];
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

    const proc = Bun.spawn(spawnCmd, {
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

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
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
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionId} exited (code=${exitCode})`);
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

