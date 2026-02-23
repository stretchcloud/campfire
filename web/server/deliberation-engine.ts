/**
 * Layer 2: Deliberation Protocol
 *
 * Structured debate before agents execute significant actions (large refactors,
 * architectural changes, file deletions). Extends Campfire's existing binary
 * permission voting into nuanced multi-stakeholder deliberation.
 *
 * Flow: Agent proposes → humans/agents respond → consensus engine resolves.
 *
 * Proposal lifecycle:
 *   pending → [responses collected] → resolved (approved | rejected | synthesized)
 *
 * Resolution is triggered by:
 *   - All requested parties have responded
 *   - Deadline reached (if set)
 *   - Human owner force-resolves via POST /api/sessions/:id/deliberations/:id/resolve
 */

import { randomUUID } from "node:crypto";
import type { BackendType } from "./session-types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DeliberationAction = "refactor" | "feature" | "fix" | "investigate" | "delete" | "architect";
export type DeliberationStance = "agree" | "disagree" | "suggest_alternative" | "abstain";
export type DeliberationOutcome = "approved" | "rejected" | "synthesized";

export interface DeliberationAlternative {
  description: string;
  tradeoffs: string;
}

export interface DeliberationProposal {
  type: "deliberation_proposal";
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
  requestingFeedbackFrom: string[]; // viewer IDs or ["all"]
  deadline?: number; // Unix ms, null = indefinite
}

export interface DeliberationResponse {
  type: "deliberation_response";
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
  type: "deliberation_resolved";
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

export type ResolutionCallback = (resolution: DeliberationResolution) => void;

// ─── Deliberation Engine ──────────────────────────────────────────────────────

interface ActiveDeliberation {
  proposal: DeliberationProposal;
  responses: DeliberationResponse[];
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Manages active deliberations for all sessions.
 * One instance shared across the server (singleton pattern matching existing managers).
 *
 * Consensus weights:
 *   - Human owner:        2.0x
 *   - Human collaborator: 1.5x
 *   - Human spectator:    0.5x
 *   - Agent:              1.0x (weighted by historical accuracy in future)
 * Threshold: 60% weighted majority to approve or reject. Below threshold → synthesize.
 */
export class DeliberationEngine {
  // key = proposalId
  private active = new Map<string, ActiveDeliberation>();
  // callbacks for broadcasting resolutions to browsers
  private onResolution: ResolutionCallback | null = null;

  setOnResolution(cb: ResolutionCallback): void {
    this.onResolution = cb;
  }

  /**
   * Register a new proposal. Returns the proposal with a generated proposalId.
   * Starts deadline timer if deadline is set.
   */
  register(proposal: Omit<DeliberationProposal, "proposalId" | "type">): DeliberationProposal {
    const full: DeliberationProposal = {
      ...proposal,
      type: "deliberation_proposal",
      proposalId: randomUUID(),
    };

    const entry: ActiveDeliberation = { proposal: full, responses: [] };

    if (full.deadline) {
      const ms = full.deadline - Date.now();
      if (ms > 0) {
        entry.deadlineTimer = setTimeout(() => {
          this.resolveById(full.proposalId);
        }, ms);
      }
    }

    this.active.set(full.proposalId, entry);
    return full;
  }

  /**
   * Add a response to a proposal.
   * If all requested parties have responded, triggers resolution.
   */
  addResponse(response: Omit<DeliberationResponse, "type">): DeliberationResponse | null {
    const entry = this.active.get(response.proposalId);
    if (!entry) return null;

    const full: DeliberationResponse = { ...response, type: "deliberation_response" };

    // Deduplicate: one response per responder
    const existing = entry.responses.findIndex((r) => r.responderId === full.responderId);
    if (existing >= 0) {
      entry.responses[existing] = full;
    } else {
      entry.responses.push(full);
    }

    // Check if all requested parties have responded
    const requested = entry.proposal.requestingFeedbackFrom;
    if (requested.length > 0 && !requested.includes("all")) {
      const respondedIds = new Set(entry.responses.map((r) => r.responderId));
      const allResponded = requested.every((id) => respondedIds.has(id));
      if (allResponded) {
        this.resolveById(response.proposalId);
      }
    }

    return full;
  }

  /**
   * Force-resolve a deliberation (e.g. owner clicking "Resolve Now").
   */
  resolveById(proposalId: string): DeliberationResolution | null {
    const entry = this.active.get(proposalId);
    if (!entry) return null;

    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);

    const resolution = this.evaluate(entry.proposal, entry.responses);
    this.active.delete(proposalId);
    this.onResolution?.(resolution);
    return resolution;
  }

  getProposal(proposalId: string): DeliberationProposal | null {
    return this.active.get(proposalId)?.proposal ?? null;
  }

  getResponses(proposalId: string): DeliberationResponse[] {
    return this.active.get(proposalId)?.responses ?? [];
  }

  getActiveProposals(sessionId: string): DeliberationProposal[] {
    return Array.from(this.active.values())
      .filter((e) => e.proposal.sessionId === sessionId)
      .map((e) => e.proposal);
  }

  // ─── Consensus Algorithm ────────────────────────────────────────────────────

  /**
   * Evaluate responses to a proposal and produce a resolution.
   *
   * Weights: human owner = 2.0, collaborator = 1.5, spectator = 0.5, agent = 1.0
   * Threshold: 60% weighted score to approve or reject. Otherwise synthesize.
   */
  evaluate(
    proposal: DeliberationProposal,
    responses: DeliberationResponse[],
    /** Optional map of responderId → role for human weight calculation */
    roles?: Map<string, "owner" | "collaborator" | "spectator">,
  ): DeliberationResolution {
    if (responses.length === 0) {
      // No responses — auto-approve (agent proceeds unblocked)
      return {
        type: "deliberation_resolved",
        proposalId: proposal.proposalId,
        timestamp: Date.now(),
        outcome: "approved",
        finalApproach: proposal.approach,
        participants: [],
        voteBreakdown: { agree: 0, disagree: 0, suggest_alternative: 0, abstain: 0 },
      };
    }

    const weights = new Map<string, number>();
    for (const r of responses) {
      if (r.responderType === "human") {
        const role = roles?.get(r.responderId);
        weights.set(r.responderId, role === "owner" ? 2.0 : role === "collaborator" ? 1.5 : 0.5);
      } else {
        weights.set(r.responderId, 1.0);
      }
    }

    const totalWeight = Array.from(weights.values()).reduce((s, w) => s + w, 0);

    const breakdown = { agree: 0, disagree: 0, suggest_alternative: 0, abstain: 0 };
    let agreeScore = 0;
    let disagreeScore = 0;

    for (const r of responses) {
      const w = weights.get(r.responderId) ?? 1.0;
      breakdown[r.stance]++;
      if (r.stance === "agree") agreeScore += w;
      if (r.stance === "disagree") disagreeScore += w;
    }

    const THRESHOLD = 0.6;

    if (totalWeight > 0 && agreeScore / totalWeight >= THRESHOLD) {
      return {
        type: "deliberation_resolved",
        proposalId: proposal.proposalId,
        timestamp: Date.now(),
        outcome: "approved",
        finalApproach: proposal.approach,
        participants: responses.map((r) => r.responderId),
        voteBreakdown: breakdown,
      };
    }

    if (totalWeight > 0 && disagreeScore / totalWeight >= THRESHOLD) {
      return {
        type: "deliberation_resolved",
        proposalId: proposal.proposalId,
        timestamp: Date.now(),
        outcome: "rejected",
        finalApproach: "",
        participants: responses.map((r) => r.responderId),
        voteBreakdown: breakdown,
      };
    }

    // Below threshold — synthesize from alternatives
    const alternatives = responses
      .filter((r) => r.stance === "suggest_alternative" && r.suggestedAlternative)
      .map((r) => r.suggestedAlternative!);

    const synthesis = this.synthesizeAlternatives(proposal, alternatives, responses);

    return {
      type: "deliberation_resolved",
      proposalId: proposal.proposalId,
      timestamp: Date.now(),
      outcome: "synthesized",
      finalApproach: synthesis,
      participants: responses.map((r) => r.responderId),
      voteBreakdown: breakdown,
      synthesis,
    };
  }

  private synthesizeAlternatives(
    proposal: DeliberationProposal,
    alternatives: string[],
    responses: DeliberationResponse[],
  ): string {
    // Simple synthesis: combine original approach with top-confidence alternatives.
    // In production, replace with an LLM call that considers all responses.
    const concerns = responses
      .flatMap((r) => r.concerns ?? [])
      .slice(0, 5)
      .map((c) => `  - ${c}`)
      .join("\n");

    const alts = alternatives
      .slice(0, 3)
      .map((a, i) => `  ${i + 1}. ${a}`)
      .join("\n");

    return [
      `Synthesized approach for: ${proposal.title}`,
      "",
      `Original: ${proposal.approach}`,
      concerns ? `\nConcerns raised:\n${concerns}` : "",
      alts ? `\nSuggested alternatives:\n${alts}` : "",
      "\nRecommendation: Address the concerns raised before proceeding with the original approach.",
    ].filter(Boolean).join("\n");
  }
}

// Singleton instance
export const deliberationEngine = new DeliberationEngine();
