/**
 * Tests for CollectiveIntelligenceLayer (the orchestrator).
 *
 * We mock semantic-memory to avoid LanceDB I/O in these tests.
 * The individual layer tests (semantic-memory.test.ts, deliberation-engine.test.ts, etc.)
 * cover the layer internals. These tests verify the orchestration layer:
 *
 * 1. processBrowserMessage passthrough — non-CI messages pass through unchanged
 * 2. memory_query — queries memory and broadcasts results
 * 3. memory_store — stores fragment and broadcasts confirmation
 * 4. deliberation_respond — records response, returns null (consumed)
 * 5. deliberation_resolve — resolves proposal, returns null
 * 6. inject_thought — ingests into shared context stream, returns null
 * 7. route_task — routes and broadcasts result
 * 8. processAgentMessage — called without blocking (fire-and-forget)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CollectiveIntelligenceLayer, scrubThinkingText, classifyExtraction } from "./collective-intelligence.js";
import * as semanticMemory from "./semantic-memory.js";
import * as memoryConsolidation from "./memory-consolidation.js";
import { sharedContextManager } from "./shared-context.js";
import type { BrowserOutgoingMessage, BrowserIncomingMessage } from "./session-types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock semantic-memory to avoid LanceDB
vi.mock("./semantic-memory.js", () => ({
  storeFragment: vi.fn(async () => ({
    id: "frag-1",
    sessionId: "s1",
    agentId: "a1",
    backendType: "claude",
    timestamp: Date.now(),
    type: "observation",
    content: "mock fragment",
    gitContext: { branch: "main", files: [], repoRoot: "/repo" },
    references: [],
    confidence: 0.7,
    tags: ["auth"],
    isConsolidated: false,
  })),
  queryFragments: vi.fn(async () => []),
  consolidateSession: vi.fn(async () => []),
  getConsolidatedKnowledge: vi.fn(async () => []),
  // v2 enrichment entry point (§3.6.2) — reinforcement happens inside it
  queryForEnrichment: vi.fn(async () => ({ items: [], block: null })),
}));

// Mock the consolidation pipeline (§3.4) — onSessionEnd routes through it
vi.mock("./memory-consolidation.js", () => ({
  consolidate: vi.fn(async (ctx: { reason: string }) => ({
    status: "ran",
    synthesisMethod: "none",
    knowledgeUpserted: 0,
    fragmentsConsolidated: 0,
    reason: ctx.reason,
  })),
  shouldConsolidateOnTurn: vi.fn(async () => false),
  noteSessionActivity: vi.fn(),
  stopIdleWatcher: vi.fn(),
}));

// Mock capability-discovery to avoid disk I/O
vi.mock("./capability-discovery.js", () => {
  const mockInstance = {
    route: vi.fn(async () => ({
      sessionId: "session-best",
      backendType: "claude",
      confidence: 0.8,
      reasoning: "Best fit for task",
      alternatives: [],
    })),
    registerCapabilities: vi.fn(),
    getCapabilities: vi.fn(() => null),
    getAllCapabilities: vi.fn(() => []),
    resolveProbe: vi.fn(() => false),
    startExecution: vi.fn(() => "exec-1"),
    completeExecution: vi.fn(),
    recordFeedback: vi.fn(),
    getExecutionHistory: vi.fn(() => []),
    createProbe: vi.fn(() => ({ probeId: "p1", sessionId: "s1", taskDescription: "t", instruction: "i" })),
    registerProbe: vi.fn(() => Promise.resolve({ confidence: 0.5, reasoning: "ok" })),
  };
  return {
    CapabilityDiscovery: vi.fn(() => mockInstance),
    capabilityDiscovery: mockInstance,
  };
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CollectiveIntelligenceLayer", () => {
  let ci: CollectiveIntelligenceLayer;
  const broadcasts: Array<{ sessionId: string; msg: BrowserIncomingMessage }> = [];

  beforeEach(() => {
    broadcasts.length = 0;
    ci = new CollectiveIntelligenceLayer();
    ci.setBroadcast((sessionId, msg) => broadcasts.push({ sessionId, msg }));
  });

  it("passes through non-CI browser messages unchanged", async () => {
    const msg: BrowserOutgoingMessage = {
      type: "user_message",
      content: "hello",
    };

    // With no memory (mocked empty), message passes through
    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeTruthy();
    expect((result as typeof msg).type).toBe("user_message");
  });

  it("memory_query broadcasts query result and returns null", async () => {
    const msg = { type: "memory_query", query: "auth", limit: 5 } as BrowserOutgoingMessage;
    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
    const broadcast = broadcasts.find((b) => b.msg.type === "memory_query_result");
    expect(broadcast).toBeTruthy();
    expect((broadcast!.msg as { type: "memory_query_result"; query: string }).query).toBe("auth");
  });

  it("memory_store stores fragment and broadcasts confirmation", async () => {
    const msg = {
      type: "memory_store",
      content: "The auth module uses JWT",
      memoryType: "observation",
      tags: ["auth"],
    } as BrowserOutgoingMessage;

    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
    const broadcast = broadcasts.find((b) => b.msg.type === "memory_stored");
    expect(broadcast).toBeTruthy();
  });

  it("deliberation_respond is consumed (returns null)", async () => {
    const msg = {
      type: "deliberation_respond",
      proposalId: "prop-1",
      stance: "agree",
      reasoning: "Makes sense",
    } as BrowserOutgoingMessage;

    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
  });

  it("deliberation_resolve is consumed (returns null)", async () => {
    const msg = {
      type: "deliberation_resolve",
      proposalId: "prop-1",
    } as BrowserOutgoingMessage;

    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
  });

  it("route_task broadcasts route result and returns null", async () => {
    const msg = {
      type: "route_task",
      taskDescription: "Refactor the auth module",
      availableSessions: ["s1", "s2"],
    } as BrowserOutgoingMessage;

    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
    const broadcast = broadcasts.find((b) => b.msg.type === "route_result");
    expect(broadcast).toBeTruthy();
    expect((broadcast!.msg as { type: "route_result"; result: { confidence: number } }).result.confidence).toBe(0.8);
  });

  it("inject_thought ingests into shared context and returns null", async () => {
    const msg = {
      type: "inject_thought",
      content: "I think the bottleneck is in the database layer",
      thoughtType: "concern",
    } as BrowserOutgoingMessage;

    const result = await ci.processBrowserMessage("session-1", msg);
    expect(result).toBeNull();
    // Fragment should have been broadcast
    const broadcast = broadcasts.find((b) => b.msg.type === "shared_thought");
    expect(broadcast).toBeTruthy();
  });

  it("processAgentMessage is fire-and-forget (does not throw)", () => {
    // Should not throw even with an unusual message
    expect(() => {
      ci.processAgentMessage("session-1", "claude", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] } as unknown,
        parent_tool_use_id: null,
      } as BrowserIncomingMessage);
    }).not.toThrow();
  });

  it("setBroadcast allows CI to emit messages to browsers", async () => {
    let received: BrowserIncomingMessage | null = null;
    ci.setBroadcast((_sid, msg) => { received = msg; });

    const msg = { type: "memory_query", query: "test" } as BrowserOutgoingMessage;
    await ci.processBrowserMessage("session-1", msg);

    expect(received).not.toBeNull();
    expect(received!.type).toBe("memory_query_result");
  });
});

// ─── Semantic-memory v2 wiring (§3.4 / §3.6) ──────────────────────────────────

describe("scrubThinkingText (§3.6.5)", () => {
  // Table-driven: thinking-block content must never survive into anything
  // that gets persisted to semantic memory.
  it.each([
    // [input, expected]
    ["plain text stays", "plain text stays"],
    ["before <thinking>secret reasoning</thinking> after", "before after"],
    ["before <think>secret</think> after", "before after"],
    ["mixed <THINKING>CASE</THINKING> tags", "mixed tags"],
    ["unterminated <thinking>trailing block never closes", "unterminated"],
    ["multi <think>a</think> and <thinking>b</thinking> blocks", "multi and blocks"],
    ["<thinking>only thinking</thinking>", ""],
  ])("scrubs %j", (input, expected) => {
    expect(scrubThinkingText(input)).toBe(expected);
  });
});

describe("classifyExtraction (§3.6.5)", () => {
  it("types decision cues as 'decision'", () => {
    // "decided/instead/because" are the doc's structural decision cues.
    expect(classifyExtraction("We decided to keep the Hono router.").type).toBe("decision");
    expect(classifyExtraction("Use bun instead of node for the scripts here.").type).toBe("decision");
    expect(classifyExtraction("Chose LanceDB because it needs no server.").type).toBe("decision");
  });

  it("types error+fix pairs as 'pattern' tagged 'failure'", () => {
    // MemoryType has no "failure" variant — the failure tag is the contract
    // that lets consolidation distill these into KnowledgeType "failure" rows.
    const result = classifyExtraction(
      "The build failed with a TS2307 error; fixed by adding the .js extension to the import.",
    );
    expect(result.type).toBe("pattern");
    expect(result.extraTags).toContain("failure");
  });

  it("defaults everything else to 'observation' (recall-biased, no keyword gate)", () => {
    const result = classifyExtraction("The server persists sessions to disk under the user home directory.");
    expect(result.type).toBe("observation");
    expect(result.extraTags).toEqual([]);
  });

  it("prefers failure over decision when both cue sets match", () => {
    // An error+fix narrative often contains "because" — the failure pairing
    // is the more specific signal and must win.
    const result = classifyExtraction("It failed because of a race; fixed by serializing the queue.");
    expect(result.type).toBe("pattern");
    expect(result.extraTags).toContain("failure");
  });
});

describe("enrichUserMessage (§3.6.2)", () => {
  let ci: CollectiveIntelligenceLayer;

  beforeEach(() => {
    vi.mocked(semanticMemory.queryForEnrichment).mockClear();
    ci = new CollectiveIntelligenceLayer();
  });

  it("delegates to queryForEnrichment with the session context and returns its result", async () => {
    // The CI layer is a thin passthrough: namespace planning, budgets and
    // REINFORCEMENT all live inside queryForEnrichment — the layer must not
    // reinforce again or reshape the result.
    const enrichment = {
      items: [{ id: "k1", kind: "knowledge" as const, namespace: "global", summary: "s", weight: 1 }],
      block: "--- Campfire memory (auto-recalled; may be stale) ---\n--- end memory ---",
    };
    vi.mocked(semanticMemory.queryForEnrichment).mockResolvedValueOnce(enrichment);

    const result = await ci.enrichUserMessage(
      { sessionId: "s-enrich", repoRoot: "/repo", backendType: "codex" },
      "how do we deploy?",
    );

    expect(semanticMemory.queryForEnrichment).toHaveBeenCalledWith({
      sessionId: "s-enrich",
      repoRoot: "/repo",
      backendType: "codex",
      queryText: "how do we deploy?",
    });
    expect(result).toBe(enrichment);
  });
});

describe("memory extraction (§3.6.5 recall-biased upgrade)", () => {
  let ci: CollectiveIntelligenceLayer;

  const assistantMsg = (text: string): BrowserIncomingMessage => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] } as unknown,
    parent_tool_use_id: null,
  } as BrowserIncomingMessage);

  async function drain() {
    // processAgentMessage is fire-and-forget; give its async chain two ticks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    vi.mocked(semanticMemory.storeFragment).mockClear();
    ci = new CollectiveIntelligenceLayer();
  });

  it("stores substantial text WITHOUT the old keyword gate", async () => {
    // v1 dropped any assistant text lacking one of ten keywords ("function",
    // "class", ...). This sentence has none of them and must now be stored.
    ci.processAgentMessage("s-x1", "claude", assistantMsg(
      "The session data lives on disk and survives restarts of the whole server process.",
    ));
    await drain();

    expect(semanticMemory.storeFragment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(semanticMemory.storeFragment).mock.calls[0][0]).toMatchObject({
      type: "observation",
      sessionId: "s-x1",
    });
  });

  it("never stores thinking-block content", async () => {
    // Thinking is scrubbed BEFORE the length check and store — the persisted
    // fragment must not contain any reasoning text.
    ci.processAgentMessage("s-x2", "claude", assistantMsg(
      "The launcher retries the spawn twice before giving up entirely. <thinking>I am secretly unsure about the retry count, maybe grep again</thinking>",
    ));
    await drain();

    expect(semanticMemory.storeFragment).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(semanticMemory.storeFragment).mock.calls[0][0];
    expect(stored.content).toBe("The launcher retries the spawn twice before giving up entirely.");
    expect(stored.content).not.toContain("secretly unsure");
  });

  it("skips content that is only thinking (too short once scrubbed)", async () => {
    // A message that is pure reasoning must produce no fragment at all.
    ci.processAgentMessage("s-x3", "claude", assistantMsg(
      "<thinking>long private reasoning that would have passed the fifty character minimum easily on its own</thinking> ok",
    ));
    await drain();

    expect(semanticMemory.storeFragment).not.toHaveBeenCalled();
  });

  it("types decision-cue text as a 'decision' fragment", async () => {
    ci.processAgentMessage("s-x4", "codex", assistantMsg(
      "We decided to use the adapter registry instead of hardcoding backends in the launcher.",
    ));
    await drain();

    expect(semanticMemory.storeFragment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(semanticMemory.storeFragment).mock.calls[0][0]).toMatchObject({
      type: "decision",
      backendType: "codex",
    });
  });

  it("types error+fix pairs as 'pattern' tagged 'failure'", async () => {
    ci.processAgentMessage("s-x5", "claude", assistantMsg(
      "The websocket handshake failed with a 403 error; fixed by forwarding the auth cookie in the upgrade request.",
    ));
    await drain();

    expect(semanticMemory.storeFragment).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(semanticMemory.storeFragment).mock.calls[0][0];
    expect(stored.type).toBe("pattern");
    expect(stored.tags).toContain("failure");
  });
});

describe("onSessionEnd (§3.4 session_end trigger + promotion scrubbing)", () => {
  let ci: CollectiveIntelligenceLayer;

  beforeEach(() => {
    vi.mocked(semanticMemory.storeFragment).mockClear();
    vi.mocked(memoryConsolidation.consolidate).mockClear();
    ci = new CollectiveIntelligenceLayer();
  });

  it("routes consolidation through consolidate({reason: 'session_end'})", async () => {
    // The old direct consolidateSession call is replaced by the pipeline
    // entry point, preserving the trigger semantics (§3.4 trigger 3).
    await ci.onSessionEnd("s-end-1", "claude", "/repo");

    expect(memoryConsolidation.consolidate).toHaveBeenCalledWith({
      sessionId: "s-end-1",
      repoRoot: "/repo",
      backendType: "claude",
      reason: "session_end",
    });
  });

  it("still promotes significant shared-context fragments, scrubbed, excluding agent thinking", async () => {
    // Preserves the pre-existing promotion semantics while enforcing §3.6.5:
    // agent "thought" fragments (verbatim thinking blocks) are excluded even
    // when significant, and inline <thinking> markup is stripped from what
    // does get promoted.
    const sessionId = "s-end-2";
    const stream = sharedContextManager.getOrCreate(sessionId);
    await stream.ingest({
      agentId: "human",
      isHuman: true,
      type: "insight",
      content: "Rate limiting uses a token bucket <thinking>redacted musings</thinking> per API key",
    });
    await stream.ingest({
      agentId: sessionId,
      isHuman: false,
      type: "thought",
      content: "raw chain of thought that must never be persisted",
    });
    // Force the agent thought to be "significant" so only the type/isHuman
    // exclusion (not the consensus score) keeps it out of memory.
    for (const f of stream.getAllFragments()) {
      if (f.type === "thought") f.consensusScore = 0.95;
    }

    await ci.onSessionEnd(sessionId, "claude", "/repo");

    const storedContents = vi.mocked(semanticMemory.storeFragment).mock.calls.map((c) => c[0].content);
    expect(storedContents).toContain("Rate limiting uses a token bucket per API key");
    expect(storedContents.join("\n")).not.toContain("raw chain of thought");
    expect(storedContents.join("\n")).not.toContain("redacted musings");

    // Stream is torn down after promotion (unchanged behavior)
    expect(sharedContextManager.get(sessionId)).toBeFalsy();
  });
});
