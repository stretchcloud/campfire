/**
 * OrchestratorStore — File-based persistence for pipelines and runs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Pipeline, PipelineRun } from "./orchestrator-types.js";

const STORE_DIR = join(homedir(), ".companion", "orchestrator");
const PIPELINES_DIR = join(STORE_DIR, "pipelines");
const RUNS_DIR = join(STORE_DIR, "runs");

function ensureDirs(): void {
  mkdirSync(PIPELINES_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
}

// ─── Pipelines ─────────────────────────────────────────────────────────────

export function listPipelines(): Pipeline[] {
  ensureDirs();
  try {
    const files = readdirSync(PIPELINES_DIR).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(PIPELINES_DIR, f), "utf-8")) as Pipeline;
        } catch {
          return null;
        }
      })
      .filter((p): p is Pipeline => p !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function getPipeline(id: string): Pipeline | null {
  ensureDirs();
  try {
    return JSON.parse(readFileSync(join(PIPELINES_DIR, `${id}.json`), "utf-8")) as Pipeline;
  } catch {
    return null;
  }
}

export function savePipeline(pipeline: Pipeline): void {
  ensureDirs();
  writeFileSync(join(PIPELINES_DIR, `${pipeline.id}.json`), JSON.stringify(pipeline, null, 2));
}

export function deletePipeline(id: string): boolean {
  try {
    unlinkSync(join(PIPELINES_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// ─── Runs ──────────────────────────────────────────────────────────────────

export function listRuns(pipelineId?: string): PipelineRun[] {
  ensureDirs();
  try {
    const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")) as PipelineRun;
        } catch {
          return null;
        }
      })
      .filter((r): r is PipelineRun => r !== null)
      .filter((r) => !pipelineId || r.pipelineId === pipelineId)
      .sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

export function getRun(id: string): PipelineRun | null {
  ensureDirs();
  try {
    return JSON.parse(readFileSync(join(RUNS_DIR, `${id}.json`), "utf-8")) as PipelineRun;
  } catch {
    return null;
  }
}

export function saveRun(run: PipelineRun): void {
  ensureDirs();
  writeFileSync(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
}

export function deleteRun(id: string): boolean {
  try {
    unlinkSync(join(RUNS_DIR, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
