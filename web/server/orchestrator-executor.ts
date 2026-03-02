/**
 * OrchestratorExecutor — Runs pipelines by sequentially creating sessions for each stage.
 *
 * Each stage:
 * 1. Creates a new session via the REST API internal helper
 * 2. Sends the stage prompt (optionally with previous stage context)
 * 3. Waits for the session to complete (polls status)
 * 4. Records the result and moves to the next stage
 */

import { randomUUID } from "node:crypto";
import type { Pipeline, PipelineRun, StageResult } from "./orchestrator-types.js";
import { saveRun } from "./orchestrator-store.js";

interface SessionCreateFn {
  (opts: {
    cwd: string;
    backend: string;
    model?: string;
    permissionMode?: string;
    prompt?: string;
  }): Promise<{ sessionId: string } | null>;
}

interface SessionStatusFn {
  (sessionId: string): { status: string; cost?: number; lastMessage?: string } | null;
}

// Active runs so we can cancel them
const activeRuns = new Map<string, { cancelled: boolean }>();

export function cancelRun(runId: string): boolean {
  const run = activeRuns.get(runId);
  if (run) {
    run.cancelled = true;
    return true;
  }
  return false;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export async function executePipeline(
  pipeline: Pipeline,
  createSession: SessionCreateFn,
  getSessionStatus: SessionStatusFn,
): Promise<PipelineRun> {
  const runId = randomUUID();
  const run: PipelineRun = {
    id: runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    cwd: pipeline.cwd,
    status: "running",
    stageResults: pipeline.stages.map((s) => ({
      stageId: s.id,
      status: "pending",
    })),
    startedAt: Date.now(),
    totalCostUsd: 0,
    totalDurationMs: 0,
  };

  const control = { cancelled: false };
  activeRuns.set(runId, control);
  saveRun(run);

  let previousOutput = "";

  for (let i = 0; i < pipeline.stages.length; i++) {
    if (control.cancelled) {
      // Mark remaining stages as skipped
      for (let j = i; j < pipeline.stages.length; j++) {
        run.stageResults[j].status = "skipped";
      }
      run.status = "cancelled";
      break;
    }

    const stage = pipeline.stages[i];
    const result = run.stageResults[i];
    result.status = "running";
    result.startedAt = Date.now();
    saveRun(run);

    try {
      // Build the prompt, optionally including previous stage output
      let fullPrompt = stage.prompt;
      if (stage.inheritContext && previousOutput) {
        fullPrompt = `Context from previous stage:\n\n${previousOutput}\n\n---\n\n${stage.prompt}`;
      }

      // Create a session for this stage
      const session = await createSession({
        cwd: pipeline.cwd,
        backend: stage.backend,
        model: stage.model,
        permissionMode: stage.permissionMode || "bypassPermissions",
        prompt: fullPrompt,
      });

      if (!session) {
        result.status = "failed";
        result.error = "Failed to create session";
        result.completedAt = Date.now();
        result.durationMs = result.completedAt - (result.startedAt || result.completedAt);
        run.status = "failed";
        saveRun(run);
        break;
      }

      result.sessionId = session.sessionId;
      saveRun(run);

      // Poll for session completion (max 30 minutes per stage)
      const maxWait = 30 * 60 * 1000;
      const pollInterval = 3000;
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline && !control.cancelled) {
        await sleep(pollInterval);

        const status = getSessionStatus(session.sessionId);
        if (!status) continue;

        if (status.status === "idle" || status.status === "completed") {
          result.status = "completed";
          result.costUsd = status.cost || 0;
          result.outputSummary = status.lastMessage?.slice(0, 500) || "";
          previousOutput = result.outputSummary;
          break;
        }

        if (status.status === "error" || status.status === "failed") {
          result.status = "failed";
          result.error = status.lastMessage || "Session failed";
          break;
        }
      }

      if (result.status === "running") {
        // Timed out or cancelled
        result.status = control.cancelled ? "skipped" : "failed";
        result.error = control.cancelled ? "Cancelled" : "Timed out (30 min)";
      }
    } catch (err) {
      result.status = "failed";
      result.error = err instanceof Error ? err.message : String(err);
    }

    result.completedAt = Date.now();
    result.durationMs = result.completedAt - (result.startedAt || result.completedAt);
    run.totalCostUsd += result.costUsd || 0;

    if (result.status === "failed") {
      // Mark remaining stages as skipped
      for (let j = i + 1; j < pipeline.stages.length; j++) {
        run.stageResults[j].status = "skipped";
      }
      run.status = "failed";
      saveRun(run);
      break;
    }

    saveRun(run);
  }

  if (run.status === "running") {
    run.status = "completed";
  }

  run.completedAt = Date.now();
  run.totalDurationMs = run.completedAt - run.startedAt;
  activeRuns.delete(runId);
  saveRun(run);

  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
