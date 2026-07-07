import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
  BufferedBrowserEvent,
  SessionState,
  PermissionRequest,
  BackendType,
  SessionRole,
  PresenceViewer,
  VotingPolicy,
  PermissionVote,
  McpServerDetail,
  McpServerConfig,
  DetectedEnvironment,
  SubAgentUpdate,
} from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { AgentAdapter } from "./adapter-types.js";
import type { RecorderManager } from "./recorder.js";
import type { CollectiveIntelligenceLayer } from "./collective-intelligence.js";
import { evaluateAutoInjection, scanMcpServers } from "./mcp-policy.js";

// ─── WebSocket data tags ──────────────────────────────────────────────────────

interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
  /** Unique viewer ID assigned on connect (short random string) */
  viewerId?: string;
  /** Display name for presence (defaults to "Viewer N") */
  viewerName?: string;
  /** Role for RBAC enforcement */
  role?: SessionRole;
  /** Role from invite token, set at WebSocket upgrade time */
  _joinRole?: SessionRole;
}

interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

/** Tracks a pending control_request sent to CLI that expects a control_response. */
interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

/** Tracks in-progress vote collection for a single permission request */
interface PendingVoteCollection {
  requestId: string;
  votes: Map<string, PermissionVote>; // viewerId → vote
  deadline: number; // timestamp when voting closes
  timer: ReturnType<typeof setTimeout>;
  /** The original permission response message (from first voter, used as template) */
  templateMsg: {
    updated_input?: Record<string, unknown>;
    updated_permissions?: unknown[];
    message?: string;
  };
}

interface Session {
  id: string;
  backendType: BackendType;
  cliSocket: ServerWebSocket<SocketData> | null;
  adapter: AgentAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  /** Pending control_requests sent TO CLI, keyed by request_id */
  pendingControlRequests: Map<string, PendingControlRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** Monotonic sequence for broadcast events */
  nextEventSeq: number;
  /** Recent broadcast events for reconnect replay */
  eventBuffer: BufferedBrowserEvent[];
  /** Highest acknowledged seq seen from any browser for this session */
  lastAckSeq: number;
  /** Recently processed browser client_msg_id values for idempotency on reconnect retries */
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** In-progress vote collections for permission requests (multi-viewer sessions) */
  pendingVotes: Map<string, PendingVoteCollection>;
}

type GitSessionKey = "git_branch" | "is_worktree" | "repo_root" | "git_ahead" | "git_behind";

interface AgentMcpBridgeHook {
  onSessionReady(sessionId: string, backendType: BackendType, cwd: string): void;
  handlePermissionRequest?(sessionId: string, msg: CLIControlRequestMessage): boolean;
  handleAdapterPermissionRequest?(
    sessionId: string,
    request: PermissionRequest,
    respond: (msg: Extract<BrowserOutgoingMessage, { type: "permission_response" }>) => void,
  ): boolean;
}

function makeDefaultState(sessionId: string, backendType: BackendType = "claude"): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_start_commit: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    total_duration_api_ms: 0,
  };
}

// ─── Git info helper ─────────────────────────────────────────────────────────

const BIN_GIT = "/usr/bin/git";

/** Run a git command in the given directory, returning trimmed output or null on failure. */
function gitExec(args: string, cwd: string, timeout = 3000): string | null {
  try {
    return execFileSync(BIN_GIT, args.split(" "), { cwd, encoding: "utf-8", timeout }).trim();
  } catch {
    return null;
  }
}

/** Parse insertions/deletions from `git diff --shortstat` output. */
function parseShortstat(stat: string): { added: number; removed: number } {
  const ins = /\b(\d+) insertion/.exec(stat);
  const del = /\b(\d+) deletion/.exec(stat);
  return {
    added: ins ? Number.parseInt(ins[1], 10) : 0,
    removed: del ? Number.parseInt(del[1], 10) : 0,
  };
}

/** Resolve the base ref for diffing (upstream tracking branch, or main/master). */
function resolveBaseRef(cwd: string): string {
  const upstream = gitExec("rev-parse --abbrev-ref @{upstream}", cwd);
  if (upstream) return upstream;
  // No upstream — try main or master
  for (const candidate of ["main", "master"]) {
    if (gitExec(`rev-parse --verify ${candidate}`, cwd) !== null) {
      return candidate;
    }
  }
  return "";
}

/** Compute total lines added/removed (committed + uncommitted). */
function resolveLineChanges(cwd: string): { added: number; removed: number } {
  let totalAdded = 0;
  let totalRemoved = 0;

  // 1) Committed changes: diff from merge-base with upstream or main/master
  const baseRef = resolveBaseRef(cwd);
  if (baseRef) {
    const mergeBase = gitExec(`merge-base ${baseRef} HEAD`, cwd);
    if (mergeBase) {
      const stat = gitExec(`diff --shortstat ${mergeBase} HEAD`, cwd, 5000);
      if (stat) {
        const { added, removed } = parseShortstat(stat);
        totalAdded += added;
        totalRemoved += removed;
      }
    }
  }

  // 2) Uncommitted changes (staged + unstaged) on top of HEAD
  const uncommittedStat = gitExec("diff --shortstat HEAD", cwd, 5000);
  if (uncommittedStat) {
    const { added, removed } = parseShortstat(uncommittedStat);
    totalAdded += added;
    totalRemoved += removed;
  }

  return { added: totalAdded, removed: totalRemoved };
}

function resolveGitInfo(state: SessionState): void {
  if (!state.cwd) return;
  const cwd = state.cwd;

  const branch = gitExec("rev-parse --abbrev-ref HEAD", cwd);
  if (branch === null) {
    // Not a git repo or git not available
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
    return;
  }

  state.git_branch = branch;

  // Capture starting commit once (used as diff base for the session)
  if (!state.git_start_commit) {
    state.git_start_commit = gitExec("rev-parse HEAD", cwd) ?? "";
  }

  const gitDir = gitExec("rev-parse --git-dir", cwd);
  if (gitDir) {
    state.is_worktree = gitDir.includes("/worktrees/");
  }

  if (state.is_worktree) {
    const commonDir = gitExec("rev-parse --git-common-dir", cwd);
    if (commonDir) {
      state.repo_root = resolve(cwd, commonDir, "..");
    }
  } else {
    state.repo_root = gitExec("rev-parse --show-toplevel", cwd) ?? "";
  }

  const counts = gitExec("rev-list --left-right --count @{upstream}...HEAD", cwd);
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    state.git_ahead = ahead || 0;
    state.git_behind = behind || 0;
  } else {
    state.git_ahead = 0;
    state.git_behind = 0;
  }

  try {
    const { added, removed } = resolveLineChanges(cwd);
    state.total_lines_added = added;
    state.total_lines_removed = removed;
  } catch {
    // git diff can fail if there's no HEAD commit yet
  }
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private static readonly EVENT_BUFFER_LIMIT = 600;
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  private static readonly IDEMPOTENT_BROWSER_MESSAGE_TYPES = new Set<string>([
    "user_message",
    "permission_response",
    "interrupt",
    "set_model",
    "set_permission_mode",
    "mcp_get_status",
    "mcp_toggle",
    "mcp_reconnect",
    "mcp_set_servers",
  ]);
  private static readonly VOTE_DEADLINE_MS = 30_000; // 30 seconds to vote
  private static readonly INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly sessions = new Map<string, Session>();
  private readonly inviteTokens = new Map<string, { sessionId: string; role: SessionRole; expiresAt: number }>();
  private viewerCounter = 0;
  private votingPolicy: VotingPolicy = "majority-rules";
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private protocolMonitor: import("./protocol-monitor.js").ProtocolMonitor | null = null;
  private webhookManager: import("./webhook-manager.js").WebhookManager | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => boolean | void) | null = null;
  private onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => boolean | void | Promise<boolean | void>) | null = null;
  private agentMcpBridge: AgentMcpBridgeHook | null = null;
  private readonly environmentMcpInjected = new Set<string>();
  private readonly autoNamingAttempted = new Set<string>();
  private userMsgCounter = 0;
  private onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "is_worktree",
    "repo_root",
    "git_ahead",
    "git_behind",
  ];

  /** Register a callback for when we learn the CLI's internal session ID. */
  onCLISessionIdReceived(cb: (sessionId: string, cliSessionId: string) => void): void {
    this.onCLISessionId = cb;
  }

  /** Register a callback for when a browser connects but CLI is dead. */
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => boolean | void): void {
    this.onCLIRelaunchNeeded = cb;
  }

  /** Register a callback for when a session completes its first turn. */
  onFirstTurnCompletedCallback(cb: (sessionId: string, firstUserMessage: string) => boolean | void | Promise<boolean | void>): void {
    this.onFirstTurnCompleted = cb;
  }

  /** Register a callback for when git info is resolved and branch is known. */
  onSessionGitInfoReadyCallback(cb: (sessionId: string, cwd: string, branch: string) => void): void {
    this.onGitInfoReady = cb;
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  setAgentMcpBridge(bridge: AgentMcpBridgeHook): void {
    this.agentMcpBridge = bridge;
  }

  markSessionOrchestration(
    sessionId: string,
    data: {
      parentSessionId?: string;
      role?: "lead" | "subagent" | "race_entry";
      detectedEnvironment?: DetectedEnvironment;
    },
  ): void {
    const session = this.getOrCreateSession(sessionId);
    if (data.parentSessionId) session.state.parent_session_id = data.parentSessionId;
    if (data.role) session.state.orchestration_role = data.role;
    if (data.detectedEnvironment) session.state.detected_environment = data.detectedEnvironment;
    this.persistSession(session);
  }

  broadcastSubAgentUpdate(parentSessionId: string, agent: SubAgentUpdate): void {
    this.broadcastToSession(parentSessionId, { type: "sub_agent_update", agent });
  }

  addSubAgentCost(parentSessionId: string, costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const session = this.sessions.get(parentSessionId);
    if (!session) return;
    session.state.sub_agent_cost_usd = (session.state.sub_agent_cost_usd || 0) + costUsd;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { sub_agent_cost_usd: session.state.sub_agent_cost_usd },
    });
    this.persistSession(session);
  }

  setMcpServers(sessionId: string, servers: Record<string, McpServerConfig>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.routeBrowserMessage(session, { type: "mcp_set_servers", servers });
  }

  private injectDetectedEnvironmentMcp(session: Session): void {
    if (this.environmentMcpInjected.has(session.id)) return;
    if (session.state.parent_session_id || session.state.orchestration_role === "subagent") return;
    if (session.backendType !== "claude" && session.backendType !== "codex") return;
    const servers = session.state.detected_environment?.mcpServers;
    if (!servers || Object.keys(servers).length === 0) return;
    if (process.env.CAMPFIRE_AUTO_INJECT_ENV_MCP === "0") return;

    // Default-deny: detected_environment is persisted state and reachable
    // from session-create payloads, so only curated, scan-clean servers may
    // auto-inject (see mcp-policy.ts).
    const verdict = evaluateAutoInjection(servers);
    for (const finding of verdict.blocked) {
      console.warn(`[ws-bridge] MCP auto-injection ${finding.severity} for session ${session.id}: ${finding.server} — ${finding.reason}`);
    }
    if (Object.keys(verdict.allowed).length === 0) return;

    this.environmentMcpInjected.add(session.id);
    this.routeBrowserMessage(session, { type: "mcp_set_servers", servers: verdict.allowed });
  }

  // ── Invite tokens ────────────────────────────────────────────────────

  /** Drop expired invite tokens (called opportunistically on create/resolve). */
  private pruneExpiredInviteTokens(): void {
    const now = Date.now();
    for (const [token, entry] of this.inviteTokens) {
      if (entry.expiresAt <= now) this.inviteTokens.delete(token);
    }
  }

  /** Generate a short invite token for a session with a specified role.
   *  Tokens expire after 24 hours — an invite link is a bearer credential
   *  that bypasses password auth, so it must not live forever. */
  createInviteToken(sessionId: string, role: SessionRole = "collaborator"): string | null {
    if (!this.sessions.has(sessionId)) return null;

    this.pruneExpiredInviteTokens();
    // Generate a 12-char URL-safe token (always new — different roles may be desired)
    const token = randomUUID().replaceAll("-", "").substring(0, 12);
    this.inviteTokens.set(token, {
      sessionId,
      role,
      expiresAt: Date.now() + WsBridge.INVITE_TOKEN_TTL_MS,
    });
    return token;
  }

  private getLiveInviteEntry(token: string): { sessionId: string; role: SessionRole } | null {
    const entry = this.inviteTokens.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.inviteTokens.delete(token);
      return null;
    }
    return entry;
  }

  /** Resolve an invite token to a session ID. Returns null if invalid or expired. */
  resolveInviteToken(token: string): string | null {
    return this.getLiveInviteEntry(token)?.sessionId ?? null;
  }

  /** Get the role associated with an invite token. Returns null if invalid or expired. */
  resolveInviteTokenRole(token: string): SessionRole | null {
    return this.getLiveInviteEntry(token)?.role ?? null;
  }

  /** Get presence info for all connected viewers in a session. */
  getSessionViewers(sessionId: string): PresenceViewer[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const viewers: PresenceViewer[] = [];
    for (const ws of session.browserSockets) {
      const data = ws.data as BrowserSocketData;
      if (data.viewerId) {
        viewers.push({
          id: data.viewerId,
          name: data.viewerName || `Viewer ${data.viewerId.slice(0, 4)}`,
          role: data.role || "spectator",
        });
      }
    }
    return viewers;
  }

  /** Broadcast current presence to all browsers in a session. */
  private broadcastPresence(session: Session): void {
    const viewers = this.getSessionViewers(session.id);
    this.broadcastToBrowsers(session, {
      type: "presence_update",
      viewers,
    });
  }

  /** Set the voting policy for permission requests in multi-viewer sessions. */
  setVotingPolicy(policy: VotingPolicy): void {
    this.votingPolicy = policy;
  }

  /** Get the current voting policy. */
  getVotingPolicy(): VotingPolicy {
    return this.votingPolicy;
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a protocol monitor for real-time metrics. */
  setProtocolMonitor(monitor: import("./protocol-monitor.js").ProtocolMonitor): void {
    this.protocolMonitor = monitor;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  setWebhookManager(wm: import("./webhook-manager.js").WebhookManager): void {
    this.webhookManager = wm;
  }

  setCollectiveIntelligence(ci: CollectiveIntelligenceLayer): void {
    this.collectiveIntelligence = ci;
    // Give CI access to broadcastToSession so it can emit CI messages to browsers
    ci.setBroadcast((sessionId, msg) => {
      if (sessionId === "__all__") {
        // Broadcast to all active sessions (used for deliberation resolutions)
        for (const session of this.sessions.values()) {
          this.broadcastToBrowsers(session, msg);
        }
      } else {
        this.broadcastToSession(sessionId, msg);
      }
    });
  }

  private collectiveIntelligence: CollectiveIntelligenceLayer | null = null;

  /** Hydrate a persisted session record into a live Session object. */
  private hydrateSession(p: ReturnType<SessionStore["loadAll"]>[number]): Session {
    const clientMsgIds = Array.isArray(p.processedClientMessageIds)
      ? p.processedClientMessageIds
      : [];
    const session: Session = {
      id: p.id,
      backendType: p.state.backend_type || "claude",
      cliSocket: null,
      adapter: null,
      browserSockets: new Set(),
      state: p.state,
      pendingPermissions: new Map(p.pendingPermissions || []),
      pendingControlRequests: new Map(),
      messageHistory: p.messageHistory || [],
      pendingMessages: p.pendingMessages || [],
      nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
      eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
      lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
      processedClientMessageIds: clientMsgIds,
      processedClientMessageIdSet: new Set(clientMsgIds),
      pendingVotes: new Map(),
    };
    session.state.backend_type = session.backendType;
    resolveGitInfo(session.state);
    return session;
  }

  /** Restore sessions from disk (call once at startup). */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const persisted = this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session = this.hydrateSession(p);
      this.sessions.set(p.id, session);
      // Restored sessions with completed turns don't need auto-naming re-triggered
      if (session.state.num_turns > 0) {
        this.autoNamingAttempted.add(session.id);
      }
      count++;
    }
    if (count > 0) {
      console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    if (!this.store) return;
    this.store.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
      eventBuffer: session.eventBuffer,
      nextEventSeq: session.nextEventSeq,
      lastAckSeq: session.lastAckSeq,
      processedClientMessageIds: session.processedClientMessageIds,
    });
  }

  private refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    const before = {
      git_branch: session.state.git_branch,
      is_worktree: session.state.is_worktree,
      repo_root: session.state.repo_root,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
      total_lines_added: session.state.total_lines_added,
      total_lines_removed: session.state.total_lines_removed,
    };

    resolveGitInfo(session.state);

    let changed = false;
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      if (session.state[key] !== before[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      if (session.state.total_lines_added !== before.total_lines_added ||
          session.state.total_lines_removed !== before.total_lines_removed) {
        changed = true;
      }
    }

    if (changed) {
      if (options.broadcastUpdate) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: {
            git_branch: session.state.git_branch,
            is_worktree: session.state.is_worktree,
            repo_root: session.state.repo_root,
            git_ahead: session.state.git_ahead,
            git_behind: session.state.git_behind,
            total_lines_added: session.state.total_lines_added,
            total_lines_removed: session.state.total_lines_removed,
            total_duration_api_ms: session.state.total_duration_api_ms,
          },
        });
      }
      this.persistSession(session);
    }

    if (options.notifyPoller && session.state.git_branch && session.state.cwd && this.onGitInfoReady) {
      this.onGitInfoReady(session.id, session.state.cwd, session.state.git_branch);
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const type = backendType || "claude";
      session = {
        id: sessionId,
        backendType: type,
        cliSocket: null,
        adapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        pendingControlRequests: new Map(),
        messageHistory: [],
        pendingMessages: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        pendingVotes: new Map(),
      };
      this.sessions.set(sessionId, session);
    } else if (backendType) {
      // Only overwrite backendType when explicitly provided (e.g. attachAdapter)
      // Prevents handleBrowserOpen from resetting codex/goose→claude
      session.backendType = backendType;
      session.state.backend_type = backendType;
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Return all session IDs that currently have at least one connected browser. */
  getConnectedSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.browserSockets.size > 0) ids.push(id);
    }
    return ids;
  }

  /** Notify browsers that the CLI backend is being launched for a session. */
  notifyLaunching(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.broadcastToBrowsers(session, { type: "cli_launching" });
    }
  }

  /** Pre-populate a session's message history (e.g. for forked sessions). */
  seedMessageHistory(sessionId: string, messages: BrowserIncomingMessage[]): void {
    const session = this.getOrCreateSession(sessionId);
    session.messageHistory = [...messages];
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  getCodexRateLimits(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.backendType !== "codex" || !session.adapter) return null;
    return (session.adapter as CodexAdapter).getRateLimits();
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.adapter) return session.adapter.isConnected();
    return !!session.cliSocket;
  }

  /** Run collective-intelligence end-of-session hooks (memory consolidation,
   *  shared-context promotion) before a session's state is discarded. */
  private notifySessionEnded(session: Session): void {
    if (!this.collectiveIntelligence) return;
    const repoRoot = session.state.repo_root || session.state.cwd || "";
    void this.collectiveIntelligence
      .onSessionEnd(session.id, session.backendType, repoRoot)
      .catch((err) => console.warn(`[ws-bridge] CI onSessionEnd failed for ${session.id}:`, err));
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) this.notifySessionEnded(session);
    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.notifySessionEnded(session);

    // Close CLI socket (Claude)
    if (session.cliSocket) {
      try { session.cliSocket.close(); } catch {}
      session.cliSocket = null;
    }

    // Disconnect adapter (Codex/Goose)
    if (session.adapter) {
      session.adapter.disconnect().catch(() => {});
      session.adapter = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
  }

  // ── Adapter attachment (Codex / Goose / future adapters) ────────────────

  /**
   * Attach an AgentAdapter to a session. The adapter handles all message
   * translation between the backend process (stdio JSON-RPC, etc.) and the
   * browser WebSocket protocol.
   */
  attachAdapter(sessionId: string, adapter: AgentAdapter, backendType: BackendType): void {
    const session = this.getOrCreateSession(sessionId, backendType);
    session.backendType = backendType;
    session.state.backend_type = backendType;
    session.adapter = adapter;

    // Emit webhook: session.created
    this.webhookManager?.emit("session.created", sessionId, {
      backendType,
      cwd: session.state.cwd,
      model: session.state.model,
    });

    // Forward translated messages to browsers
    adapter.onBrowserMessage((msg) => {
      this.handleAdapterBrowserMessage(session, msg, backendType);
    });

    // Handle session metadata updates
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId && this.onCLISessionId) {
        this.onCLISessionId(session.id, meta.cliSessionId);
      }
      if (meta.model) session.state.model = meta.model;
      if (meta.cwd) session.state.cwd = meta.cwd;
      session.state.backend_type = backendType;
      this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.adapter = null;
      this.persistSession(session);
      console.log(`[ws-bridge] ${backendType} adapter disconnected for session ${sessionId}`);
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });
    });

    // Flush any messages queued while waiting for the adapter
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to ${backendType} adapter for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const msg = this.normalizeQueuedAdapterMessage(raw, backendType);
          if (msg) adapter.sendBrowserMessage(msg);
        } catch {
          console.warn(`[ws-bridge] Failed to parse queued message for ${backendType}: ${raw.substring(0, 100)}`);
        }
      }
    }

    // Notify browsers that the backend is connected
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    console.log(`[ws-bridge] ${backendType} adapter attached for session ${sessionId}`);
  }

  private normalizeQueuedAdapterMessage(raw: string, backendType: BackendType): BrowserOutgoingMessage | null {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === "user_message" || parsed.type === "permission_response" || parsed.type === "interrupt"
      || parsed.type === "set_model" || parsed.type === "set_permission_mode" || parsed.type === "mcp_get_status"
      || parsed.type === "mcp_toggle" || parsed.type === "mcp_reconnect" || parsed.type === "mcp_set_servers") {
      return parsed as BrowserOutgoingMessage;
    }

    if (backendType !== "claude") return null;

    if (parsed.type === "user") {
      const message = parsed.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (typeof content === "string") {
        return { type: "user_message", content };
      }
      if (Array.isArray(content)) {
        const text = content
          .filter((block): block is { type: string; text: string } =>
            !!block && typeof block === "object"
            && (block as { type?: unknown }).type === "text"
            && typeof (block as { text?: unknown }).text === "string")
          .map((block) => block.text)
          .join("\n");
        return { type: "user_message", content: text };
      }
    }

    if (parsed.type === "control_request") {
      const request = parsed.request as Record<string, unknown> | undefined;
      if (request?.subtype === "interrupt") return { type: "interrupt" };
      if (request?.subtype === "set_model" && typeof request.model === "string") {
        return { type: "set_model", model: request.model };
      }
      if (request?.subtype === "set_permission_mode" && typeof request.mode === "string") {
        return { type: "set_permission_mode", mode: request.mode };
      }
      if (request?.subtype === "mcp_status") return { type: "mcp_get_status" };
      if (request?.subtype === "mcp_toggle" && typeof request.serverName === "string" && typeof request.enabled === "boolean") {
        return { type: "mcp_toggle", serverName: request.serverName, enabled: request.enabled };
      }
      if (request?.subtype === "mcp_reconnect" && typeof request.serverName === "string") {
        return { type: "mcp_reconnect", serverName: request.serverName };
      }
      if (request?.subtype === "mcp_set_servers" && request.servers && typeof request.servers === "object") {
        return { type: "mcp_set_servers", servers: request.servers as Record<string, McpServerConfig> };
      }
    }

    if (parsed.type === "control_response") {
      const responseEnvelope = parsed.response as { request_id?: unknown; response?: unknown } | undefined;
      const response = responseEnvelope?.response as Record<string, unknown> | undefined;
      const requestId = responseEnvelope?.request_id;
      if (typeof requestId === "string" && (response?.behavior === "allow" || response?.behavior === "deny")) {
        return {
          type: "permission_response",
          request_id: requestId,
          behavior: response.behavior,
          updated_input: response.updatedInput as Record<string, unknown> | undefined,
          updated_permissions: response.updatedPermissions as import("./session-types.js").PermissionUpdate[] | undefined,
          message: typeof response.message === "string" ? response.message : undefined,
        };
      }
    }

    console.warn(`[ws-bridge] Dropping unsupported queued ${backendType} adapter message: ${raw.substring(0, 100)}`);
    return null;
  }

  // ── Adapter message dispatch (extracted for reduced complexity) ────────

  /**
   * Preserve persisted session stats when adapter reinitializes with zero values.
   * Happens on server restart when a fresh adapter has no cost history.
   */
  private preserveSessionStatsOnInit(
    session: Session,
    newState: Partial<SessionState>,
    backendType: BackendType,
  ): void {
    const preserved = {
      cost: session.state.total_cost_usd || 0,
      turns: session.state.num_turns || 0,
      duration: session.state.total_duration_api_ms || 0,
      linesAdded: session.state.total_lines_added || 0,
      linesRemoved: session.state.total_lines_removed || 0,
      contextPct: session.state.context_used_percent || 0,
      codexDetails: session.state.codex_token_details,
      claudeDetails: session.state.claude_token_details,
    };

    session.state = { ...session.state, ...newState, backend_type: backendType };

    if (!session.state.total_cost_usd && preserved.cost > 0) {
      session.state.total_cost_usd = preserved.cost;
    }
    if (!session.state.num_turns && preserved.turns > 0) {
      session.state.num_turns = preserved.turns;
    }
    if (!session.state.total_duration_api_ms && preserved.duration > 0) {
      session.state.total_duration_api_ms = preserved.duration;
    }
    if (!session.state.total_lines_added && preserved.linesAdded > 0) {
      session.state.total_lines_added = preserved.linesAdded;
    }
    if (!session.state.total_lines_removed && preserved.linesRemoved > 0) {
      session.state.total_lines_removed = preserved.linesRemoved;
    }
    if (!session.state.context_used_percent && preserved.contextPct > 0) {
      session.state.context_used_percent = preserved.contextPct;
    }
    if (!session.state.codex_token_details && preserved.codexDetails) {
      session.state.codex_token_details = preserved.codexDetails;
    }
    if (!session.state.claude_token_details && preserved.claudeDetails) {
      session.state.claude_token_details = preserved.claudeDetails;
    }
  }

  /** Persist adapter result cost/turns into session state so they survive reconnects. */
  private persistAdapterResultData(session: Session, msg: BrowserIncomingMessage): void {
    const resultData = (msg as { data?: CLIResultMessage }).data;
    if (!resultData) return;
    if (typeof resultData.total_cost_usd === "number" && resultData.total_cost_usd > (session.state.total_cost_usd || 0)) {
      session.state.total_cost_usd = resultData.total_cost_usd;
    }
    if (typeof resultData.num_turns === "number") {
      session.state.num_turns = resultData.num_turns;
    }
  }

  /** Preserve Claude-specific result handling when Claude runs through the stdio adapter. */
  private handleClaudeAdapterResult(session: Session, msg: CLIResultMessage): void {
    this.applyResultToSessionState(session, msg);
    this.applyModelUsage(session, msg);
    this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });

    if (!session.state.total_lines_added && !session.state.total_lines_removed) {
      const { added, removed } = this.computeLinesFromToolBlocks(session);
      if (added > 0 || removed > 0) {
        session.state.total_lines_added = added;
        session.state.total_lines_removed = removed;
      }
    }

    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        total_duration_api_ms: session.state.total_duration_api_ms,
        total_lines_added: session.state.total_lines_added,
        total_lines_removed: session.state.total_lines_removed,
      },
    });

    this.emitResultWebhooks(session, msg);
  }

  /** Try to trigger auto-naming after the first successful result in a session. */
  private tryAutoNaming(session: Session, msg: BrowserIncomingMessage): void {
    if (msg.type !== "result") return;
    if ((msg as { data?: { is_error?: boolean } }).data?.is_error) return;
    if (!this.onFirstTurnCompleted) return;
    if (this.autoNamingAttempted.has(session.id)) return;

    const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
    if (firstUserMsg?.type === "user_message") {
      this.autoNamingAttempted.add(session.id);
      void Promise.resolve(this.onFirstTurnCompleted(session.id, firstUserMsg.content))
        .then((completed) => {
          if (completed === false) this.autoNamingAttempted.delete(session.id);
        })
        .catch((err) => {
          console.warn(`[ws-bridge] Auto-naming callback failed for session ${session.id}:`, err);
          this.autoNamingAttempted.delete(session.id);
        });
    }
  }

  /** Handle a message from an adapter (Codex/Goose/etc.) and route to browsers. */
  private handleAdapterBrowserMessage(
    session: Session,
    msg: BrowserIncomingMessage,
    backendType: BackendType,
  ): void {
    // Update session state based on message type
    if (msg.type === "session_init") {
      this.preserveSessionStatsOnInit(session, msg.session, backendType);
      this.refreshGitInfo(session, { notifyPoller: true });
      this.persistSession(session);
      this.injectDetectedEnvironmentMcp(session);
      this.agentMcpBridge?.onSessionReady(session.id, backendType, session.state.cwd);
    } else if (msg.type === "session_update") {
      session.state = { ...session.state, ...msg.session, backend_type: backendType };
      this.refreshGitInfo(session, { notifyPoller: true });
      this.persistSession(session);
    } else if (msg.type === "status_change") {
      session.state.is_compacting = msg.status === "compacting";
      this.persistSession(session);
    }

    // Store assistant/result messages in history for replay
    if (msg.type === "assistant") {
      session.messageHistory.push({ ...msg, timestamp: msg.timestamp || Date.now() });
      this.persistSession(session);
    } else if (msg.type === "result") {
      if (backendType === "claude") {
        this.handleClaudeAdapterResult(session, msg.data);
      } else {
        this.persistAdapterResultData(session, msg);
      }
      session.messageHistory.push(msg);
      this.persistSession(session);
    }

    // Handle permission requests
    if (msg.type === "permission_request") {
      if (this.agentMcpBridge?.handleAdapterPermissionRequest?.(session.id, msg.request, (response) => {
        session.adapter?.sendBrowserMessage(response);
      })) {
        return;
      }

      session.pendingPermissions.set(msg.request.request_id, msg.request);
      this.persistSession(session);
      this.webhookManager?.emit("permission.requested", session.id, {
        backendType: session.backendType,
        toolName: msg.request.tool_name,
        requestId: msg.request.request_id,
      });
    }

    this.broadcastToBrowsers(session, msg);
    this.tryAutoNaming(session, msg);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });

    // Flush any messages that were queued while waiting for CLI to connect
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) for session ${sessionId}`);
      for (const ndjson of session.pendingMessages) {
        this.sendToCLI(session, ndjson);
      }
      session.pendingMessages = [];
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming CLI message before any parsing
    this.recorder?.record(sessionId, "in", data, "cli", session.backendType, session.state.cwd);
    this.protocolMonitor?.recordMessage(sessionId, "in", "cli", "cli_message", session.backendType);

    // NDJSON: split on newlines, parse each line
    const lines = data.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
        continue;
      }
      this.routeCLIMessage(session, msg);
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.cliSocket = null;
    console.log(`[ws-bridge] CLI disconnected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_disconnected" });

    // Cancel any pending permission requests
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    // Assign viewer identity
    const viewerNum = ++this.viewerCounter;
    const viewerId = randomUUID().replaceAll("-", "").substring(0, 8);
    const role: SessionRole = session.browserSockets.size === 0
      ? "owner"
      : (browserData._joinRole || "collaborator");
    browserData.viewerId = viewerId;
    browserData.viewerName = `Viewer ${viewerNum}`;
    browserData.role = role;
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionId} (${session.browserSockets.size} browsers, role=${role})`);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    this.refreshGitInfo(session, { notifyPoller: true });

    // Fallback: if git didn't produce line counts, compute from tool blocks
    if (!session.state.total_lines_added && !session.state.total_lines_removed) {
      const { added, removed } = this.computeLinesFromToolBlocks(session);
      if (added > 0 || removed > 0) {
        session.state.total_lines_added = added;
        session.state.total_lines_removed = removed;
        this.persistSession(session);
      }
    }

    // Send current session state as snapshot
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
    };
    this.sendToBrowser(ws, snapshot);

    // Replay message history so the browser can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Tell this browser its assigned role BEFORE sending permissions,
    // so the frontend knows whether to enable/disable voting controls.
    this.sendToBrowser(ws, {
      type: "role_assigned",
      role,
      viewerId,
    });

    // Send any pending permission requests
    for (const perm of session.pendingPermissions.values()) {
      this.sendToBrowser(ws, { type: "permission_request", request: perm });
    }

    // Notify if backend is not connected and request relaunch.
    // Treat an attached adapter as "alive" during init — `isConnected()` flips
    // true only after initialize/thread start, and relaunching during that
    // window can kill a healthy startup.
    const backendConnected = session.adapter
      ? !!session.adapter
      : !!session.cliSocket;

    if (!backendConnected) {
      if (this.onCLIRelaunchNeeded) {
        const accepted = this.onCLIRelaunchNeeded(sessionId);
        if (accepted !== false) {
          // Backend is dead but we're about to relaunch — tell browser we're starting
          this.sendToBrowser(ws, { type: "cli_launching" });
          console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}, requesting relaunch`);
        } else {
          this.sendToBrowser(ws, { type: "cli_disconnected" });
          console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}; relaunch declined`);
        }
      } else {
        this.sendToBrowser(ws, { type: "cli_disconnected" });
      }
    }

    // Broadcast updated presence to all browsers
    this.broadcastPresence(session);
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming browser message
    this.recorder?.record(sessionId, "in", data, "browser", session.backendType, session.state.cwd);
    this.protocolMonitor?.recordMessage(sessionId, "in", "browser", "browser_message", session.backendType);

    let msg: BrowserOutgoingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
      return;
    }

    this.routeBrowserMessage(session, msg, ws);
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler to send prompts to autonomous sessions. */
  injectUserMessage(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "user_message", content });
  }

  /** Inject an agent message into a session and broadcast to connected browsers.
   *  Used by the OpenClaw channel plugin to deliver agent responses. */
  injectAgentMessage(sessionId: string, content: string, _metadata?: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject agent message: session ${sessionId} not found`);
      return;
    }

    const messageId = `openclaw-${Date.now()}-${randomUUID().slice(0, 4)}`;
    this.broadcastToBrowsers(session, {
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "openclaw",
        content: [{ type: "text", text: content }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    console.log(`[ws-bridge] Browser disconnected for session ${sessionId} (${session.browserSockets.size} browsers)`);

    // Broadcast updated presence to remaining browsers
    if (session.browserSockets.size > 0) {
      this.broadcastPresence(session);
    }
  }

  // ── CLI message routing ─────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage) {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(session, msg);
        break;

      case "assistant":
        this.handleAssistantMessage(session, msg);
        break;

      case "result":
        this.handleResultMessage(session, msg);
        break;

      case "stream_event":
        this.handleStreamEvent(session, msg);
        break;

      case "control_request":
        this.handleControlRequest(session, msg);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(session, msg);
        break;

      case "auth_status":
        this.handleAuthStatus(session, msg);
        break;

      case "control_response":
        this.handleControlResponse(session, msg);
        break;

      case "keep_alive":
        // Silently consume keepalives
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLISystemInitMessage | CLISystemStatusMessage) {
    if (msg.subtype === "init") {
      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.

      // Store the CLI's internal session_id so we can --resume on relaunch
      if (msg.session_id && this.onCLISessionId) {
        this.onCLISessionId(session.id, msg.session_id);
      }

      session.state.model = msg.model;
      session.state.cwd = msg.cwd;
      session.state.tools = msg.tools;
      session.state.permissionMode = msg.permissionMode;
      session.state.claude_code_version = msg.claude_code_version;
      session.state.mcp_servers = msg.mcp_servers;
      session.state.agents = msg.agents ?? [];
      session.state.slash_commands = msg.slash_commands ?? [];
      session.state.skills = msg.skills ?? [];

      // Resolve and publish git info
      this.refreshGitInfo(session, { notifyPoller: true });

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);
      this.injectDetectedEnvironmentMcp(session);
      this.agentMcpBridge?.onSessionReady(session.id, session.backendType, session.state.cwd);
    } else if (msg.subtype === "status") {
      session.state.is_compacting = msg.status === "compacting";

      if (msg.permissionMode) {
        session.state.permissionMode = msg.permissionMode;
      }

      this.broadcastToBrowsers(session, {
        type: "status_change",
        status: msg.status ?? null,
      });
    }
    // Other system subtypes (compact_boundary, task_notification, etc.) can be forwarded as needed
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
    // CI Layer 1 & 4: extract memory + feed thoughts (non-blocking)
    if (this.collectiveIntelligence) {
      this.collectiveIntelligence.processAgentMessage(
        session.id,
        session.backendType,
        browserMsg,
        { branch: session.state.git_branch ?? "unknown", repoRoot: session.state.repo_root ?? session.state.cwd ?? "" },
      );
    }
  }

  // Regex to extract heredoc content from: cat > file <<'EOF'\n...\nEOF
  // Matches both <<'EOF' and <<EOF variants
  private static readonly HEREDOC_RE = /cat\s+>\s+\S+\s+<<'?EOF'?\n([\s\S]*?)\nEOF/g;

  /** Count lines added/removed from a single tool_use block. */
  private countLinesFromToolBlock(
    block: { name: string; input: Record<string, unknown> },
  ): { added: number; removed: number } {
    const input = block.input;

    if (block.name === "Write" && typeof input.content === "string") {
      return { added: input.content.split("\n").length, removed: 0 };
    }

    if (block.name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
      const oldLines = input.old_string.split("\n").length;
      const newLines = input.new_string.split("\n").length;
      const diff = newLines - oldLines;
      return diff > 0 ? { added: diff, removed: 0 } : { added: 0, removed: -diff };
    }

    if (block.name === "Bash" && typeof input.command === "string") {
      let addedLines = 0;
      WsBridge.HEREDOC_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WsBridge.HEREDOC_RE.exec(input.command)) !== null) {
        addedLines += match[1].split("\n").length;
      }
      return { added: addedLines, removed: 0 };
    }

    return { added: 0, removed: 0 };
  }

  /**
   * Compute lines added/removed by scanning tool_use blocks in message history.
   * Handles Claude (Write/Edit), Codex (Bash heredocs), and other backends.
   * Used as fallback when git-based line counting isn't available (non-git repos).
   */
  private computeLinesFromToolBlocks(session: Session): { added: number; removed: number } {
    let added = 0;
    let removed = 0;

    for (const histMsg of session.messageHistory) {
      if ((histMsg as any).type !== "assistant") continue;
      const content = (histMsg as any).message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const delta = this.countLinesFromToolBlock(block);
        added += delta.added;
        removed += delta.removed;
      }
    }

    return { added, removed };
  }

  /** Update session state fields from a CLI result message (cost, turns, duration, lines). */
  private applyResultToSessionState(session: Session, msg: CLIResultMessage): void {
    // Only update cost if the new value is higher — slash commands like /cost
    // can emit result messages with total_cost_usd: 0, which would erase the
    // accumulated cost. The CLI's total_cost_usd is cumulative and should only rise.
    if (typeof msg.total_cost_usd === "number" && msg.total_cost_usd > (session.state.total_cost_usd || 0)) {
      session.state.total_cost_usd = msg.total_cost_usd;
    }
    session.state.num_turns = msg.num_turns;

    // Accumulate API duration across turns
    if (typeof msg.duration_api_ms === "number" && msg.duration_api_ms > 0) {
      session.state.total_duration_api_ms =
        (session.state.total_duration_api_ms || 0) + msg.duration_api_ms;
    }

    // Update lines changed (CLI may send these in result)
    if (typeof msg.total_lines_added === "number") {
      session.state.total_lines_added = msg.total_lines_added;
    }
    if (typeof msg.total_lines_removed === "number") {
      session.state.total_lines_removed = msg.total_lines_removed;
    }
  }

  /** Compute context usage from modelUsage and store Claude token details. */
  private applyModelUsage(session: Session, msg: CLIResultMessage): void {
    if (!msg.modelUsage) return;

    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
    let contextWindow = 0, totalCostUsd = 0;
    for (const usage of Object.values(msg.modelUsage)) {
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
      totalCacheRead += usage.cacheReadInputTokens;
      totalCacheCreation += usage.cacheCreationInputTokens;
      totalCostUsd += usage.costUSD ?? 0;
      if (usage.contextWindow > 0) {
        contextWindow = usage.contextWindow;
        const pct = Math.round(
          ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
        );
        session.state.context_used_percent = Math.max(0, Math.min(pct, 100));
      }
    }
    session.state.claude_token_details = {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadInputTokens: totalCacheRead,
      cacheCreationInputTokens: totalCacheCreation,
      contextWindow,
      costUsd: totalCostUsd,
    };
  }

  /** Emit result-related webhooks (turn.completed, session.completed/failed, cost threshold). */
  private emitResultWebhooks(session: Session, msg: CLIResultMessage): void {
    if (!this.webhookManager) return;
    const webhookData = {
      backendType: session.backendType,
      cwd: session.state.cwd,
      model: session.state.model,
      totalCostUsd: msg.total_cost_usd,
      numTurns: msg.num_turns,
      isError: msg.is_error,
    };
    this.webhookManager.emit("turn.completed", session.id, webhookData);
    if (msg.is_error) {
      this.webhookManager.emit("session.failed", session.id, webhookData);
    } else {
      this.webhookManager.emit("session.completed", session.id, webhookData);
    }
    this.webhookManager.checkCostThreshold(session.id, msg.total_cost_usd);
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage) {
    this.applyResultToSessionState(session, msg);
    this.applyModelUsage(session, msg);

    // Re-check git state after each turn (also computes lines added/removed).
    this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });

    // Fallback: if git didn't produce line counts (non-git repo or no commits),
    // compute from Edit/Write tool blocks in message history.
    if (!session.state.total_lines_added && !session.state.total_lines_removed) {
      const { added, removed } = this.computeLinesFromToolBlocks(session);
      if (added > 0 || removed > 0) {
        session.state.total_lines_added = added;
        session.state.total_lines_removed = removed;
      }
    }

    // Always push updated stats to browsers (duration, lines may not trigger git change detection)
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        total_duration_api_ms: session.state.total_duration_api_ms,
        total_lines_added: session.state.total_lines_added,
        total_lines_removed: session.state.total_lines_removed,
      },
    });

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);

    this.emitResultWebhooks(session, msg);

    // Trigger auto-naming after the first successful result
    this.tryAutoNaming(session, browserMsg);
  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage) {
    this.broadcastToBrowsers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
    if (msg.request.subtype === "can_use_tool") {
      if (this.agentMcpBridge?.handlePermissionRequest?.(session.id, msg)) {
        return;
      }
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });
      this.persistSession(session);

      // Emit webhook: permission.requested
      this.webhookManager?.emit("permission.requested", session.id, {
        backendType: session.backendType,
        toolName: perm.tool_name,
        requestId: perm.request_id,
      });
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleAuthStatus(session: Session, msg: CLIAuthStatusMessage) {
    this.broadcastToBrowsers(session, {
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // ── Browser message routing ─────────────────────────────────────────────

  /** Message types that spectators are NOT allowed to send. */
  private static readonly SPECTATOR_BLOCKED_TYPES = new Set<string>([
    "user_message",
    "permission_response",
    "interrupt",
    "set_model",
    "set_permission_mode",
    "mcp_toggle",
    "mcp_reconnect",
    "mcp_set_servers",
    // CI actions — spectators can observe but not mutate
    "memory_store",
    "deliberation_respond",
    "deliberation_resolve",
    "route_task",
    "inject_thought",
  ]);

  private static readonly CI_MESSAGE_TYPES = new Set([
    "memory_query", "memory_store", "deliberation_respond",
    "deliberation_resolve", "route_task", "inject_thought",
    "capability_probe_response",
  ]);

  /** Intercept CI-specific messages. Returns true if the message was consumed by CI. */
  private interceptCIMessage(session: Session, msg: BrowserOutgoingMessage): boolean {
    if (!this.collectiveIntelligence) return false;
    if (!WsBridge.CI_MESSAGE_TYPES.has(msg.type)) return false;

    // These are fully consumed by CI — don't forward to agent
    this.collectiveIntelligence.processBrowserMessage(session.id, msg).catch((err) => {
      console.warn("[ws-bridge] CI processBrowserMessage error:", err);
    });
    return true;
  }

  /** Route a browser message to an adapter-based backend (Codex, Goose, etc.). */
  private routeToAdapter(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ): void {
    // Store user messages in history for replay with stable ID for dedup on reconnect
    if (msg.type === "user_message") {
      const ts = Date.now();
      session.messageHistory.push({
        type: "user_message",
        content: msg.content,
        timestamp: ts,
        id: `user-${ts}-${this.userMsgCounter++}`,
      });
      this.persistSession(session);
    }

    // Permission responses go through voting system for multi-viewer sessions
    let outboundMsg = msg;
    if (msg.type === "permission_response") {
      const eligibleVoters = this.countEligibleVoters(session);
      if (eligibleVoters > 1) {
        this.recordVote(session, msg.request_id, ws, msg.behavior, msg);
        return;
      }
      const pending = session.pendingPermissions.get(msg.request_id);
      if (session.backendType === "claude" && msg.behavior === "allow" && !msg.updated_input && pending) {
        outboundMsg = { ...msg, updated_input: pending.input };
      }
      session.pendingPermissions.delete(msg.request_id);
      this.persistSession(session);
    }

    if (session.adapter) {
      session.adapter.sendBrowserMessage(outboundMsg);
    } else {
      // Adapter not yet attached — queue for when it's ready.
      console.log(`[ws-bridge] ${session.backendType} adapter not yet attached for session ${session.id}, queuing ${msg.type}`);
      session.pendingMessages.push(JSON.stringify(outboundMsg));
    }
  }

  /** Route a browser message to the Claude Code CLI backend. */
  private routeToClaude(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ): void {
    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(session, msg);
        break;
      case "permission_response":
        this.handlePermissionResponse(session, msg, ws);
        break;
      case "interrupt":
        this.handleInterrupt(session);
        break;
      case "set_model":
        this.handleSetModel(session, msg.model);
        break;
      case "set_permission_mode":
        this.handleSetPermissionMode(session, msg.mode);
        break;
      case "mcp_get_status":
        this.handleMcpGetStatus(session);
        break;
      case "mcp_toggle":
        this.handleMcpToggle(session, msg.serverName, msg.enabled);
        break;
      case "mcp_reconnect":
        this.handleMcpReconnect(session, msg.serverName);
        break;
      case "mcp_set_servers":
        this.handleMcpSetServers(session, msg.servers);
        break;
    }
  }

  private routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ) {
    if (msg.type === "session_subscribe") {
      this.handleSessionSubscribe(session, ws, msg.last_seq);
      return;
    }

    if (msg.type === "session_ack") {
      this.handleSessionAck(session, ws, msg.last_seq);
      return;
    }

    if (this.interceptCIMessage(session, msg)) return;

    // Visibility-only scan for explicit server sets (user, agent bridge,
    // queued flushes). Never blocks — the user's own action wins — but
    // suspicious configs are logged for the audit trail.
    if (msg.type === "mcp_set_servers") {
      for (const finding of scanMcpServers(msg.servers)) {
        console.warn(`[ws-bridge] MCP scan ${finding.severity} for session ${session.id}: ${finding.server} — ${finding.reason}`);
      }
    }

    // RBAC enforcement: spectators can only subscribe/ack and read MCP status
    if (ws) {
      const browserData = ws.data as BrowserSocketData;
      if (browserData.role === "spectator" && WsBridge.SPECTATOR_BLOCKED_TYPES.has(msg.type)) {
        this.sendToBrowser(ws, {
          type: "error",
          message: "Spectators cannot perform this action",
        });
        return;
      }
    }

    if (
      WsBridge.IDEMPOTENT_BROWSER_MESSAGE_TYPES.has(msg.type)
      && "client_msg_id" in msg
      && msg.client_msg_id
    ) {
      if (this.isDuplicateClientMessage(session, msg.client_msg_id)) {
        return;
      }
      this.rememberClientMessage(session, msg.client_msg_id);
    }

    if (session.adapter) {
      this.routeToAdapter(session, msg, ws);
    } else if (session.backendType === "claude") {
      this.routeToClaude(session, msg, ws);
    } else {
      this.routeToAdapter(session, msg, ws);
    }
  }

  private isDuplicateClientMessage(session: Session, clientMsgId: string): boolean {
    return session.processedClientMessageIdSet.has(clientMsgId);
  }

  private rememberClientMessage(session: Session, clientMsgId: string): void {
    session.processedClientMessageIds.push(clientMsgId);
    session.processedClientMessageIdSet.add(clientMsgId);
    if (session.processedClientMessageIds.length > WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT) {
      const overflow = session.processedClientMessageIds.length - WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT;
      const removed = session.processedClientMessageIds.splice(0, overflow);
      for (const id of removed) {
        session.processedClientMessageIdSet.delete(id);
      }
    }
    this.persistSession(session);
  }

  private handleSessionSubscribe(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    if (!ws) return;
    const data = ws.data as BrowserSocketData;
    data.subscribed = true;
    const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    data.lastAckSeq = lastAckSeq;

    if (session.eventBuffer.length === 0) return;
    if (lastAckSeq >= session.nextEventSeq - 1) return;

    const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
    const hasGap = lastAckSeq > 0 && lastAckSeq < earliest - 1;
    if (hasGap) {
      this.sendToBrowser(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
      const transientMissed = session.eventBuffer
        .filter((evt) => evt.seq > lastAckSeq && !this.isHistoryBackedEvent(evt.message));
      if (transientMissed.length > 0) {
        this.sendToBrowser(ws, {
          type: "event_replay",
          events: transientMissed,
        });
      }
      return;
    }

    const missed = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
    if (missed.length === 0) return;
    this.sendToBrowser(ws, {
      type: "event_replay",
      events: missed,
    });
  }

  private handleSessionAck(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    if (ws) {
      const data = ws.data as BrowserSocketData;
      const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
      data.lastAckSeq = Math.max(prior, normalized);
    }
    if (normalized > session.lastAckSeq) {
      session.lastAckSeq = normalized;
      this.persistSession(session);
    }
  }

  private handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  ) {
    // Store user message in history for replay with stable ID for dedup on reconnect
    const ts = Date.now();
    session.messageHistory.push({
      type: "user_message",
      content: msg.content,
      timestamp: ts,
      id: `user-${ts}-${this.userMsgCounter++}`,
    });

    // Build content: if images are present, use content block array; otherwise plain string
    let content: string | unknown[];
    if (msg.images?.length) {
      const blocks: unknown[] = [];
      for (const img of msg.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.media_type, data: img.data },
        });
      }
      blocks.push({ type: "text", text: msg.content });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || session.state.session_id || "",
    });
    this.sendToCLI(session, ndjson);
    this.persistSession(session);
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string },
    ws?: ServerWebSocket<SocketData>,
  ) {
    // Count eligible voters (owner + collaborators, not spectators)
    const eligibleVoters = this.countEligibleVoters(session);

    // Single voter or owner-decides policy — resolve immediately
    if (eligibleVoters <= 1 || this.votingPolicy === "owner-decides") {
      // For owner-decides, only the owner's vote counts
      if (this.votingPolicy === "owner-decides" && ws) {
        const browserData = ws.data as BrowserSocketData;
        if (browserData.role !== "owner") {
          // Record vote but don't resolve — wait for owner
          this.recordVote(session, msg.request_id, ws, msg.behavior, msg);
          return;
        }
      }
      this.resolvePermission(session, msg.request_id, msg.behavior, msg);
      return;
    }

    // Multi-voter: collect votes
    this.recordVote(session, msg.request_id, ws, msg.behavior, msg);
  }

  /** Count browsers with voting rights (owner + collaborators). */
  private countEligibleVoters(session: Session): number {
    let count = 0;
    for (const ws of session.browserSockets) {
      const data = ws.data as BrowserSocketData;
      if (data.role === "owner" || data.role === "collaborator") {
        count++;
      }
    }
    return count;
  }

  /** Record a vote for a permission request and check if the vote can be resolved. */
  private recordVote(
    session: Session,
    requestId: string,
    ws: ServerWebSocket<SocketData> | undefined,
    behavior: "allow" | "deny",
    templateMsg: { updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string },
  ): void {
    const viewerId = ws ? (ws.data as BrowserSocketData).viewerId || "unknown" : "system";
    const viewerName = ws ? (ws.data as BrowserSocketData).viewerName || "Unknown" : "System";

    let collection = session.pendingVotes.get(requestId);
    if (!collection) {
      const deadline = Date.now() + WsBridge.VOTE_DEADLINE_MS;
      collection = {
        requestId,
        votes: new Map(),
        deadline,
        timer: setTimeout(() => this.resolveVoteByDeadline(session, requestId), WsBridge.VOTE_DEADLINE_MS),
        templateMsg,
      };
      session.pendingVotes.set(requestId, collection);
    }

    collection.votes.set(viewerId, {
      viewerId,
      viewerName,
      vote: behavior,
      timestamp: Date.now(),
    });

    const eligibleVoters = this.countEligibleVoters(session);

    // Broadcast vote update to all browsers
    this.broadcastToBrowsers(session, {
      type: "vote_update",
      request_id: requestId,
      votes: Array.from(collection.votes.values()),
      voters_total: eligibleVoters,
      deadline: collection.deadline,
    });

    // Check for early resolution
    this.checkVoteResolution(session, requestId);
  }

  /** Check if all votes are in or if the policy allows early resolution. */
  private checkVoteResolution(session: Session, requestId: string): void {
    const collection = session.pendingVotes.get(requestId);
    if (!collection) return;

    const eligibleVoters = this.countEligibleVoters(session);
    const votes = Array.from(collection.votes.values());
    const allowCount = votes.filter((v) => v.vote === "allow").length;
    const denyCount = votes.filter((v) => v.vote === "deny").length;

    let resolved: "allow" | "deny" | null = null;

    switch (this.votingPolicy) {
      case "any-deny-blocks":
        if (denyCount > 0) resolved = "deny";
        else if (allowCount >= eligibleVoters) resolved = "allow";
        break;

      case "majority-rules":
        // Early resolution if majority is already decided
        if (allowCount > eligibleVoters / 2) resolved = "allow";
        else if (denyCount > eligibleVoters / 2) resolved = "deny";
        // Also resolve if all votes are in
        else if (votes.length >= eligibleVoters) {
          resolved = allowCount >= denyCount ? "allow" : "deny";
        }
        break;

      case "owner-decides":
        // Should not reach here — handled in handlePermissionResponse
        break;
    }

    if (resolved) {
      clearTimeout(collection.timer);
      session.pendingVotes.delete(requestId);
      this.broadcastToBrowsers(session, {
        type: "vote_resolved",
        request_id: requestId,
        result: resolved,
        policy: this.votingPolicy,
      });
      this.resolvePermission(session, requestId, resolved, collection.templateMsg);
    }
  }

  /** Called when the voting deadline expires — resolve with votes cast so far. */
  private resolveVoteByDeadline(session: Session, requestId: string): void {
    const collection = session.pendingVotes.get(requestId);
    if (!collection) return;

    session.pendingVotes.delete(requestId);
    const votes = Array.from(collection.votes.values());
    const allowCount = votes.filter((v) => v.vote === "allow").length;
    const denyCount = votes.filter((v) => v.vote === "deny").length;

    let result: "allow" | "deny";
    switch (this.votingPolicy) {
      case "any-deny-blocks":
        result = denyCount > 0 ? "deny" : "allow";
        break;
      case "majority-rules":
      default:
        result = allowCount >= denyCount ? "allow" : "deny";
        break;
    }

    this.broadcastToBrowsers(session, {
      type: "vote_resolved",
      request_id: requestId,
      result,
      policy: this.votingPolicy,
    });
    this.resolvePermission(session, requestId, result, collection.templateMsg);
  }

  /** Send the final permission response to the backend (CLI or adapter). */
  private resolvePermission(
    session: Session,
    requestId: string,
    behavior: "allow" | "deny",
    msg: { updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string },
  ): void {
    const pending = session.pendingPermissions.get(requestId);
    session.pendingPermissions.delete(requestId);
    this.persistSession(session);

    // Emit webhook: permission.resolved
    this.webhookManager?.emit("permission.resolved", session.id, {
      backendType: session.backendType,
      requestId,
      behavior,
      toolName: pending?.tool_name,
    });

    // For adapter-based sessions, send via adapter
    if (session.adapter) {
      session.adapter.sendBrowserMessage({
        type: "permission_response",
        request_id: requestId,
        behavior,
        updated_input: msg.updated_input,
        updated_permissions: msg.updated_permissions as import("./session-types.js").PermissionUpdate[] | undefined,
        message: msg.message,
      });
      return;
    }

    // Claude Code path — send NDJSON to CLI
    if (behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? pending?.input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      this.sendToCLI(session, JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response,
        },
      }));
    } else {
      this.sendToCLI(session, JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by vote",
          },
        },
      }));
    }
  }

  private handleInterrupt(session: Session) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetModel(session: Session, model: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetPermissionMode(session: Session, mode: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToCLI(session, ndjson);
  }

  // ── Control response handling ─────────────────────────────────────────

  private handleControlResponse(
    session: Session,
    msg: CLIControlResponseMessage,
  ) {
    const reqId = msg.response.request_id;
    const pending = session.pendingControlRequests.get(reqId);
    if (!pending) return; // Not a request we're tracking
    session.pendingControlRequests.delete(reqId);

    if (msg.response.subtype === "error") {
      console.warn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
      return;
    }

    pending.resolve(msg.response.response ?? {});
  }

  // ── MCP control messages ──────────────────────────────────────────────

  /** Send a control_request to CLI, optionally tracking the response via a callback. */
  private sendControlRequest(
    session: Session,
    request: Record<string, unknown>,
    onResponse?: PendingControlRequest,
  ) {
    const requestId = randomUUID();
    if (onResponse) {
      session.pendingControlRequests.set(requestId, onResponse);
    }
    this.sendToCLI(session, JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    }));
  }

  private handleMcpGetStatus(session: Session) {
    this.sendControlRequest(session, { subtype: "mcp_status" }, {
      subtype: "mcp_status",
      resolve: (response) => {
        const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
        this.broadcastToBrowsers(session, { type: "mcp_status", servers });
      },
    });
  }

  private handleMcpToggle(session: Session, serverName: string, enabled: boolean) {
    this.sendControlRequest(session, { subtype: "mcp_toggle", serverName, enabled });
    setTimeout(() => this.handleMcpGetStatus(session), 500);
  }

  private handleMcpReconnect(session: Session, serverName: string) {
    this.sendControlRequest(session, { subtype: "mcp_reconnect", serverName });
    setTimeout(() => this.handleMcpGetStatus(session), 1000);
  }

  private handleMcpSetServers(session: Session, servers: Record<string, McpServerConfig>) {
    this.sendControlRequest(session, { subtype: "mcp_set_servers", servers });
    setTimeout(() => this.handleMcpGetStatus(session), 2000);
  }

  // ── Transport helpers ───────────────────────────────────────────────────

  private sendToCLI(session: Session, ndjson: string) {
    if (!session.cliSocket) {
      // Queue the message — CLI might still be starting up.
      // Don't record here; the message will be recorded when flushed.
      console.log(`[ws-bridge] CLI not yet connected for session ${session.id}, queuing message`);
      session.pendingMessages.push(ndjson);
      return;
    }
    // Record raw outgoing CLI message (only when actually sending, not when queuing)
    this.recorder?.record(session.id, "out", ndjson, "cli", session.backendType, session.state.cwd);
    try {
      // NDJSON requires a newline delimiter
      session.cliSocket.send(ndjson + "\n");
    } catch (err) {
      console.error(`[ws-bridge] Failed to send to CLI for session ${session.id}:`, err);
    }
  }

  /** Push a session name update to all connected browsers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, { type: "session_name_update", name });
  }

  private shouldBufferForReplay(msg: BrowserIncomingMessage): msg is ReplayableBrowserIncomingMessage {
    return msg.type !== "session_init"
      && msg.type !== "message_history"
      && msg.type !== "event_replay";
  }

  private isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
    return msg.type === "assistant"
      || msg.type === "result"
      || msg.type === "user_message"
      || msg.type === "error";
  }

  private sequenceEvent(
    session: Session,
    msg: BrowserIncomingMessage,
  ): BrowserIncomingMessage {
    const seq = session.nextEventSeq++;
    const sequenced = { ...msg, seq };
    if (this.shouldBufferForReplay(msg)) {
      session.eventBuffer.push({ seq, message: msg });
      if (session.eventBuffer.length > WsBridge.EVENT_BUFFER_LIMIT) {
        session.eventBuffer.splice(0, session.eventBuffer.length - WsBridge.EVENT_BUFFER_LIMIT);
      }
      this.persistSession(session);
    }
    return sequenced;
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    // Debug: warn when assistant messages are broadcast to 0 browsers (they may be lost)
    if (session.browserSockets.size === 0 && (msg.type === "assistant" || msg.type === "stream_event" || msg.type === "result")) {
      console.log(`[ws-bridge] ⚠ Broadcasting ${msg.type} to 0 browsers for session ${session.id} (stored in history: ${msg.type === "assistant" || msg.type === "result"})`);
    }
    const json = JSON.stringify(this.sequenceEvent(session, msg));

    // Record raw outgoing browser message
    this.recorder?.record(session.id, "out", json, "browser", session.backendType, session.state.cwd);
    this.protocolMonitor?.recordMessage(session.id, "out", "browser", msg.type, session.backendType);

    for (const ws of session.browserSockets) {
      try {
        ws.send(json);
      } catch {
        session.browserSockets.delete(ws);
      }
    }
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket will be cleaned up on close
    }
  }
}
