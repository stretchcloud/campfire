/**
 * Tests for the SemanticMemory layer (Layer 1 of Collective Intelligence).
 *
 * We use a temporary directory for each test to isolate LanceDB state.
 * Embedding calls are mocked to return predictable vectors, so tests
 * don't require a real OpenAI or Ollama instance.
 *
 * Key scenarios:
 * 1. storeFragment — writes a fragment with a mocked embedding
 * 2. queryFragments — retrieves by semantic similarity (vector search)
 * 3. queryFragments fallback — metadata filter when no embedding provider
 * 4. consolidateSession — groups fragments by tag, synthesizes summaries
 * 5. getConsolidatedKnowledge — retrieves consolidated entries by repoRoot/tag
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock embedding module ────────────────────────────────────────────────────

// We mock the embedding module so tests don't need a real API.
// Deterministic: "auth" text → unit vector in first dim, "database" → second dim.
vi.mock("./embedding.js", () => ({
  embed: vi.fn(async (text: string) => {
    // Return a simple deterministic 4-dim vector based on text content
    const v = [0, 0, 0, 0];
    if (text.toLowerCase().includes("auth")) v[0] = 1;
    if (text.toLowerCase().includes("database")) v[1] = 1;
    if (text.toLowerCase().includes("routing")) v[2] = 1;
    if (text.toLowerCase().includes("cache")) v[3] = 1;
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / mag);
  }),
  getEmbeddingDim: vi.fn(() => 4),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SemanticMemory", () => {
  let testDir: string;
  let memory: typeof import("./semantic-memory.js");

  beforeEach(async () => {
    // Fresh LanceDB dir for each test
    testDir = join(tmpdir(), `campfire-test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Re-import fresh module (vitest caches modules, use resetModules if needed)
    memory = await import("./semantic-memory.js");
    memory._resetForTest(testDir);
  });

  it("stores a memory fragment and returns it with an id", async () => {
    // Validates that storeFragment writes a MemoryFragment and returns it with a UUID
    const fragment = await memory.storeFragment({
      sessionId: "session-1",
      agentId: "agent-1",
      backendType: "claude",
      type: "observation",
      content: "The auth module uses JWT with a 7-day expiry",
      gitContext: {
        branch: "main",
        files: ["web/server/auth.ts"],
        repoRoot: "/home/user/project",
      },
      tags: ["auth", "jwt"],
      confidence: 0.9,
    });

    expect(fragment.id).toBeTruthy();
    expect(fragment.sessionId).toBe("session-1");
    expect(fragment.type).toBe("observation");
    expect(fragment.content).toContain("JWT");
    expect(fragment.tags).toContain("auth");
    expect(fragment.confidence).toBe(0.9);
    expect(fragment.isConsolidated).toBe(false);
  });

  it("queries fragments by semantic similarity", async () => {
    // Store two fragments about different topics, then query for "auth"
    // The auth fragment should be ranked first by cosine similarity
    await memory.storeFragment({
      sessionId: "session-1",
      agentId: "agent-1",
      backendType: "claude",
      type: "observation",
      content: "auth: JWT tokens stored in Redis with 7-day expiry",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["auth"],
    });

    await memory.storeFragment({
      sessionId: "session-1",
      agentId: "agent-1",
      backendType: "claude",
      type: "observation",
      content: "database: PostgreSQL with connection pooling",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["database"],
    });

    // Query for auth-related content
    const results = await memory.queryFragments("auth", { limit: 5, repoRoot: "/repo" });
    expect(results.length).toBeGreaterThan(0);
    // Auth fragment should appear first (vector search)
    expect(results[0].tags).toContain("auth");
  });

  it("filters query results by repoRoot", async () => {
    // Ensures project-scoping: fragments from /repo-a don't appear in /repo-b queries
    await memory.storeFragment({
      sessionId: "s1",
      agentId: "a1",
      backendType: "goose",
      type: "decision",
      content: "auth: use OAuth2 for authentication",
      gitContext: { branch: "main", files: [], repoRoot: "/repo-a" },
      tags: ["auth"],
    });

    await memory.storeFragment({
      sessionId: "s2",
      agentId: "a1",
      backendType: "goose",
      type: "decision",
      content: "auth: use JWT for authentication",
      gitContext: { branch: "main", files: [], repoRoot: "/repo-b" },
      tags: ["auth"],
    });

    const results = await memory.queryFragments("auth", { repoRoot: "/repo-a" });
    expect(results.every((f) => f.gitContext.repoRoot === "/repo-a")).toBe(true);
  });

  it("retrieves all fragments for a session", async () => {
    // Validates getSessionFragments returns exactly the session's fragments
    await memory.storeFragment({
      sessionId: "session-alpha",
      agentId: "a",
      backendType: "claude",
      type: "pattern",
      content: "routing: all routes defined in routes.ts",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["routing"],
    });
    await memory.storeFragment({
      sessionId: "session-beta",
      agentId: "a",
      backendType: "claude",
      type: "pattern",
      content: "cache: Redis used for session cache",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["cache"],
    });

    const alphaFragments = await memory.getSessionFragments("session-alpha");
    expect(alphaFragments).toHaveLength(1);
    expect(alphaFragments[0].sessionId).toBe("session-alpha");
  });

  it("consolidates session fragments into knowledge by tag", async () => {
    // Store 3 auth fragments and 1 database fragment, consolidate, verify tag grouping
    await memory.storeFragment({
      sessionId: "session-c",
      agentId: "a",
      backendType: "claude",
      type: "observation",
      content: "auth: JWT with RS256 signing",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["auth"],
    });
    await memory.storeFragment({
      sessionId: "session-c",
      agentId: "a",
      backendType: "claude",
      type: "observation",
      content: "auth: tokens expire in 7 days",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["auth"],
    });
    await memory.storeFragment({
      sessionId: "session-c",
      agentId: "a",
      backendType: "claude",
      type: "observation",
      content: "database: PostgreSQL via Prisma ORM",
      gitContext: { branch: "main", files: [], repoRoot: "/repo" },
      tags: ["database"],
    });

    const consolidated = await memory.consolidateSession("session-c", "/repo");

    // Should have entries for auth and database tags
    expect(consolidated.length).toBeGreaterThanOrEqual(2);
    const authEntry = consolidated.find((k) => k.tag === "auth");
    expect(authEntry).toBeTruthy();
    expect(authEntry!.sourceFragments.length).toBe(2);
    expect(authEntry!.repoRoot).toBe("/repo");
  });

  it("retrieves consolidated knowledge by repoRoot and tag", async () => {
    // After consolidation, getConsolidatedKnowledge should return the right entries
    await memory.storeFragment({
      sessionId: "session-d",
      agentId: "a",
      backendType: "claude",
      type: "decision",
      content: "routing: Express-style routing in Hono",
      gitContext: { branch: "main", files: [], repoRoot: "/my-repo" },
      tags: ["routing"],
    });

    await memory.consolidateSession("session-d", "/my-repo");

    const all = await memory.getConsolidatedKnowledge("/my-repo");
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((k) => k.repoRoot === "/my-repo")).toBe(true);

    const routing = await memory.getConsolidatedKnowledge("/my-repo", "routing");
    expect(routing.length).toBeGreaterThan(0);
    expect(routing[0].tag).toBe("routing");
  });

  it("handles consolidation gracefully when session has no fragments", async () => {
    // Should return empty array without throwing
    const result = await memory.consolidateSession("nonexistent-session", "/repo");
    expect(result).toEqual([]);
  });

  it("stores fragments with different backend types", async () => {
    // Validates backendType is preserved through store/query cycle
    const gooseFragment = await memory.storeFragment({
      sessionId: "session-goose",
      agentId: "goose-1",
      backendType: "goose",
      type: "hypothesis",
      content: "cache: Redis may be the bottleneck under load",
      gitContext: { branch: "feature/perf", files: [], repoRoot: "/repo" },
      tags: ["cache", "performance"],
    });

    expect(gooseFragment.backendType).toBe("goose");

    const results = await memory.getSessionFragments("session-goose");
    expect(results[0].backendType).toBe("goose");
  });
});
