/**
 * Orchestrator Types — Multi-stage pipeline engine for chaining AI sessions.
 *
 * A Pipeline defines an ordered sequence of Stages (e.g., implement → test → review).
 * Each stage spawns a child session and passes context from the previous stage.
 */

export interface PipelineStage {
  /** Unique stage ID (uuid) */
  id: string;
  /** Display name, e.g. "Implement feature" */
  name: string;
  /** Prompt to send to the agent for this stage */
  prompt: string;
  /** Backend to use: "claude" | "codex" | "goose" | "aider" */
  backend: string;
  /** Model override (optional) */
  model?: string;
  /** Permission mode for this stage */
  permissionMode?: string;
  /** Whether to pass the previous stage's output as context */
  inheritContext?: boolean;
}

export interface Pipeline {
  /** Unique pipeline ID (uuid) */
  id: string;
  /** Display name */
  name: string;
  /** Description of what this pipeline does */
  description?: string;
  /** Working directory */
  cwd: string;
  /** Ordered list of stages */
  stages: PipelineStage[];
  /** Created timestamp (ms) */
  createdAt: number;
  /** Last modified timestamp (ms) */
  updatedAt: number;
}

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StageResult {
  stageId: string;
  status: StageStatus;
  /** Child session ID created for this stage */
  sessionId?: string;
  /** Stage start time (ms) */
  startedAt?: number;
  /** Stage end time (ms) */
  completedAt?: number;
  /** Duration in ms */
  durationMs?: number;
  /** Cost for this stage */
  costUsd?: number;
  /** Error message if failed */
  error?: string;
  /** Summary output from the session (last assistant message) */
  outputSummary?: string;
}

export type PipelineRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface PipelineRun {
  /** Unique run ID */
  id: string;
  /** Pipeline ID */
  pipelineId: string;
  /** Pipeline name snapshot */
  pipelineName: string;
  /** Working directory */
  cwd: string;
  /** Overall run status */
  status: PipelineRunStatus;
  /** Per-stage results */
  stageResults: StageResult[];
  /** Run start time */
  startedAt: number;
  /** Run end time */
  completedAt?: number;
  /** Total cost across all stages */
  totalCostUsd: number;
  /** Total duration */
  totalDurationMs: number;
}
