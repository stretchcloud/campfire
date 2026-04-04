import type {
  SessionState,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  SessionRole,
  PresenceViewer,
  VotingPolicy,
  PermissionVote,
  McpServerDetail,
  McpServerConfig,
} from "../server/session-types.js";

export type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage, BrowserOutgoingMessage, BackendType, SessionRole, PresenceViewer, VotingPolicy, PermissionVote, McpServerDetail, McpServerConfig };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: { media_type: string; data: string }[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export type BackgroundAgentStatus = "running" | "completed" | "failed";

export interface BackgroundAgentItem {
  /** The tool_use_id of the Agent tool call that spawned this */
  toolUseId: string;
  /** Agent name (from the `name` or `description` input field) */
  name: string;
  /** Short description (from the `description` input field) */
  description: string;
  /** Agent type (e.g., "Explore", "general-purpose") */
  agentType: string;
  /** Current status */
  status: BackgroundAgentStatus;
  /** Timestamp when detected */
  startedAt: number;
  /** Timestamp when completed/failed */
  completedAt?: number;
  /** Result summary (truncated) */
  summary?: string;
}

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  archived?: boolean;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
  name?: string;
  backendType?: BackendType;
  gitBranch?: string;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** ID of the session this was forked from */
  forkedFrom?: string;
}

// ─── Collective Intelligence Types ───────────────────────────────────────────

// Layer 1: Semantic Memory
export type MemoryType = "observation" | "hypothesis" | "decision" | "pattern";

export interface GitContext {
  commitHash?: string;
  branch: string;
  files: string[];
  repoRoot: string;
}

export interface MemoryFragment {
  id: string;
  sessionId: string;
  agentId: string;
  backendType: BackendType;
  timestamp: number;
  type: MemoryType;
  content: string;
  gitContext: GitContext;
  references: string[];
  confidence: number;
  tags: string[];
  consolidatedInto?: string;
  isConsolidated: boolean;
}

export interface ConsolidatedKnowledge {
  id: string;
  tag: string;
  summary: string;
  sourceFragments: string[];
  lastUpdated: number;
  confidence: number;
  repoRoot: string;
}

// Layer 2: Deliberation
export type DeliberationAction = "refactor" | "feature" | "fix" | "investigate" | "delete" | "architect";
export type DeliberationStance = "agree" | "disagree" | "suggest_alternative" | "abstain";
export type DeliberationOutcome = "approved" | "rejected" | "synthesized";

export interface DeliberationAlternative {
  description: string;
  tradeoffs: string;
}

export interface DeliberationProposal {
  proposalId: string;
  sessionId: string;
  agentId: string;
  backendType: BackendType;
  timestamp: number;
  action: DeliberationAction;
  title: string;
  description: string;
  approach: string;
  alternatives: DeliberationAlternative[];
  risks: string[];
  affectedFiles: string[];
  estimatedTurns?: number;
  requestingFeedbackFrom: string[];
  deadline?: number;
}

export interface DeliberationResponse {
  proposalId: string;
  responderId: string;
  responderType: "agent" | "human";
  backendType?: BackendType;
  timestamp: number;
  stance: DeliberationStance;
  reasoning: string;
  suggestedAlternative?: string;
  concerns?: string[];
}

export interface DeliberationResolution {
  proposalId: string;
  timestamp: number;
  outcome: DeliberationOutcome;
  finalApproach: string;
  participants: string[];
  voteBreakdown: {
    agree: number;
    disagree: number;
    suggest_alternative: number;
    abstain: number;
  };
  synthesis?: string;
}

// Layer 3: Capability Discovery
export interface AgentCapabilities {
  sessionId: string;
  backendType: BackendType;
  reportedAt: number;
  strengths: string[];
  weaknesses: string[];
  availableTools: string[];
  contextWindowTokens: number;
  contextUsedPercent: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

export interface RouteTaskRequest {
  taskDescription: string;
  availableSessions: string[];
  constraints?: {
    maxCostUsd?: number;
    maxTurns?: number;
    requiredTools?: string[];
  };
}

export interface RouteTaskResult {
  sessionId: string;
  backendType: BackendType;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ sessionId: string; confidence: number; backendType: BackendType }>;
}

// Layer 4: Shared Context
export type ContextFragmentType =
  | "thought"
  | "observation"
  | "plan"
  | "question"
  | "answer"
  | "insight"
  | "concern";

export type SemanticRelation =
  | "agrees_with"
  | "disagrees_with"
  | "builds_on"
  | "contradicts"
  | "questions";

export interface SemanticLink {
  targetFragmentId: string;
  relation: SemanticRelation;
}

export interface ContextFragment {
  fragmentId: string;
  sessionId: string;
  agentId: string;
  backendType?: BackendType;
  isHuman: boolean;
  timestamp: number;
  type: ContextFragmentType;
  content: string;
  parentId?: string;
  semanticLinks: SemanticLink[];
  consensusScore: number;
  isControversial: boolean;
}

export interface DisagreementCluster {
  fragmentIds: string[];
  topic: string;
  summary: string;
}

export interface ConsensusState {
  sessionId: string;
  updatedAt: number;
  consensusPoints: string[];
  disagreements: DisagreementCluster[];
  openQuestions: string[];
}
