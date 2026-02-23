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
import { CollectiveIntelligenceLayer } from "./collective-intelligence.js";
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
