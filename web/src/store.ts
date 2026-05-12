import { create } from "zustand";
import type { SessionState, PermissionRequest, ChatMessage, SdkSessionInfo, TaskItem, BackgroundAgentItem, McpServerDetail, SessionRole, PresenceViewer, PermissionVote, VotingPolicy } from "./types.js";
import type { UpdateInfo, PRStatusResponse } from "./api.js";

interface AppState {
  // Sessions
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;

  // Messages per session
  messages: Map<string, ChatMessage[]>;

  // Streaming partial text per session
  streaming: Map<string, string>;

  // Streaming stats: start time + output tokens
  streamingStartedAt: Map<string, number>;
  streamingOutputTokens: Map<string, number>;

  // Pending permissions per session (outer key = sessionId, inner key = request_id)
  pendingPermissions: Map<string, Map<string, PermissionRequest>>;

  // Connection state per session
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliLaunching: Map<string, boolean>;

  // Session status
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;

  // Plan mode: stores previous permission mode per session so we can restore it
  previousPermissionMode: Map<string, string>;

  // Tasks per session
  sessionTasks: Map<string, TaskItem[]>;

  // Background agents per session (Agent tool calls with run_in_background)
  sessionBackgroundAgents: Map<string, BackgroundAgentItem[]>;

  // Terminal child subagent sessions, keyed by child session ID.
  completedSubagentSessions: Map<string, "completed" | "failed" | "timeout">;

  // Files changed by the agent per session (Edit/Write tool calls)
  changedFiles: Map<string, Set<string>>;

  // Session display names
  sessionNames: Map<string, string>;
  // Track sessions that were just renamed (for animation)
  recentlyRenamed: Set<string>;

  // PR status per session (pushed by server via WebSocket)
  prStatus: Map<string, PRStatusResponse>;

  // MCP servers per session
  mcpServers: Map<string, McpServerDetail[]>;

  // Tool progress (session → tool_use_id → progress info)
  toolProgress: Map<string, Map<string, { toolName: string; elapsedSeconds: number }>>;

  // Sidebar project grouping
  collapsedProjects: Set<string>;

  // Session start times (for duration calculation in cost cards)
  sessionStartTimes: Map<string, number>;

  // Presence: connected viewers per session
  sessionViewers: Map<string, PresenceViewer[]>;

  // This browser's role and viewer ID per session
  myRole: Map<string, SessionRole>;
  myViewerId: Map<string, string>;

  // Permission voting state per session (request_id → vote info)
  permissionVotes: Map<string, Map<string, { votes: PermissionVote[]; votersTotal: number; deadline: number }>>;
  voteResults: Map<string, Map<string, { result: "allow" | "deny"; policy: VotingPolicy }>>;

  // Message queue per session (buffered messages to send when agent becomes idle)
  messageQueue: Map<string, string[]>;

  // Replay state
  replaySpeed: number;
  replayState: "idle" | "playing" | "paused" | "ended";
  replaySessionId: string | null;

  // Update info
  updateInfo: UpdateInfo | null;
  updateDismissedVersion: string | null;
  updateOverlayActive: boolean;

  // UI
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  homeResetKey: number;
  activeTab: "chat" | "diff" | "files";
  diffPanelSelectedFile: Map<string, string>;

  // Actions
  setDarkMode: (v: boolean) => void;
  toggleDarkMode: () => void;
  setNotificationSound: (v: boolean) => void;
  toggleNotificationSound: () => void;
  setNotificationDesktop: (v: boolean) => void;
  toggleNotificationDesktop: () => void;
  setSidebarOpen: (v: boolean) => void;
  setTaskPanelOpen: (open: boolean) => void;
  newSession: () => void;

  // Session actions
  setCurrentSession: (id: string | null) => void;
  addSession: (session: SessionState) => void;
  updateSession: (sessionId: string, updates: Partial<SessionState>) => void;
  removeSession: (sessionId: string) => void;
  setSdkSessions: (sessions: SdkSessionInfo[]) => void;

  // Message actions
  appendMessage: (sessionId: string, msg: ChatMessage) => void;
  setMessages: (sessionId: string, msgs: ChatMessage[]) => void;
  updateLastAssistantMessage: (sessionId: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  setStreaming: (sessionId: string, text: string | null) => void;
  setStreamingStats: (sessionId: string, stats: { startedAt?: number; outputTokens?: number } | null) => void;

  // Permission actions
  addPermission: (sessionId: string, perm: PermissionRequest) => void;
  removePermission: (sessionId: string, requestId: string) => void;

  // Task actions
  addTask: (sessionId: string, task: TaskItem) => void;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  updateTask: (sessionId: string, taskId: string, updates: Partial<TaskItem>) => void;

  // Background agent actions
  addBackgroundAgent: (sessionId: string, agent: BackgroundAgentItem) => void;
  updateBackgroundAgent: (sessionId: string, toolUseId: string, updates: Partial<BackgroundAgentItem>) => void;
  markSubagentSessionTerminal: (sessionId: string, status: "completed" | "failed" | "timeout") => void;

  // Changed files actions
  addChangedFile: (sessionId: string, filePath: string) => void;
  removeChangedFile: (sessionId: string, filePath: string) => void;
  clearChangedFiles: (sessionId: string) => void;

  // Session name actions
  setSessionName: (sessionId: string, name: string) => void;
  markRecentlyRenamed: (sessionId: string) => void;
  clearRecentlyRenamed: (sessionId: string) => void;

  // PR status action
  setPRStatus: (sessionId: string, status: PRStatusResponse) => void;

  // MCP actions
  setMcpServers: (sessionId: string, servers: McpServerDetail[]) => void;

  // Tool progress actions
  setToolProgress: (sessionId: string, toolUseId: string, data: { toolName: string; elapsedSeconds: number }) => void;
  clearToolProgress: (sessionId: string, toolUseId?: string) => void;

  // Sidebar project grouping actions
  toggleProjectCollapse: (projectKey: string) => void;

  // Presence actions
  setSessionViewers: (sessionId: string, viewers: PresenceViewer[]) => void;
  setMyRole: (sessionId: string, role: SessionRole) => void;
  setMyViewerId: (sessionId: string, viewerId: string) => void;

  // Voting actions
  setPermissionVotes: (sessionId: string, requestId: string, data: { votes: PermissionVote[]; votersTotal: number; deadline: number }) => void;
  setVoteResult: (sessionId: string, requestId: string, data: { result: "allow" | "deny"; policy: VotingPolicy }) => void;
  clearVoteState: (sessionId: string, requestId: string) => void;

  // Replay actions
  setReplaySpeed: (speed: number) => void;
  setReplayState: (state: "idle" | "playing" | "paused" | "ended") => void;
  setReplaySessionId: (id: string | null) => void;

  // Message queue actions
  enqueueMessage: (sessionId: string, message: string) => void;
  dequeueMessage: (sessionId: string) => string | undefined;
  clearQueue: (sessionId: string) => void;
  getQueue: (sessionId: string) => string[];

  // Plan mode actions
  setPreviousPermissionMode: (sessionId: string, mode: string) => void;

  // Connection actions
  setConnectionStatus: (sessionId: string, status: "connecting" | "connected" | "disconnected") => void;
  setCliConnected: (sessionId: string, connected: boolean) => void;
  setCliLaunching: (sessionId: string, launching: boolean) => void;
  setSessionStatus: (sessionId: string, status: "idle" | "running" | "compacting" | null) => void;

  // Update actions
  setUpdateInfo: (info: UpdateInfo | null) => void;
  dismissUpdate: (version: string) => void;
  setUpdateOverlayActive: (active: boolean) => void;

  // Diff panel actions
  setActiveTab: (tab: "chat" | "diff" | "files") => void;
  setDiffPanelSelectedFile: (sessionId: string, filePath: string | null) => void;

  // Terminal state
  terminalOpen: boolean;
  terminalCwd: string | null;
  terminalId: string | null;

  // Terminal actions
  setTerminalOpen: (open: boolean) => void;
  setTerminalCwd: (cwd: string | null) => void;
  setTerminalId: (id: string | null) => void;
  openTerminal: (cwd: string) => void;
  closeTerminal: () => void;

  // Container session creation progress
  sessionCreating: boolean;
  creationProgress: { step: string; message: string; percent?: number } | null;
  creationError: string | null;
  setSessionCreating: (creating: boolean) => void;
  setCreationProgress: (progress: { step: string; message: string; percent?: number } | null) => void;
  setCreationError: (error: string | null) => void;

  reset: () => void;
}

function getInitialSessionNames(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    return new Map(JSON.parse(localStorage.getItem("cc-session-names") || "[]"));
  } catch {
    return new Map();
  }
}

function getInitialSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-current-session") || null;
}

function getInitialDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-dark-mode");
  if (stored !== null) return stored === "true";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialNotificationSound(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem("cc-notification-sound");
  if (stored !== null) return stored === "true";
  return true;
}

function getInitialNotificationDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem("cc-notification-desktop");
  if (stored !== null) return stored === "true";
  return false;
}

function getInitialDismissedVersion(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("cc-update-dismissed") || null;
}

function getInitialCollapsedProjects(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem("cc-collapsed-projects") || "[]"));
  } catch {
    return new Set();
  }
}

export const useStore = create<AppState>((set) => ({
  sessions: new Map(),
  sdkSessions: [],
  currentSessionId: getInitialSessionId(),
  messages: new Map(),
  streaming: new Map(),
  streamingStartedAt: new Map(),
  streamingOutputTokens: new Map(),
  pendingPermissions: new Map(),
  connectionStatus: new Map(),
  cliConnected: new Map(),
  cliLaunching: new Map(),
  sessionStatus: new Map(),
  previousPermissionMode: new Map(),
  sessionTasks: new Map(),
  sessionBackgroundAgents: new Map(),
  completedSubagentSessions: new Map(),
  changedFiles: new Map(),
  sessionNames: getInitialSessionNames(),
  recentlyRenamed: new Set(),
  prStatus: new Map(),
  mcpServers: new Map(),
  toolProgress: new Map(),
  collapsedProjects: getInitialCollapsedProjects(),
  sessionStartTimes: new Map(),
  sessionViewers: new Map(),
  myRole: new Map(),
  myViewerId: new Map(),
  permissionVotes: new Map(),
  voteResults: new Map(),
  messageQueue: new Map(),
  replaySpeed: 1,
  replayState: "idle",
  replaySessionId: null,
  updateInfo: null,
  updateDismissedVersion: getInitialDismissedVersion(),
  updateOverlayActive: false,
  darkMode: getInitialDarkMode(),
  notificationSound: getInitialNotificationSound(),
  notificationDesktop: getInitialNotificationDesktop(),
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 768 : true,
  taskPanelOpen: typeof window !== "undefined" ? window.innerWidth >= 1024 : false,
  homeResetKey: 0,
  activeTab: "chat",
  diffPanelSelectedFile: new Map(),
  terminalOpen: false,
  terminalCwd: null,
  terminalId: null,
  sessionCreating: false,
  creationProgress: null,
  creationError: null,

  setDarkMode: (v) => {
    localStorage.setItem("cc-dark-mode", String(v));
    set({ darkMode: v });
  },
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("cc-dark-mode", String(next));
      return { darkMode: next };
    }),
  setNotificationSound: (v) => {
    localStorage.setItem("cc-notification-sound", String(v));
    set({ notificationSound: v });
  },
  toggleNotificationSound: () =>
    set((s) => {
      const next = !s.notificationSound;
      localStorage.setItem("cc-notification-sound", String(next));
      return { notificationSound: next };
    }),
  setNotificationDesktop: (v) => {
    localStorage.setItem("cc-notification-desktop", String(v));
    set({ notificationDesktop: v });
  },
  toggleNotificationDesktop: () =>
    set((s) => {
      const next = !s.notificationDesktop;
      localStorage.setItem("cc-notification-desktop", String(next));
      return { notificationDesktop: next };
    }),
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
  newSession: () => {
    localStorage.removeItem("cc-current-session");
    set((s) => ({ currentSessionId: null, homeResetKey: s.homeResetKey + 1 }));
  },

  setCurrentSession: (id) => {
    if (id) {
      localStorage.setItem("cc-current-session", id);
    } else {
      localStorage.removeItem("cc-current-session");
    }
    set({ currentSessionId: id });
  },

  addSession: (session) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.set(session.session_id, session);
      const messages = new Map(s.messages);
      if (!messages.has(session.session_id)) messages.set(session.session_id, []);
      return { sessions, messages };
    }),

  updateSession: (sessionId, updates) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      const existing = sessions.get(sessionId);
      if (existing) sessions.set(sessionId, { ...existing, ...updates });
      return { sessions };
    }),

  removeSession: (sessionId) =>
    set((s) => {
      const sessions = new Map(s.sessions);
      sessions.delete(sessionId);
      const messages = new Map(s.messages);
      messages.delete(sessionId);
      const streaming = new Map(s.streaming);
      streaming.delete(sessionId);
      const streamingStartedAt = new Map(s.streamingStartedAt);
      streamingStartedAt.delete(sessionId);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      streamingOutputTokens.delete(sessionId);
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.delete(sessionId);
      const cliConnected = new Map(s.cliConnected);
      cliConnected.delete(sessionId);
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.delete(sessionId);
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.delete(sessionId);
      const pendingPermissions = new Map(s.pendingPermissions);
      pendingPermissions.delete(sessionId);
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.delete(sessionId);
      const sessionBackgroundAgents = new Map(s.sessionBackgroundAgents);
      sessionBackgroundAgents.delete(sessionId);
      const completedSubagentSessions = new Map(s.completedSubagentSessions);
      completedSubagentSessions.delete(sessionId);
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      const sessionNames = new Map(s.sessionNames);
      sessionNames.delete(sessionId);
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      diffPanelSelectedFile.delete(sessionId);
      const mcpServers = new Map(s.mcpServers);
      mcpServers.delete(sessionId);
      const toolProgress = new Map(s.toolProgress);
      toolProgress.delete(sessionId);
      const prStatus = new Map(s.prStatus);
      prStatus.delete(sessionId);
      const sessionStartTimes = new Map(s.sessionStartTimes);
      sessionStartTimes.delete(sessionId);
      const sessionViewers = new Map(s.sessionViewers);
      sessionViewers.delete(sessionId);
      const myRole = new Map(s.myRole);
      myRole.delete(sessionId);
      const myViewerId = new Map(s.myViewerId);
      myViewerId.delete(sessionId);
      const permissionVotes = new Map(s.permissionVotes);
      permissionVotes.delete(sessionId);
      const voteResults = new Map(s.voteResults);
      voteResults.delete(sessionId);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      if (s.currentSessionId === sessionId) {
        localStorage.removeItem("cc-current-session");
      }
      return {
        sessions,
        messages,
        streaming,
        streamingStartedAt,
        streamingOutputTokens,
        connectionStatus,
        cliConnected,
        sessionStatus,
        previousPermissionMode,
        pendingPermissions,
        sessionTasks,
        sessionBackgroundAgents,
        completedSubagentSessions,
        changedFiles,
        sessionNames,
        recentlyRenamed,
        diffPanelSelectedFile,
        mcpServers,
        toolProgress,
        prStatus,
        sessionStartTimes,
        sessionViewers,
        myRole,
        myViewerId,
        permissionVotes,
        voteResults,
        sdkSessions: s.sdkSessions.filter((sdk) => sdk.sessionId !== sessionId),
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      };
    }),

  setSdkSessions: (sessions) =>
    set((s) => {
      const exitedSessions = sessions.filter((session) => session.state === "exited");
      const exitedIds = new Set(exitedSessions.map((session) => session.sessionId));
      if (exitedIds.size === 0) return { sdkSessions: sessions };

      const cliConnected = new Map(s.cliConnected);
      const cliLaunching = new Map(s.cliLaunching);
      const completedSubagentSessions = new Map(s.completedSubagentSessions);
      for (const sessionId of exitedIds) {
        cliConnected.set(sessionId, false);
        cliLaunching.delete(sessionId);
      }
      for (const session of exitedSessions) {
        if (session.orchestrationRole === "subagent" || session.parentSessionId) {
          completedSubagentSessions.set(
            session.sessionId,
            completedSubagentSessions.get(session.sessionId) ?? "completed",
          );
        }
      }
      return { sdkSessions: sessions, cliConnected, cliLaunching, completedSubagentSessions };
    }),

  appendMessage: (sessionId, msg) =>
    set((s) => {
      const existing = s.messages.get(sessionId) || [];
      // Claude Code sends the same message ID in multiple parts (thinking, text, tool_use).
      // When a message with the same ID exists, merge content blocks instead of dropping.
      const existingIdx = msg.id ? existing.findIndex((m) => m.id === msg.id) : -1;
      if (existingIdx >= 0) {
        const prev = existing[existingIdx];
        const mergedBlocks = [
          ...(prev.contentBlocks || []),
          ...(msg.contentBlocks || []),
        ];
        const mergedText = [prev.content, msg.content].filter(Boolean).join("\n");
        const updated = [...existing];
        updated[existingIdx] = {
          ...prev,
          content: mergedText,
          contentBlocks: mergedBlocks,
          // Keep latest stop_reason and model
          stopReason: msg.stopReason || prev.stopReason,
          model: msg.model || prev.model,
        };
        const messages = new Map(s.messages);
        messages.set(sessionId, updated);
        return { messages };
      }
      const messages = new Map(s.messages);
      messages.set(sessionId, [...existing, msg]);
      return { messages };
    }),

  setMessages: (sessionId, msgs) =>
    set((s) => {
      const messages = new Map(s.messages);
      messages.set(sessionId, msgs);
      return { messages };
    }),

  updateLastAssistantMessage: (sessionId, updater) =>
    set((s) => {
      const messages = new Map(s.messages);
      const list = [...(messages.get(sessionId) || [])];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].role === "assistant") {
          list[i] = updater(list[i]);
          break;
        }
      }
      messages.set(sessionId, list);
      return { messages };
    }),

  setStreaming: (sessionId, text) =>
    set((s) => {
      const streaming = new Map(s.streaming);
      if (text === null) {
        streaming.delete(sessionId);
      } else {
        streaming.set(sessionId, text);
      }
      return { streaming };
    }),

  setStreamingStats: (sessionId, stats) =>
    set((s) => {
      const streamingStartedAt = new Map(s.streamingStartedAt);
      const streamingOutputTokens = new Map(s.streamingOutputTokens);
      if (stats === null) {
        streamingStartedAt.delete(sessionId);
        streamingOutputTokens.delete(sessionId);
      } else {
        if (stats.startedAt !== undefined) streamingStartedAt.set(sessionId, stats.startedAt);
        if (stats.outputTokens !== undefined) streamingOutputTokens.set(sessionId, stats.outputTokens);
      }
      return { streamingStartedAt, streamingOutputTokens };
    }),

  addPermission: (sessionId, perm) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = new Map(pendingPermissions.get(sessionId) || []);
      sessionPerms.set(perm.request_id, perm);
      pendingPermissions.set(sessionId, sessionPerms);
      return { pendingPermissions };
    }),

  removePermission: (sessionId, requestId) =>
    set((s) => {
      const pendingPermissions = new Map(s.pendingPermissions);
      const sessionPerms = pendingPermissions.get(sessionId);
      if (sessionPerms) {
        const updated = new Map(sessionPerms);
        updated.delete(requestId);
        pendingPermissions.set(sessionId, updated);
      }
      return { pendingPermissions };
    }),

  addTask: (sessionId, task) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = [...(sessionTasks.get(sessionId) || []), task];
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  setTasks: (sessionId, tasks) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),

  updateTask: (sessionId, taskId, updates) =>
    set((s) => {
      const sessionTasks = new Map(s.sessionTasks);
      const tasks = sessionTasks.get(sessionId);
      if (tasks) {
        sessionTasks.set(
          sessionId,
          tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
        );
      }
      return { sessionTasks };
    }),

  addBackgroundAgent: (sessionId, agent) =>
    set((s) => {
      const sessionBackgroundAgents = new Map(s.sessionBackgroundAgents);
      const agents = [...(sessionBackgroundAgents.get(sessionId) || []), agent];
      sessionBackgroundAgents.set(sessionId, agents);
      return { sessionBackgroundAgents };
    }),

  updateBackgroundAgent: (sessionId, toolUseId, updates) =>
    set((s) => {
      const sessionBackgroundAgents = new Map(s.sessionBackgroundAgents);
      const agents = sessionBackgroundAgents.get(sessionId);
      if (agents) {
        sessionBackgroundAgents.set(
          sessionId,
          agents.map((a) => (a.toolUseId === toolUseId ? { ...a, ...updates } : a)),
        );
      }
      return { sessionBackgroundAgents };
    }),

  markSubagentSessionTerminal: (sessionId, status) =>
    set((s) => {
      const completedSubagentSessions = new Map(s.completedSubagentSessions);
      completedSubagentSessions.set(sessionId, status);
      return { completedSubagentSessions };
    }),

  addChangedFile: (sessionId, filePath) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      const files = new Set(changedFiles.get(sessionId) || []);
      files.add(filePath);
      changedFiles.set(sessionId, files);
      return { changedFiles };
    }),

  removeChangedFile: (sessionId, filePath) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      const files = changedFiles.get(sessionId);
      if (files?.has(filePath)) {
        const updated = new Set(files);
        updated.delete(filePath);
        changedFiles.set(sessionId, updated);
        return { changedFiles };
      }
      return s;
    }),

  clearChangedFiles: (sessionId) =>
    set((s) => {
      const changedFiles = new Map(s.changedFiles);
      changedFiles.delete(sessionId);
      return { changedFiles };
    }),

  setSessionName: (sessionId, name) =>
    set((s) => {
      const sessionNames = new Map(s.sessionNames);
      sessionNames.set(sessionId, name);
      localStorage.setItem("cc-session-names", JSON.stringify(Array.from(sessionNames.entries())));
      return { sessionNames };
    }),

  markRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.add(sessionId);
      return { recentlyRenamed };
    }),

  clearRecentlyRenamed: (sessionId) =>
    set((s) => {
      const recentlyRenamed = new Set(s.recentlyRenamed);
      recentlyRenamed.delete(sessionId);
      return { recentlyRenamed };
    }),

  setPRStatus: (sessionId, status) =>
    set((s) => {
      const prStatus = new Map(s.prStatus);
      prStatus.set(sessionId, status);
      return { prStatus };
    }),

  setMcpServers: (sessionId, servers) =>
    set((s) => {
      const mcpServers = new Map(s.mcpServers);
      mcpServers.set(sessionId, servers);
      return { mcpServers };
    }),

  setToolProgress: (sessionId, toolUseId, data) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      const sessionProgress = new Map(toolProgress.get(sessionId) || []);
      sessionProgress.set(toolUseId, data);
      toolProgress.set(sessionId, sessionProgress);
      return { toolProgress };
    }),

  clearToolProgress: (sessionId, toolUseId) =>
    set((s) => {
      const toolProgress = new Map(s.toolProgress);
      if (toolUseId) {
        const sessionProgress = toolProgress.get(sessionId);
        if (sessionProgress) {
          const updated = new Map(sessionProgress);
          updated.delete(toolUseId);
          toolProgress.set(sessionId, updated);
        }
      } else {
        toolProgress.delete(sessionId);
      }
      return { toolProgress };
    }),

  toggleProjectCollapse: (projectKey) =>
    set((s) => {
      const collapsedProjects = new Set(s.collapsedProjects);
      if (collapsedProjects.has(projectKey)) {
        collapsedProjects.delete(projectKey);
      } else {
        collapsedProjects.add(projectKey);
      }
      localStorage.setItem("cc-collapsed-projects", JSON.stringify(Array.from(collapsedProjects)));
      return { collapsedProjects };
    }),

  setSessionViewers: (sessionId, viewers) =>
    set((s) => {
      const sessionViewers = new Map(s.sessionViewers);
      sessionViewers.set(sessionId, viewers);
      return { sessionViewers };
    }),

  setMyRole: (sessionId, role) =>
    set((s) => {
      const myRole = new Map(s.myRole);
      myRole.set(sessionId, role);
      return { myRole };
    }),

  setMyViewerId: (sessionId, viewerId) =>
    set((s) => {
      const myViewerId = new Map(s.myViewerId);
      myViewerId.set(sessionId, viewerId);
      return { myViewerId };
    }),

  setPermissionVotes: (sessionId, requestId, data) =>
    set((s) => {
      const permissionVotes = new Map(s.permissionVotes);
      const sessionVotes = new Map(permissionVotes.get(sessionId) || []);
      sessionVotes.set(requestId, data);
      permissionVotes.set(sessionId, sessionVotes);
      return { permissionVotes };
    }),

  setVoteResult: (sessionId, requestId, data) =>
    set((s) => {
      const voteResults = new Map(s.voteResults);
      const sessionResults = new Map(voteResults.get(sessionId) || []);
      sessionResults.set(requestId, data);
      voteResults.set(sessionId, sessionResults);
      return { voteResults };
    }),

  clearVoteState: (sessionId, requestId) =>
    set((s) => {
      const permissionVotes = new Map(s.permissionVotes);
      const sessionVotes = permissionVotes.get(sessionId);
      if (sessionVotes) {
        const updated = new Map(sessionVotes);
        updated.delete(requestId);
        permissionVotes.set(sessionId, updated);
      }
      const voteResults = new Map(s.voteResults);
      const sessionResults = voteResults.get(sessionId);
      if (sessionResults) {
        const updated = new Map(sessionResults);
        updated.delete(requestId);
        voteResults.set(sessionId, updated);
      }
      return { permissionVotes, voteResults };
    }),

  // Message queue
  enqueueMessage: (sessionId, message) => set((state) => {
    const queue = new Map(state.messageQueue);
    const existing = queue.get(sessionId) || [];
    queue.set(sessionId, [...existing, message]);
    return { messageQueue: queue };
  }),
  dequeueMessage: (sessionId) => {
    let first: string | undefined;
    set((state) => {
      const currentQueue: string[] = state.messageQueue.get(sessionId) || [];
      if (currentQueue.length === 0) return {};
      first = currentQueue[0];
      const rest: string[] = currentQueue.slice(1);
      const newQueue = new Map(state.messageQueue);
      if (rest.length === 0) {
        newQueue.delete(sessionId);
      } else {
        newQueue.set(sessionId, rest);
      }
      return { messageQueue: newQueue };
    });
    return first;
  },
  clearQueue: (sessionId) => set((state) => {
    const queue = new Map(state.messageQueue);
    queue.delete(sessionId);
    return { messageQueue: queue };
  }),
  getQueue: (_sessionId) => {
    // Note: callers should use useStore.getState().messageQueue.get(sessionId) directly
    // or subscribe via useStore((s) => s.messageQueue.get(sessionId))
    return [];
  },

  setReplaySpeed: (speed) => set({ replaySpeed: speed }),
  setReplayState: (state) => set({ replayState: state }),
  setReplaySessionId: (id) => set({ replaySessionId: id }),

  setPreviousPermissionMode: (sessionId, mode) =>
    set((s) => {
      const previousPermissionMode = new Map(s.previousPermissionMode);
      previousPermissionMode.set(sessionId, mode);
      return { previousPermissionMode };
    }),

  setConnectionStatus: (sessionId, status) =>
    set((s) => {
      const connectionStatus = new Map(s.connectionStatus);
      connectionStatus.set(sessionId, status);
      return { connectionStatus };
    }),

  setCliConnected: (sessionId, connected) =>
    set((s) => {
      const cliConnected = new Map(s.cliConnected);
      cliConnected.set(sessionId, connected);
      // Clear launching state when CLI connects
      const cliLaunching = connected ? new Map(s.cliLaunching) : s.cliLaunching;
      if (connected) cliLaunching.delete(sessionId);
      return { cliConnected, cliLaunching };
    }),

  setCliLaunching: (sessionId, launching) =>
    set((s) => {
      const cliLaunching = new Map(s.cliLaunching);
      if (launching) {
        cliLaunching.set(sessionId, true);
      } else {
        cliLaunching.delete(sessionId);
      }
      return { cliLaunching };
    }),

  setSessionStatus: (sessionId, status) =>
    set((s) => {
      const sessionStatus = new Map(s.sessionStatus);
      sessionStatus.set(sessionId, status);
      return { sessionStatus };
    }),

  setUpdateInfo: (info) => set({ updateInfo: info }),
  dismissUpdate: (version) => {
    localStorage.setItem("cc-update-dismissed", version);
    set({ updateDismissedVersion: version });
  },
  setUpdateOverlayActive: (active) => set({ updateOverlayActive: active }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setDiffPanelSelectedFile: (sessionId, filePath) =>
    set((s) => {
      const diffPanelSelectedFile = new Map(s.diffPanelSelectedFile);
      if (filePath) {
        diffPanelSelectedFile.set(sessionId, filePath);
      } else {
        diffPanelSelectedFile.delete(sessionId);
      }
      return { diffPanelSelectedFile };
    }),

  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setTerminalCwd: (cwd) => set({ terminalCwd: cwd }),
  setTerminalId: (id) => set({ terminalId: id }),
  openTerminal: (cwd) => set({ terminalOpen: true, terminalCwd: cwd }),
  closeTerminal: () => set({ terminalOpen: false, terminalCwd: null, terminalId: null }),

  setSessionCreating: (creating) => set({ sessionCreating: creating }),
  setCreationProgress: (progress) => set({ creationProgress: progress }),
  setCreationError: (error) => set({ creationError: error }),

  reset: () =>
    set({
      sessions: new Map(),
      sdkSessions: [],
      currentSessionId: null,
      messages: new Map(),
      streaming: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      pendingPermissions: new Map(),
      connectionStatus: new Map(),
      cliConnected: new Map(),
      cliLaunching: new Map(),
      sessionStatus: new Map(),
      previousPermissionMode: new Map(),
      sessionTasks: new Map(),
      sessionBackgroundAgents: new Map(),
      completedSubagentSessions: new Map(),
      changedFiles: new Map(),
      sessionNames: new Map(),
      recentlyRenamed: new Set(),
      mcpServers: new Map(),
      toolProgress: new Map(),
      prStatus: new Map(),
      activeTab: "chat" as const,
      diffPanelSelectedFile: new Map(),
      terminalOpen: false,
      terminalCwd: null,
      terminalId: null,
      sessionCreating: false,
      creationProgress: null,
      creationError: null,
    }),
}));
