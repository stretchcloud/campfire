import type { SdkSessionInfo } from "./types.js";
import { captureEvent, captureException } from "./analytics.js";

const BASE = "/api";

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function trackApiSuccess(method: string, path: string, durationMs: number, status: number): void {
  captureEvent("api_request_succeeded", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
  });
}

function trackApiFailure(
  method: string,
  path: string,
  durationMs: number,
  error: unknown,
  status?: number,
): void {
  captureEvent("api_request_failed", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { method, path, status });
}

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("POST", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("POST", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("POST", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function get<T = unknown>(path: string): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) {
      const apiError = new Error(res.statusText);
      trackApiFailure("GET", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("GET", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("GET", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function put<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PUT", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PUT", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PUT", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PATCH", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PATCH", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PATCH", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function del<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("DELETE", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("DELETE", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("DELETE", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

export interface ContainerCreateOpts {
  image?: string;
  ports?: number[];
  volumes?: string[];
  env?: Record<string, string>;
}

export interface ContainerStatus {
  available: boolean;
  version: string | null;
}

export interface CloudProviderPlan {
  provider: "modal";
  sessionId: string;
  image: string;
  cwd: string;
  mappedPorts: Array<{ containerPort: number; hostPort: number }>;
  commandPreview: string;
}

export interface CreateSessionOpts {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex" | "goose" | "aider" | "openhands" | "openclaw" | "opencode";
  container?: ContainerCreateOpts;
}

export interface BackendInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
}

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  isNew: boolean;
}

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  isServiceMode: boolean;
  updateInProgress: boolean;
  lastChecked: number;
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export interface AppSettings {
  openrouterApiKeyConfigured: boolean;
  openrouterModel: string;
  moltbookApiKeyConfigured: boolean;
  linearApiKeyConfigured: boolean;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { name: string; status: string; conclusion: string | null }[];
  checksSummary: { total: number; success: number; failure: number; pending: number };
  reviewThreads: { total: number; resolved: number; unresolved: number };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

export interface CronJobInfo {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  recurring: boolean;
  backendType: "claude" | "codex" | "goose" | "aider" | "openhands" | "openclaw" | "opencode";
  model: string;
  cwd: string;
  envSlug?: string;
  enabled: boolean;
  permissionMode: string;
  codexInternetAccess?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  consecutiveFailures: number;
  totalRuns: number;
  nextRunAt?: number | null;
}

export interface CronJobExecution {
  sessionId: string;
  jobId: string;
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  costUsd?: number;
}

export interface GalleryEntryInfo {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  tags: string[];
  featured: boolean;
  votes: number;
  createdAt: number;
  updatedAt: number;
  backendType: string;
  model: string;
  totalCostUsd: number;
  durationMs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  numTurns: number;
  repoRoot?: string;
}

export interface WebhookInfo {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret?: string;
  enabled: boolean;
  format?: "generic" | "slack" | "openclaw";
  sessionFilter?: {
    backendType?: string;
    cwd?: string;
  };
  createdAt: number;
  updatedAt: number;
  totalDeliveries: number;
  failedDeliveries: number;
  lastDeliveryAt?: number;
  lastDeliverySuccess?: boolean;
}

export interface InstalledAdapterInfo {
  metadata: {
    name: string;
    displayName: string;
    version: string;
    binaryName?: string;
    models: Array<{ value: string; label: string }>;
    modes: Array<{ value: string; label: string }>;
    protocol: "stdio" | "websocket" | "http";
    description?: string;
    author?: string;
    homepage?: string;
  };
  path: string;
  installedAt: number;
  npmPackage: string;
}

export const api = {
  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>(
      "/sessions/create",
      opts,
    ),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/relaunch`),

  archiveSession: (sessionId: string, opts?: { force?: boolean }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  listDirs: (path?: string) =>
    get<DirListResult>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) =>
    get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (name: string, variables: Record<string, string>) =>
    post<CompanionEnv>("/envs", { name, variables }),
  updateEnv: (
    slug: string,
    data: { name?: string; variables?: Record<string, string> },
  ) => put<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`, data),
  deleteEnv: (slug: string) => del(`/envs/${encodeURIComponent(slug)}`),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  updateSettings: (data: { openrouterApiKey?: string; openrouterModel?: string; moltbookApiKey?: string; linearApiKey?: string }) =>
    put<AppSettings>("/settings", data),

  // Git operations
  getRepoInfo: (path: string) =>
    get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(
      `/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (
    repoRoot: string,
    branch: string,
    opts?: { baseBranch?: string; createBranch?: boolean },
  ) =>
    post<WorktreeCreateResult>("/git/worktree", { repoRoot, branch, ...opts }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del<{ removed: boolean; reason?: string }>("/git/worktree", {
      repoRoot,
      worktreePath,
      force,
    }),
  gitFetch: (repoRoot: string) =>
    post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(
      `/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`,
    ),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) =>
    get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Containers
  getContainerStatus: () => get<ContainerStatus>("/containers/status"),
  getContainerImages: () => get<string[]>("/containers/images"),
  getCloudProviderPlan: (provider: "modal", cwd: string, sessionId: string) =>
    get<CloudProviderPlan>(
      `/cloud/providers/${encodeURIComponent(provider)}/plan?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),

  // Editor
  startEditor: (sessionId: string) =>
    post<{ url: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/editor/start`,
    ),

  // Editor filesystem
  getFileTree: (path: string) =>
    get<{ path: string; tree: TreeNode[] }>(
      `/fs/tree?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    get<{ path: string; content: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string) =>
    get<{ path: string; diff: string }>(
      `/fs/diff?path=${encodeURIComponent(path)}`,
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows }),
  killTerminal: () =>
    post<{ ok: boolean }>("/terminal/kill"),
  getTerminal: () =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>("/terminal"),

  // Update checking
  checkForUpdate: () => get<UpdateInfo>("/update-check"),
  forceCheckForUpdate: () => post<UpdateInfo>("/update-check"),
  triggerUpdate: () =>
    post<{ ok: boolean; message: string }>("/update"),

  // Cron jobs
  listCronJobs: () => get<CronJobInfo[]>("/cron/jobs"),
  getCronJob: (id: string) => get<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`),
  createCronJob: (data: Partial<CronJobInfo>) => post<CronJobInfo>("/cron/jobs", data),
  updateCronJob: (id: string, data: Partial<CronJobInfo>) =>
    put<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}`, data),
  deleteCronJob: (id: string) => del(`/cron/jobs/${encodeURIComponent(id)}`),
  toggleCronJob: (id: string) => post<CronJobInfo>(`/cron/jobs/${encodeURIComponent(id)}/toggle`),
  runCronJob: (id: string) => post(`/cron/jobs/${encodeURIComponent(id)}/run`),
  getCronJobExecutions: (id: string) =>
    get<CronJobExecution[]>(`/cron/jobs/${encodeURIComponent(id)}/executions`),

  // Voting policy
  getVotingPolicy: () =>
    get<{ policy: "majority-rules" | "any-deny-blocks" | "owner-decides" }>("/voting-policy"),
  setVotingPolicy: (policy: "majority-rules" | "any-deny-blocks" | "owner-decides") =>
    put<{ policy: string }>("/voting-policy", { policy }),

  // Recordings & replay
  listRecordings: () =>
    get<{ recordings: Array<{ filename: string; sessionId: string; backendType: string; startedAt: string; lines: number }> }>("/recordings"),
  getRecording: (filename: string) =>
    get<{ header: Record<string, unknown>; messages: unknown[]; timestamps: number[] }>(`/recordings/${encodeURIComponent(filename)}`),
  getSessionHistory: (sessionId: string) =>
    get<{ messages: unknown[]; state: Record<string, unknown> | null }>(`/sessions/${encodeURIComponent(sessionId)}/history`),

  // Fork
  forkSession: (sessionId: string, opts?: { messageIndex?: number; branch?: string; model?: string; permissionMode?: string }) =>
    post<SdkSessionInfo & { forkedFrom?: string }>(`/sessions/${encodeURIComponent(sessionId)}/fork`, opts),

  // Invite links
  createInviteLink: (sessionId: string, role: "owner" | "collaborator" | "spectator" = "collaborator") =>
    post<{ token: string; url: string; role: string }>(`/sessions/${encodeURIComponent(sessionId)}/invite`, { role }),
  joinSession: (token: string) =>
    get<{ session_id: string; token?: string; role?: string }>(`/sessions/join/${encodeURIComponent(token)}`),

  // Gallery
  listGalleryEntries: (filter?: {
    backend?: string;
    minCost?: number;
    maxCost?: number;
    tags?: string[];
    featured?: boolean;
    sortBy?: string;
    sortOrder?: string;
  }) => {
    const params = new URLSearchParams();
    if (filter?.backend) params.set("backend", filter.backend);
    if (filter?.minCost != null) params.set("minCost", String(filter.minCost));
    if (filter?.maxCost != null) params.set("maxCost", String(filter.maxCost));
    if (filter?.tags?.length) params.set("tags", filter.tags.join(","));
    if (filter?.featured) params.set("featured", "true");
    if (filter?.sortBy) params.set("sortBy", filter.sortBy);
    if (filter?.sortOrder) params.set("sortOrder", filter.sortOrder);
    const qs = params.toString();
    return get<GalleryEntryInfo[]>(`/gallery${qs ? `?${qs}` : ""}`);
  },
  getGalleryEntry: (id: string) =>
    get<GalleryEntryInfo>(`/gallery/${encodeURIComponent(id)}`),
  createGalleryEntry: (data: { sessionId: string; name: string; description: string; tags?: string[] }) =>
    post<GalleryEntryInfo>("/gallery", data),
  updateGalleryEntry: (id: string, updates: { name?: string; description?: string; tags?: string[]; featured?: boolean }) =>
    put<GalleryEntryInfo>(`/gallery/${encodeURIComponent(id)}`, updates),
  deleteGalleryEntry: (id: string) =>
    del(`/gallery/${encodeURIComponent(id)}`),
  voteGalleryEntry: (id: string, direction: 1 | -1) =>
    post<{ votes: number }>(`/gallery/${encodeURIComponent(id)}/vote`, { direction }),
  featureGalleryEntry: (id: string) =>
    post<GalleryEntryInfo>(`/gallery/${encodeURIComponent(id)}/feature`),

  // ClawHub
  getClawHubStatus: () => get<{ available: boolean }>("/clawhub/status"),
  exportToClawHub: (id: string, options?: { campfireBaseUrl?: string; prompt?: string; dryRun?: boolean }) =>
    post<{ ok: boolean; skillDir?: string; output?: string; error?: string }>(`/gallery/${encodeURIComponent(id)}/export-clawhub`, options || {}),
  previewSkillMd: (id: string, baseUrl?: string) =>
    get<{ markdown: string }>(`/gallery/${encodeURIComponent(id)}/skill-preview${baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : ""}`),
  searchClawHub: (query: string) =>
    get<Array<{ name: string; description: string; version: string; author?: string; downloads?: number }>>(`/clawhub/search?q=${encodeURIComponent(query)}`),
  installClawHubSkill: (slug: string) =>
    post<{ ok: boolean; output?: string; error?: string }>("/clawhub/install", { slug }),

  // Moltbook
  getMoltbookStatus: () => get<{ available: boolean; agent?: { name: string; karma?: number }; error?: string }>("/moltbook/status"),
  postToMoltbook: (id: string, options?: { campfireBaseUrl?: string; submolt?: string }) =>
    post<{ ok: boolean; postUrl?: string; postId?: string; error?: string }>(`/gallery/${encodeURIComponent(id)}/post-moltbook`, options || {}),

  // Public Replay
  createPublicReplayLink: (galleryId: string) =>
    post<{ token: string; url: string }>(`/gallery/${encodeURIComponent(galleryId)}/public-link`),
  getPublicReplay: (token: string) =>
    get<{ messages: unknown[]; state: Record<string, unknown> | null; gallery: Record<string, unknown> | null }>(`/public-replay/${encodeURIComponent(token)}`),

  // Webhooks
  listWebhooks: () => get<WebhookInfo[]>("/webhooks"),
  getWebhook: (id: string) => get<WebhookInfo>(`/webhooks/${encodeURIComponent(id)}`),
  createWebhook: (data: { name: string; url: string; events: string[]; secret?: string; format?: string; sessionFilter?: { backendType?: string; cwd?: string } }) =>
    post<WebhookInfo>("/webhooks", data),
  updateWebhook: (id: string, updates: { name?: string; url?: string; events?: string[]; secret?: string; format?: string; sessionFilter?: { backendType?: string; cwd?: string } }) =>
    put<WebhookInfo>(`/webhooks/${encodeURIComponent(id)}`, updates),
  deleteWebhook: (id: string) => del(`/webhooks/${encodeURIComponent(id)}`),
  toggleWebhook: (id: string) => post<WebhookInfo>(`/webhooks/${encodeURIComponent(id)}/toggle`),
  testWebhook: (id: string) => post<{ ok: boolean }>(`/webhooks/${encodeURIComponent(id)}/test`),

  // Adapters
  listAdapters: () => get<InstalledAdapterInfo[]>("/adapters"),
  installAdapter: (npmPackage: string) =>
    post<InstalledAdapterInfo>("/adapters/install", { npmPackage }),
  uninstallAdapter: (name: string) =>
    del(`/adapters/${encodeURIComponent(name)}`),

  // Prompt Library
  listPrompts: (opts?: { cwd?: string }) =>
    get<import("./types.js").Prompt[]>(
      `/prompts${opts?.cwd ? `?cwd=${encodeURIComponent(opts.cwd)}` : ""}`,
    ),
  getPrompt: (id: string) =>
    get<import("./types.js").Prompt>(`/prompts/${encodeURIComponent(id)}`),
  createPrompt: (data: { name: string; content: string; scope: "global" | "project"; projectPath?: string }) =>
    post<import("./types.js").Prompt>("/prompts", data),
  updatePrompt: (id: string, updates: { name?: string; content?: string; scope?: "global" | "project"; projectPath?: string }) =>
    put<import("./types.js").Prompt>(`/prompts/${encodeURIComponent(id)}`, updates),
  deletePrompt: (id: string) =>
    del(`/prompts/${encodeURIComponent(id)}`),

  // Linear Integration
  getLinearConnection: () =>
    get<{ connected: boolean; viewer?: { name: string; email: string }; teams?: Array<{ id: string; key: string; name: string }> }>("/linear/connection"),
  searchLinearIssues: (query: string, limit?: number) =>
    get<{ issues: import("./utils/linear-branch.js").LinearIssue[] }>(
      `/linear/issues?query=${encodeURIComponent(query)}${limit ? `&limit=${limit}` : ""}`,
    ),

  // Collective Intelligence - Layer 1: Semantic Memory
  getSessionMemory: (sessionId: string) =>
    get<{ fragments: import("./types.js").MemoryFragment[]; consolidated: import("./types.js").ConsolidatedKnowledge[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/memory`,
    ),
  queryMemory: (sessionId: string, query: string, limit = 10) =>
    get<{ results: import("./types.js").MemoryFragment[]; consolidated: import("./types.js").ConsolidatedKnowledge[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/memory/query?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  storeMemory: (sessionId: string, data: { content: string; type: string; tags: string[]; gitContext?: Record<string, unknown> }) =>
    post<{ fragment: import("./types.js").MemoryFragment }>(`/sessions/${encodeURIComponent(sessionId)}/memory`, data),
  consolidateMemory: (sessionId: string) =>
    post<{ consolidated: import("./types.js").ConsolidatedKnowledge[]; count: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/memory/consolidate`,
    ),
  getGlobalMemory: (tag?: string) =>
    get<{ knowledge: import("./types.js").ConsolidatedKnowledge[] }>(
      `/memory/global${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`,
    ),

  // Collective Intelligence - Layer 2: Deliberation
  getDeliberations: (sessionId: string) =>
    get<{ active: import("./types.js").DeliberationProposal[]; resolved: import("./types.js").DeliberationResolution[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/deliberations`,
    ),
  getDeliberation: (sessionId: string, proposalId: string) =>
    get<{ proposal: import("./types.js").DeliberationProposal; responses: import("./types.js").DeliberationResponse[]; resolution?: import("./types.js").DeliberationResolution }>(
      `/sessions/${encodeURIComponent(sessionId)}/deliberations/${encodeURIComponent(proposalId)}`,
    ),
  respondToDeliberation: (sessionId: string, proposalId: string, data: { stance: string; reasoning: string; suggestedAlternative?: string }) =>
    post<{ response: import("./types.js").DeliberationResponse }>(
      `/sessions/${encodeURIComponent(sessionId)}/deliberations/${encodeURIComponent(proposalId)}/respond`,
      data,
    ),
  resolveDeliberation: (sessionId: string, proposalId: string) =>
    post<{ resolution: import("./types.js").DeliberationResolution }>(
      `/sessions/${encodeURIComponent(sessionId)}/deliberations/${encodeURIComponent(proposalId)}/resolve`,
    ),

  // Collective Intelligence - Layer 3: Capability Discovery
  routeTask: (data: import("./types.js").RouteTaskRequest) =>
    post<import("./types.js").RouteTaskResult>("/sessions/route-task", data),
  getCapabilities: () =>
    get<{ sessions: import("./types.js").AgentCapabilities[] }>("/capabilities"),
  getCapabilityHistory: (filters?: { backendType?: string; taskType?: string }) => {
    const params = new URLSearchParams();
    if (filters?.backendType) params.set("backendType", filters.backendType);
    if (filters?.taskType) params.set("taskType", filters.taskType);
    const qs = params.toString();
    return get<{ executions: unknown[]; successRate: number; avgCostUsd: number }>(
      `/capabilities/history${qs ? `?${qs}` : ""}`,
    );
  },
  submitCapabilityFeedback: (sessionId: string, taskId: string, feedback: "positive" | "negative" | "neutral") =>
    post<{ ok: boolean }>("/capabilities/feedback", { sessionId, taskId, feedback }),

  // Collective Intelligence - Layer 4: Shared Context
  getContextStream: (sessionId: string) =>
    get<{ fragments: import("./types.js").ContextFragment[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/context/stream`,
    ),
  getConsensusState: (sessionId: string) =>
    get<import("./types.js").ConsensusState>(
      `/sessions/${encodeURIComponent(sessionId)}/context/consensus`,
    ),
  getContextThread: (sessionId: string, fragmentId: string) =>
    get<{ thread: import("./types.js").ContextFragment[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/context/thread/${encodeURIComponent(fragmentId)}`,
    ),

  // ─── Linear Integration ──────────────────────────────────────────
  getLinearTeams: () =>
    get<{ teams: Array<{ id: string; key: string; name: string }> }>("/linear/teams"),
  getLinearTeamStates: (teamId: string) =>
    get<{ states: Array<{ id: string; name: string; type: string; position: number }> }>(
      `/linear/team/${encodeURIComponent(teamId)}/states`,
    ),
  getLinearProjectMapping: (repoRoot?: string) =>
    get<{ mapping?: { teamId: string; teamKey: string; teamName: string; projectId?: string; projectName?: string; repoRoot: string }; mappings?: Array<{ teamId: string; teamKey: string; teamName: string; repoRoot: string }> }>(
      `/linear/project-mapping${repoRoot ? `?repoRoot=${encodeURIComponent(repoRoot)}` : ""}`,
    ),
  setLinearProjectMapping: (body: { repoRoot: string; teamId: string; teamKey: string; teamName: string; projectId?: string; projectName?: string }) =>
    post<{ mapping: unknown }>("/linear/project-mapping", body),
  linkLinearIssue: (sessionId: string, issue: { issueId: string; identifier: string; title: string; url: string; state: string; teamKey: string }) =>
    post<{ linked: unknown }>(`/linear/session/${encodeURIComponent(sessionId)}/link-issue`, issue),
  getLinkedIssue: (sessionId: string) =>
    get<{ issue: { issueId: string; identifier: string; title: string; url: string; state: string } | null }>(
      `/linear/session/${encodeURIComponent(sessionId)}/issue`,
    ),
  transitionLinearIssue: (issueId: string, stateId: string) =>
    post<{ ok: boolean; issue?: unknown }>(`/linear/issues/${encodeURIComponent(issueId)}/transition`, { stateId }),

  // ─── Docker Container Session Creation (SSE) ─────────────────────
  createSessionWithProgress: async (
    body: CreateSessionOpts & { container: ContainerCreateOpts },
    onProgress: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<{ sessionId: string; session: unknown } | null> => {
    const res = await fetch(`${BASE}/sessions/create-with-progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: { sessionId: string; session: unknown } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            onProgress({ type: eventType, data });
            if (eventType === "done" && data.sessionId) {
              result = { sessionId: data.sessionId, session: data.session };
            }
            if (eventType === "error") {
              throw new Error(data.error || "Session creation failed");
            }
          } catch (e) {
            if (e instanceof Error && e.message !== "Session creation failed") {
              // JSON parse error, skip
            } else {
              throw e;
            }
          }
        }
      }
    }

    return result;
  },
};
