/**
 * Tests for the DeliberationEngine (Layer 2 of Collective Intelligence).
 *
 * Key scenarios:
 * 1. register() — creates a proposal with a generated ID
 * 2. addResponse() — records a response and deduplicates by responderId
 * 3. evaluate() consensus — approve when ≥60% weighted agree
 * 4. evaluate() rejection — reject when ≥60% weighted disagree
 * 5. evaluate() synthesis — synthesize when no clear majority
 * 6. evaluate() human owner weight (2x) — owner alone can tip the vote
 * 7. auto-resolve when all requested parties respond
 * 8. resolveById() — force-resolves and emits resolution callback
 * 9. empty responses — auto-approves (agent proceeds unblocked)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeliberationEngine } from "./deliberation-engine.js";
import type { DeliberationProposal, DeliberationResponse } from "./deliberation-engine.js";

function makeProposal(overrides?: Partial<Omit<DeliberationProposal, "type" | "proposalId">>): Omit<DeliberationProposal, "type" | "proposalId"> {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    backendType: "claude",
    timestamp: Date.now(),
    action: "refactor",
    title: "Refactor auth module",
    description: "Split auth.ts into smaller files",
    approach: "Create auth/, auth/jwt.ts, auth/session.ts",
    alternatives: [],
    risks: ["Might break existing imports"],
    affectedFiles: ["web/server/auth.ts"],
    requestingFeedbackFrom: ["all"],
    ...overrides,
  };
}

function makeResponse(
  proposalId: string,
  responderId: string,
  stance: DeliberationResponse["stance"],
  responderType: "agent" | "human" = "human",
  overrides?: Partial<DeliberationResponse>,
): Omit<DeliberationResponse, "type"> {
  return {
    proposalId,
    responderId,
    responderType,
    timestamp: Date.now(),
    stance,
    reasoning: `I ${stance} because it makes sense`,
    ...overrides,
  };
}

describe("DeliberationEngine", () => {
  let engine: DeliberationEngine;

  beforeEach(() => {
    // Fresh engine for each test to avoid state bleed
    engine = new DeliberationEngine();
  });

  it("registers a proposal and assigns a proposalId", () => {
    const proposal = engine.register(makeProposal());
    expect(proposal.proposalId).toBeTruthy();
    expect(proposal.type).toBe("deliberation_proposal");
    expect(proposal.title).toBe("Refactor auth module");
  });

  it("returns the proposal via getProposal()", () => {
    const proposal = engine.register(makeProposal());
    const retrieved = engine.getProposal(proposal.proposalId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.proposalId).toBe(proposal.proposalId);
  });

  it("returns null for unknown proposalId", () => {
    expect(engine.getProposal("does-not-exist")).toBeNull();
  });

  it("adds a response and retrieves it", () => {
    const proposal = engine.register(makeProposal());
    const response = engine.addResponse(makeResponse(proposal.proposalId, "viewer-1", "agree"));
    expect(response).not.toBeNull();
    expect(response!.type).toBe("deliberation_response");
    expect(engine.getResponses(proposal.proposalId)).toHaveLength(1);
  });

  it("deduplicates responses by responderId (last response wins)", () => {
    const proposal = engine.register(makeProposal());
    engine.addResponse(makeResponse(proposal.proposalId, "viewer-1", "agree"));
    engine.addResponse(makeResponse(proposal.proposalId, "viewer-1", "disagree"));
    const responses = engine.getResponses(proposal.proposalId);
    expect(responses).toHaveLength(1);
    expect(responses[0].stance).toBe("disagree");
  });

  it("approves when ≥60% weighted agree", () => {
    const proposal = engine.register(makeProposal());
    const responses = [
      makeResponse(proposal.proposalId, "v1", "agree"),
      makeResponse(proposal.proposalId, "v2", "agree"),
      makeResponse(proposal.proposalId, "v3", "agree"),
      makeResponse(proposal.proposalId, "v4", "disagree"),
    ] as DeliberationResponse[];

    const resolution = engine.evaluate(proposal, responses);
    expect(resolution.outcome).toBe("approved");
    expect(resolution.finalApproach).toBe(proposal.approach);
    expect(resolution.voteBreakdown.agree).toBe(3);
    expect(resolution.voteBreakdown.disagree).toBe(1);
  });

  it("rejects when ≥60% weighted disagree", () => {
    const proposal = engine.register(makeProposal());
    const responses = [
      makeResponse(proposal.proposalId, "v1", "disagree"),
      makeResponse(proposal.proposalId, "v2", "disagree"),
      makeResponse(proposal.proposalId, "v3", "disagree"),
      makeResponse(proposal.proposalId, "v4", "agree"),
    ] as DeliberationResponse[];

    const resolution = engine.evaluate(proposal, responses);
    expect(resolution.outcome).toBe("rejected");
    expect(resolution.finalApproach).toBe("");
  });

  it("synthesizes when no clear majority (split vote)", () => {
    const proposal = engine.register(makeProposal());
    const responses = [
      makeResponse(proposal.proposalId, "v1", "agree"),
      makeResponse(proposal.proposalId, "v2", "disagree"),
      makeResponse(proposal.proposalId, "v3", "suggest_alternative", "human", {
        suggestedAlternative: "Use barrel exports instead of splitting files",
      }),
    ] as DeliberationResponse[];

    const resolution = engine.evaluate(proposal, responses);
    expect(resolution.outcome).toBe("synthesized");
    expect(resolution.synthesis).toContain("Refactor auth module");
  });

  it("human owner weight (2x) tips vote toward approve", () => {
    // 1 owner (2x weight) agree vs 2 spectators (0.5x each) disagree
    // Total agree weight = 2.0, disagree weight = 1.0, total = 3.0
    // agree ratio = 2/3 ≈ 0.67 > 0.60 → approved
    const proposal = engine.register(makeProposal());
    const responses = [
      makeResponse(proposal.proposalId, "owner-1", "agree"),
      makeResponse(proposal.proposalId, "spectator-1", "disagree"),
      makeResponse(proposal.proposalId, "spectator-2", "disagree"),
    ] as DeliberationResponse[];

    const roles = new Map([
      ["owner-1", "owner" as const],
      ["spectator-1", "spectator" as const],
      ["spectator-2", "spectator" as const],
    ]);

    const resolution = engine.evaluate(proposal, responses, roles);
    expect(resolution.outcome).toBe("approved");
  });

  it("auto-approves when there are no responses", () => {
    // Agent should proceed unblocked if nobody responds
    const proposal = engine.register(makeProposal());
    const resolution = engine.evaluate(proposal, []);
    expect(resolution.outcome).toBe("approved");
  });

  it("emits resolution callback on resolveById()", () => {
    const proposal = engine.register(makeProposal());
    const cb = vi.fn();
    engine.setOnResolution(cb);

    engine.addResponse(makeResponse(proposal.proposalId, "v1", "agree"));
    engine.addResponse(makeResponse(proposal.proposalId, "v2", "agree"));

    const resolution = engine.resolveById(proposal.proposalId);
    expect(resolution).not.toBeNull();
    expect(cb).toHaveBeenCalledWith(resolution);
  });

  it("auto-resolves when all specified requestingFeedbackFrom parties respond", () => {
    const cb = vi.fn();
    const proposal = engine.register(makeProposal({
      requestingFeedbackFrom: ["viewer-a", "viewer-b"],
    }));
    engine.setOnResolution(cb);

    engine.addResponse(makeResponse(proposal.proposalId, "viewer-a", "agree"));
    expect(cb).not.toHaveBeenCalled();

    engine.addResponse(makeResponse(proposal.proposalId, "viewer-b", "agree"));
    // All requested parties responded → auto-resolve
    expect(cb).toHaveBeenCalledOnce();
  });

  it("returns null for resolveById on unknown proposal", () => {
    const result = engine.resolveById("unknown-id");
    expect(result).toBeNull();
  });

  it("lists active proposals for a session", () => {
    engine.register(makeProposal({ sessionId: "session-a" }));
    engine.register(makeProposal({ sessionId: "session-a" }));
    engine.register(makeProposal({ sessionId: "session-b" }));

    const aProposals = engine.getActiveProposals("session-a");
    expect(aProposals).toHaveLength(2);
    expect(aProposals.every((p) => p.sessionId === "session-a")).toBe(true);
  });

  it("removes proposal from active list after resolution", () => {
    const proposal = engine.register(makeProposal());
    engine.resolveById(proposal.proposalId);
    expect(engine.getProposal(proposal.proposalId)).toBeNull();
    expect(engine.getActiveProposals("session-1")).toHaveLength(0);
  });
});
