/**
 * Layer 3: Capability Discovery & Intelligent Routing
 *
 * Dynamically routes tasks to the best-suited agent backend using:
 *   1. Self-reported capabilities (agent declares its strengths/tools on init)
 *   2. Historical performance (task execution success rates from ~/.companion/capability-learning.jsonl)
 *   3. Real-time probing (send agent a "rate your confidence" message, parse JSON response)
 *
 * Scoring formula:
 *   score = selfReportedFit × 0.3
 *         + historicalSuccessRate × 0.4
 *         + contextAvailability × 0.2
 *         + costEfficiency × 0.1
 *
 * If the top candidate scores < 0.5, sends a capability_probe to the top 3 sessions
 * and updates scores with real-time confidence before returning the final routing result.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BackendType } from "./session-types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentCapabilities {
  sessionId: string;
  backendType: BackendType;
  reportedAt: number;
  strengths: string[];
  weaknesses: string[];
  availableTools: string[];
  contextWindowTokens: number;
  contextUsedPercent: number;   // 0–100
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

export interface TaskExecution {
  id: string;
  sessionId: string;
  backendType: BackendType;
  taskDescription: string;
  taskType: string;
  startedAt: number;
  completedAt?: number;
  outcome: "success" | "failure" | "partial";
  humanFeedback?: "positive" | "negative" | "neutral";
  costUsd?: number;
  turnsUsed?: number;
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
  confidence: number;  // 0.0–1.0
  reasoning: string;
  alternatives: Array<{ sessionId: string; confidence: number; backendType: BackendType }>;
}

export interface CapabilityProbe {
  probeId: string;
  sessionId: string;
  taskDescription: string;
  /** Text to inject as user_message into the agent session */
  instruction: string;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const LEARNING_LOG = join(homedir(), ".companion", "capability-learning.jsonl");
const CAPABILITIES_DIR = join(homedir(), ".companion", "capabilities");

function ensureDirs(): void {
  mkdirSync(dirname(LEARNING_LOG), { recursive: true });
  mkdirSync(CAPABILITIES_DIR, { recursive: true });
}

function capabilityPath(sessionId: string): string {
  return join(CAPABILITIES_DIR, `${sessionId}.json`);
}

// ─── Capability Discovery ─────────────────────────────────────────────────────

export class CapabilityDiscovery {
  // In-memory capability cache (persisted to disk)
  private capabilities = new Map<string, AgentCapabilities>();
  // Pending capability probes: probeId → { sessionId, resolve }
  private pendingProbes = new Map<string, { sessionId: string; resolve: (result: { confidence: number; reasoning: string }) => void }>();

  constructor() {
    ensureDirs();
    this.loadCapabilities();
  }

  // ─── Capability registration ─────────────────────────────────────────────

  /**
   * Register or update capabilities for an agent session.
   * Called when an agent initializes (from session_init or adapter metadata).
   */
  registerCapabilities(caps: AgentCapabilities): void {
    this.capabilities.set(caps.sessionId, caps);
    writeFileSync(capabilityPath(caps.sessionId), JSON.stringify(caps, null, 2), "utf-8");
  }

  getCapabilities(sessionId: string): AgentCapabilities | null {
    return this.capabilities.get(sessionId) ?? null;
  }

  getAllCapabilities(): AgentCapabilities[] {
    return Array.from(this.capabilities.values());
  }

  // ─── Task execution tracking ─────────────────────────────────────────────

  /**
   * Record the start of a task execution. Returns an execution ID.
   */
  startExecution(sessionId: string, backendType: BackendType, taskDescription: string): string {
    const exec: TaskExecution = {
      id: randomUUID(),
      sessionId,
      backendType,
      taskDescription,
      taskType: classifyTask(taskDescription),
      startedAt: Date.now(),
      outcome: "partial", // updated on completion
    };
    this.appendExecution(exec);
    return exec.id;
  }

  /**
   * Record task completion outcome. Appends updated record to the log.
   */
  completeExecution(
    executionId: string,
    sessionId: string,
    backendType: BackendType,
    taskDescription: string,
    outcome: TaskExecution["outcome"],
    opts?: { costUsd?: number; turnsUsed?: number },
  ): void {
    const exec: TaskExecution = {
      id: executionId,
      sessionId,
      backendType,
      taskDescription,
      taskType: classifyTask(taskDescription),
      startedAt: Date.now() - 1000, // approximate
      completedAt: Date.now(),
      outcome,
      ...opts,
    };
    this.appendExecution(exec);
  }

  recordFeedback(executionId: string, sessionId: string, backendType: BackendType, taskDescription: string, feedback: "positive" | "negative" | "neutral"): void {
    const exec: TaskExecution = {
      id: executionId,
      sessionId,
      backendType,
      taskDescription,
      taskType: classifyTask(taskDescription),
      startedAt: Date.now(),
      outcome: "partial",
      humanFeedback: feedback,
    };
    this.appendExecution(exec);
  }

  // ─── Intelligent routing ─────────────────────────────────────────────────

  /**
   * Route a task to the best-available agent session.
   *
   * Returns a RouteTaskResult with confidence and reasoning.
   * If confidence < 0.5, callers should send capability probes first.
   */
  async route(request: RouteTaskRequest): Promise<RouteTaskResult> {
    const { taskDescription, availableSessions, constraints } = request;

    if (availableSessions.length === 0) {
      return {
        sessionId: "",
        backendType: "claude",
        confidence: 0,
        reasoning: "No available sessions to route to.",
        alternatives: [],
      };
    }

    const history = this.loadHistory();
    const taskType = classifyTask(taskDescription);

    const scored = availableSessions
      .map((sessionId) => {
        const caps = this.capabilities.get(sessionId);
        const score = this.scoreSession(sessionId, caps, taskDescription, taskType, history, constraints);
        return { sessionId, caps, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      // No sessions with positive score — return first available
      const fallback = availableSessions[0];
      const caps = this.capabilities.get(fallback);
      return {
        sessionId: fallback,
        backendType: caps?.backendType ?? "claude",
        confidence: 0.1,
        reasoning: "No capability data available — routing to first available session.",
        alternatives: [],
      };
    }

    const best = scored[0];
    const alternatives = scored
      .slice(1, 4)
      .map((s) => ({ sessionId: s.sessionId, confidence: s.score, backendType: s.caps?.backendType ?? "claude" }));

    return {
      sessionId: best.sessionId,
      backendType: best.caps?.backendType ?? "claude",
      confidence: best.score,
      reasoning: this.explainScore(best.sessionId, best.caps, taskType, best.score),
      alternatives,
    };
  }

  /**
   * Create a capability probe to send to a session.
   * The probe is injected as a user_message asking the agent to self-assess.
   *
   * Call resolveProbe() when the agent's response comes back.
   */
  createProbe(sessionId: string, taskDescription: string): CapabilityProbe {
    const probeId = randomUUID();
    return {
      probeId,
      sessionId,
      taskDescription,
      instruction: `[Capability Probe ${probeId}] Please rate your confidence for the following task on a scale of 0.0 to 1.0. Reply with only a JSON object in this exact format: { "confidence": 0.8, "reasoning": "I have strong experience with this task type" }\n\nTask: ${taskDescription}`,
    };
  }

  /**
   * Register a pending probe — allows resolveProbe() to update routing scores.
   */
  registerProbe(probe: CapabilityProbe): Promise<{ confidence: number; reasoning: string }> {
    return new Promise((resolve) => {
      this.pendingProbes.set(probe.probeId, { sessionId: probe.sessionId, resolve });
      // Timeout after 30s — default to 0.5 (neutral)
      setTimeout(() => {
        if (this.pendingProbes.has(probe.probeId)) {
          this.pendingProbes.delete(probe.probeId);
          resolve({ confidence: 0.5, reasoning: "Probe timed out" });
        }
      }, 30_000);
    });
  }

  /**
   * Called when an agent responds to a capability probe.
   * Parses the JSON response and resolves the probe promise.
   */
  resolveProbe(probeId: string, agentResponse: string): boolean {
    const pending = this.pendingProbes.get(probeId);
    if (!pending) return false;

    try {
      const jsonMatch = agentResponse.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { confidence?: number; reasoning?: string };
        const confidence = typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;
        const reasoning = parsed.reasoning ?? "No reasoning provided";
        pending.resolve({ confidence, reasoning });
        this.pendingProbes.delete(probeId);
        return true;
      }
    } catch {
      // malformed — resolve with neutral
    }

    pending.resolve({ confidence: 0.5, reasoning: "Could not parse probe response" });
    this.pendingProbes.delete(probeId);
    return false;
  }

  getExecutionHistory(opts?: { backendType?: BackendType; taskType?: string }): TaskExecution[] {
    return this.loadHistory().filter((e) => {
      if (opts?.backendType && e.backendType !== opts.backendType) return false;
      if (opts?.taskType && e.taskType !== opts.taskType) return false;
      return true;
    });
  }

  // ─── Internal scoring ────────────────────────────────────────────────────

  private scoreSession(
    sessionId: string,
    caps: AgentCapabilities | undefined,
    taskDescription: string,
    taskType: string,
    history: TaskExecution[],
    constraints?: RouteTaskRequest["constraints"],
  ): number {
    // Filter out sessions that can't meet hard constraints
    if (constraints?.requiredTools && caps) {
      const available = new Set(caps.availableTools);
      if (!constraints.requiredTools.every((t) => available.has(t))) return 0;
    }

    // self-reported fit (0.3 weight)
    const selfFit = caps ? this.computeSelfFit(caps, taskDescription, taskType) : 0.5;

    // historical success rate (0.4 weight)
    const sessionHistory = history.filter((e) => e.sessionId === sessionId && e.taskType === taskType);
    const successRate = sessionHistory.length > 0
      ? sessionHistory.filter((e) => e.outcome === "success").length / sessionHistory.length
      : 0.5; // neutral prior when no history

    // context availability (0.2 weight) — penalize sessions near context limit
    const contextAvail = caps ? Math.max(0, 1 - (caps.contextUsedPercent / 100)) : 0.5;

    // cost efficiency (0.1 weight) — lower cost = higher score
    const costScore = caps?.costPerInputToken != null
      ? Math.max(0, 1 - (caps.costPerInputToken * 1e6)) // normalize token cost
      : 0.5;

    return (selfFit * 0.3) + (successRate * 0.4) + (contextAvail * 0.2) + (costScore * 0.1);
  }

  private computeSelfFit(caps: AgentCapabilities, taskDescription: string, taskType: string): number {
    const desc = taskDescription.toLowerCase();
    const strengthMatches = caps.strengths.filter((s) =>
      desc.includes(s.toLowerCase()) || taskType.includes(s.toLowerCase())
    ).length;

    const weaknessMatches = caps.weaknesses.filter((w) =>
      desc.includes(w.toLowerCase()) || taskType.includes(w.toLowerCase())
    ).length;

    return Math.max(0, Math.min(1, 0.5 + (strengthMatches * 0.2) - (weaknessMatches * 0.3)));
  }

  private explainScore(sessionId: string, caps: AgentCapabilities | undefined, taskType: string, score: number): string {
    const parts: string[] = [];
    parts.push(`Routing to session ${sessionId} (${caps?.backendType ?? "unknown"}) with confidence ${(score * 100).toFixed(0)}%.`);
    if (caps?.strengths?.length) {
      parts.push(`Strengths: ${caps.strengths.slice(0, 3).join(", ")}.`);
    }
    if (taskType !== "general") {
      parts.push(`Task classified as: ${taskType}.`);
    }
    return parts.join(" ");
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private appendExecution(exec: TaskExecution): void {
    ensureDirs();
    appendFileSync(LEARNING_LOG, JSON.stringify(exec) + "\n", "utf-8");
  }

  private loadHistory(): TaskExecution[] {
    if (!existsSync(LEARNING_LOG)) return [];
    try {
      return readFileSync(LEARNING_LOG, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskExecution);
    } catch {
      return [];
    }
  }

  private loadCapabilities(): void {
    if (!existsSync(CAPABILITIES_DIR)) return;
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      const files = readdirSync(CAPABILITIES_DIR).filter((f: string) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const caps = JSON.parse(readFileSync(join(CAPABILITIES_DIR, file), "utf-8")) as AgentCapabilities;
          this.capabilities.set(caps.sessionId, caps);
        } catch {
          // skip corrupt file
        }
      }
    } catch {
      // directory not readable yet
    }
  }
}

// ─── Task classification ──────────────────────────────────────────────────────

/**
 * Classify a task description into a task type keyword.
 * Used for matching historical performance records.
 */
function classifyTask(description: string): string {
  const d = description.toLowerCase();
  if (d.includes("refactor") || d.includes("restructure") || d.includes("reorganize")) return "refactoring";
  if (d.includes("debug") || d.includes("fix") || d.includes("bug") || d.includes("error")) return "debugging";
  if (d.includes("test") || d.includes("spec") || d.includes("coverage")) return "testing";
  if (d.includes("document") || d.includes("readme") || d.includes("comment")) return "documentation";
  if (d.includes("implement") || d.includes("add") || d.includes("create") || d.includes("build")) return "implementation";
  if (d.includes("review") || d.includes("audit") || d.includes("analyze")) return "analysis";
  if (d.includes("migration") || d.includes("upgrade") || d.includes("migrate")) return "migration";
  return "general";
}

// Singleton instance
export const capabilityDiscovery = new CapabilityDiscovery();
