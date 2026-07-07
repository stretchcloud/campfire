/**
 * Tests for the SemanticMemory layer (Layer 1 of Collective Intelligence) — v2.
 *
 * We use a temporary directory for each test to isolate LanceDB state.
 * Embedding calls are mocked to return predictable vectors, so tests
 * don't require a real OpenAI or Ollama instance.
 *
 * Covered areas:
 *  1. v1-compatible API (storeFragment / queryFragments / consolidateSession /
 *     getConsolidatedKnowledge) — original tests preserved
 *  2. Decay math (§3.2) — table-driven pure-function tests
 *  3. Namespace where() strings + SQL quoting (§3.3 pushdown, §1.7 fix)
 *  4. v2 storeFragment namespace resolution + embeddingStatus lifecycle (§1.6)
 *  5. Scored retrieval: composite score, starvation fix, dedupe, fallback
 *  6. Reinforcement, pinning, eviction sweep + hard cap (§3.2)
 *  7. Consolidation support APIs (§3.4 Stage 1/3): unconsolidated fetch,
 *     mark-consolidated, upsert-by-(namespace,tag) + supersession, related
 *     knowledge, concat fallback idempotency (§1.2 fix)
 *  8. Enrichment entry point: §3.6.2 block format, budgets, reinforcement
 *  9. Migration (§3.5): v1 → v2 with namespace backfill + zero-vector →
 *     "pending", dimension change, lazy re-embed queue
 *
 * v2 harness change note: the embedding mock is hoisted so individual tests
 * can switch provider/dim mid-test (needed for provider-change migration
 * coverage), and it now includes getEmbeddingProviderName (new v2 export).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock embedding module ────────────────────────────────────────────────────

// We mock the embedding module so tests don't need a real API.
// Deterministic: "auth" text → unit vector in first dim, "database" → second dim.
const mockEmbed = vi.hoisted(() => vi.fn());
const mockGetDim = vi.hoisted(() => vi.fn());
const mockProviderName = vi.hoisted(() => vi.fn());

vi.mock("./embedding.js", () => ({
  embed: mockEmbed,
  getEmbeddingDim: mockGetDim,
  getEmbeddingProviderName: mockProviderName,
  OPENAI_DIM: 1536,
  OLLAMA_DIM: 768,
}));

/** Deterministic keyword → unit-vector embedding with `dim` dimensions. */
function deterministicEmbed(dim: number) {
  return async (text: string): Promise<number[]> => {
    const v = Array(dim).fill(0) as number[];
    if (text.toLowerCase().includes("auth")) v[0] = 1;
    if (text.toLowerCase().includes("database")) v[1] = 1;
    if (text.toLowerCase().includes("routing")) v[2] = 1;
    if (text.toLowerCase().includes("cache")) v[3] = 1;
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / mag);
  };
}

// ─── Test harness ─────────────────────────────────────────────────────────────

import * as settingsManager from "./settings-manager.js";

let testDir: string;
let memory: typeof import("./semantic-memory.js");

beforeEach(async () => {
  // Fresh memory root + settings file for each test
  testDir = join(tmpdir(), `campfire-test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  settingsManager._resetForTest(join(testDir, "settings.json"));

  // Default provider: "openai" with a tiny 4-dim space
  mockEmbed.mockImplementation(deterministicEmbed(4));
  mockGetDim.mockReturnValue(4);
  mockProviderName.mockReturnValue("openai");

  memory = await import("./semantic-memory.js");
  memory._resetForTest(testDir);
});

afterEach(() => {
  settingsManager._resetForTest();
  rmSync(testDir, { recursive: true, force: true });
});

/** Shorthand for storeFragment options. */
function frag(overrides: Partial<Parameters<typeof memory.storeFragment>[0]> = {}) {
  return {
    sessionId: "session-1",
    agentId: "agent-1",
    backendType: "claude" as const,
    type: "observation" as const,
    content: "auth: generic note",
    gitContext: { branch: "main", files: [], repoRoot: "/repo" },
    ...overrides,
  };
}

async function rawTable(name: string) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(join(testDir, "lancedb"));
  return db.openTable(name);
}

// ─── Original v1-compatible API tests (preserved) ────────────────────────────

describe("SemanticMemory", () => {
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

// ─── Decay math (§3.2) — pure, table-driven ──────────────────────────────────

describe("computeDecayedWeight", () => {
  const HOUR = 3_600_000;
  const policy = { halfLifeHours: 100, reinforceMultiplier: 1.5 };
  const t0 = 1_700_000_000_000;

  it("follows the half-life table", () => {
    // w(t) = 0.5^(age / halfLife) — one half-life halves the weight, etc.
    const cases: Array<{ ageHours: number; expected: number }> = [
      { ageHours: 0, expected: 1 },
      { ageHours: 50, expected: Math.pow(0.5, 0.5) },
      { ageHours: 100, expected: 0.5 },
      { ageHours: 200, expected: 0.25 },
      { ageHours: 400, expected: 0.0625 },
    ];
    for (const { ageHours, expected } of cases) {
      const w = memory.computeDecayedWeight(
        { lastReinforcedAt: t0, accessCount: 0 },
        t0 + ageHours * HOUR,
        policy,
      );
      expect(w).toBeCloseTo(expected, 6);
    }
  });

  it("pinned fragments never decay", () => {
    const w = memory.computeDecayedWeight(
      { pinned: true, lastReinforcedAt: t0 },
      t0 + 100000 * HOUR,
      policy,
    );
    expect(w).toBe(1);
  });

  it("null half-life (policy) means no decay", () => {
    const w = memory.computeDecayedWeight(
      { lastReinforcedAt: t0 },
      t0 + 100000 * HOUR,
      { halfLifeHours: null, reinforceMultiplier: 1.5 },
    );
    expect(w).toBe(1);
  });

  it("reinforcement extends the effective half-life: halfLife × multiplier^accessCount", () => {
    // accessCount 1 with ×1.5 → effective half-life 150h → at age 150h, w = 0.5
    const w = memory.computeDecayedWeight(
      { lastReinforcedAt: t0, accessCount: 1 },
      t0 + 150 * HOUR,
      policy,
    );
    expect(w).toBeCloseTo(0.5, 6);
  });

  it("caps the reinforcement multiplier at accessCount 8", () => {
    // accessCount 100 behaves exactly like accessCount 8 — no immortality by accident
    const w100 = memory.computeDecayedWeight(
      { lastReinforcedAt: t0, accessCount: 100 },
      t0 + 1000 * HOUR,
      policy,
    );
    const w8 = memory.computeDecayedWeight(
      { lastReinforcedAt: t0, accessCount: 8 },
      t0 + 1000 * HOUR,
      policy,
    );
    expect(w100).toBeCloseTo(w8, 10);
  });

  it("honors a per-fragment halfLifeHours override", () => {
    const w = memory.computeDecayedWeight(
      { lastReinforcedAt: t0, halfLifeHours: 10 },
      t0 + 10 * HOUR,
      policy,
    );
    expect(w).toBeCloseTo(0.5, 6);
  });

  it("falls back to timestamp when lastReinforcedAt is missing, and clamps future anchors", () => {
    const w = memory.computeDecayedWeight({ timestamp: t0 }, t0 + 100 * HOUR, policy);
    expect(w).toBeCloseTo(0.5, 6);
    // An anchor in the future must not produce w > 1
    const wFuture = memory.computeDecayedWeight({ lastReinforcedAt: t0 + HOUR }, t0, policy);
    expect(wFuture).toBe(1);
  });
});

// ─── Namespace where() strings (§3.3 pushdown, §1.7 fix) ─────────────────────

describe("namespace query planner where() strings", () => {
  it("builds the pushed-down namespace + embeddingStatus predicate", () => {
    // The exact shape from design §3.3: namespace AND embeddingStatus = 'ok'
    expect(memory.buildNamespaceWhere("repo:abc123")).toBe(
      "namespace = 'repo:abc123' AND embeddingStatus = 'ok'",
    );
  });

  it("omits the embedding filter for metadata-only scans", () => {
    expect(memory.buildNamespaceWhere("global", false)).toBe("namespace = 'global'");
  });

  it("escapes single quotes in values (SQL-injection-safe where strings)", () => {
    expect(memory.sqlQuote("o'brien")).toBe("'o''brien'");
    expect(memory.buildNamespaceWhere("session:o'brien", false)).toBe(
      "namespace = 'session:o''brien'",
    );
  });
});

// ─── v2 storeFragment: namespaces + embeddingStatus (§3.1, §1.6) ─────────────

describe("v2 storeFragment", () => {
  it("defaults to repo:<hash> namespace when a repoRoot is present", async () => {
    const f = await memory.storeFragment(frag({ content: "auth: note" }));
    expect(f.namespace).toBe(memory.repoNamespace("/repo"));
    expect(f.repoRootHash).toBe(memory.hashRepoRoot("/repo"));
    expect(f.embeddingStatus).toBe("ok");
    expect(f.accessCount).toBe(0);
    expect(f.pinned).toBe(false);
    expect(f.lastReinforcedAt).toBe(f.timestamp);
  });

  it("defaults to session:<id> namespace when there is no repoRoot", async () => {
    const f = await memory.storeFragment(
      frag({ sessionId: "s9", gitContext: { branch: "main", files: [], repoRoot: "" } }),
    );
    expect(f.namespace).toBe("session:s9");
    expect(f.repoRootHash).toBe("");
  });

  it("honors an explicit namespace option", async () => {
    const f = await memory.storeFragment(frag({ namespace: "global" }));
    expect(f.namespace).toBe("global");
  });

  it("stores embeddingStatus 'none' when no provider is configured (§1.6 fix)", async () => {
    // Provider "none": no fake 1536-dim zero vectors in the ANN index
    mockGetDim.mockReturnValue(null);
    mockProviderName.mockReturnValue("none");
    mockEmbed.mockResolvedValue(null);

    const f = await memory.storeFragment(frag());
    expect(f.embeddingStatus).toBe("none");
    expect(f.embedding).toBeUndefined();
  });

  it("stores embeddingStatus 'pending' when the embed call fails with a provider configured", async () => {
    mockEmbed.mockResolvedValueOnce(null); // one failed call
    const f = await memory.storeFragment(frag({ content: "auth: transient failure" }));
    expect(f.embeddingStatus).toBe("pending");

    // Pending rows are excluded from vector search results (where pushdown)
    const results = await memory.queryFragments("auth", { repoRoot: "/repo" });
    expect(results.find((r) => r.id === f.id)).toBeUndefined();
  });
});

// ─── Scored retrieval (§3.3) ─────────────────────────────────────────────────

describe("scored retrieval", () => {
  it("does not starve scoped queries when other scopes dominate the ANN neighborhood (§1.7 fix)", async () => {
    // v1 over-fetched limit×3 globally then post-filtered — 10 near-identical
    // repo-b rows would evict the single repo-a row from the candidate set.
    for (let i = 0; i < 10; i++) {
      await memory.storeFragment(
        frag({
          sessionId: "sb",
          content: `auth: repo-b note ${i}`,
          gitContext: { branch: "main", files: [], repoRoot: "/repo-b" },
        }),
      );
    }
    const target = await memory.storeFragment(
      frag({
        sessionId: "sa",
        content: "auth: repo-a note",
        gitContext: { branch: "main", files: [], repoRoot: "/repo-a" },
      }),
    );

    const results = await memory.queryFragments("auth", { repoRoot: "/repo-a", limit: 2 });
    expect(results.map((r) => r.id)).toContain(target.id);
    expect(results.every((r) => r.gitContext.repoRoot === "/repo-a")).toBe(true);
  });

  it("respects per-namespace recall depth in queryScoredFragments", async () => {
    // Distinct keyword mixes → distinct vectors (no near-dup collapse)
    const contents = ["auth alpha", "auth database", "auth routing", "auth cache", "auth database routing"];
    for (const content of contents) {
      await memory.storeFragment(frag({ content }));
    }
    const ns = memory.repoNamespace("/repo");
    const results = await memory.queryScoredFragments("auth", [{ namespace: ns, depth: 2 }]);
    expect(results).toHaveLength(2);
    // Best similarity ("auth alpha", simNorm 1) ranks first
    expect(results[0].fragment.content).toBe("auth alpha");
    expect(results[0].simNorm).toBeGreaterThan(results[1].simNorm);
  });

  it("weights the composite score by confidence", async () => {
    // Same similarity, different confidence → higher confidence wins
    const low = await memory.storeFragment(frag({ content: "auth database low", confidence: 0.3 }));
    const high = await memory.storeFragment(frag({ content: "auth routing high", confidence: 0.9 }));
    const ns = memory.repoNamespace("/repo");
    const results = await memory.queryScoredFragments("auth", [{ namespace: ns, depth: 4 }]);
    const ids = results.map((r) => r.fragment.id);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });

  it("ranks reinforced fragments above equally-similar unreinforced ones after decay", async () => {
    // Both fragments have simNorm ≈ 0.707 to "auth"; A is reinforced once.
    // At one base half-life (repo: 720h), w(B) = 0.5 while w(A) = 0.5^(1/1.5).
    const a = await memory.storeFragment(frag({ content: "auth database pattern" }));
    const b = await memory.storeFragment(frag({ content: "auth routing pattern" }));
    memory.reinforceFragments([a.id]);
    await memory.flushReinforcements();

    const ns = memory.repoNamespace("/repo");
    const future = Date.now() + 720 * 3_600_000;
    const results = await memory.queryScoredFragments("auth", [{ namespace: ns, depth: 4 }], future);
    const ids = results.map((r) => r.fragment.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    const scoredA = results.find((r) => r.fragment.id === a.id)!;
    const scoredB = results.find((r) => r.fragment.id === b.id)!;
    expect(scoredA.weight).toBeGreaterThan(scoredB.weight);
  });

  it("dedupes near-duplicate fragments (cosine > 0.97), keeping the higher score", async () => {
    await memory.storeFragment(frag({ content: "auth: identical insight", confidence: 0.5 }));
    const better = await memory.storeFragment(frag({ content: "auth: identical insight", confidence: 0.9 }));
    const ns = memory.repoNamespace("/repo");
    const results = await memory.queryScoredFragments("auth", [{ namespace: ns, depth: 4 }]);
    expect(results).toHaveLength(1);
    expect(results[0].fragment.id).toBe(better.id);
  });

  it("falls back to w(t)×confidence ranking when no provider is configured", async () => {
    // §3.3: never zero-vector search — metadata scan ranked by weight × confidence
    mockGetDim.mockReturnValue(null);
    mockProviderName.mockReturnValue("none");
    mockEmbed.mockResolvedValue(null);

    const noRepo = { branch: "main", files: [], repoRoot: "" };
    const low = await memory.storeFragment(
      frag({ sessionId: "sf", gitContext: noRepo, content: "low value note", confidence: 0.2 }),
    );
    const high = await memory.storeFragment(
      frag({ sessionId: "sf", gitContext: noRepo, content: "high value note", confidence: 0.9 }),
    );

    const results = await memory.queryScoredFragments("anything", [
      { namespace: "session:sf", depth: 4 },
    ]);
    expect(results.map((r) => r.fragment.id)).toEqual([high.id, low.id]);

    // Legacy API takes the same fallback path
    const legacy = await memory.queryFragments("anything", { sessionId: "sf" });
    expect(legacy[0].id).toBe(high.id);
  });
});

// ─── Reinforcement, pinning, eviction (§3.2) ─────────────────────────────────

describe("reinforcement and pinning", () => {
  it("reinforceFragments batches accessCount+1 and lastReinforcedAt=now", async () => {
    const f = await memory.storeFragment(frag({ content: "auth: reinforce me" }));
    const before = f.lastReinforcedAt!;

    memory.reinforceFragments([f.id]);
    memory.reinforceFragments([f.id, f.id]); // batched increments accumulate
    await memory.flushReinforcements();

    const [row] = await memory.getSessionFragments("session-1");
    expect(row.accessCount).toBe(3);
    expect(row.lastReinforcedAt!).toBeGreaterThanOrEqual(before);
  });

  it("setFragmentPinned pins/unpins and reports missing ids", async () => {
    const f = await memory.storeFragment(frag({ content: "auth: pin me" }));
    expect(await memory.setFragmentPinned(f.id, true)).toBe(true);
    const [row] = await memory.getSessionFragments("session-1");
    expect(row.pinned).toBe(true);
    expect(await memory.setFragmentPinned("no-such-id", true)).toBe(false);
  });

  it("pinned fragments keep weight 1 no matter how old", async () => {
    const f = await memory.storeFragment(frag({ content: "auth: eternal" }));
    await memory.setFragmentPinned(f.id, true);
    const ns = memory.repoNamespace("/repo");
    const farFuture = Date.now() + 1_000_000 * 3_600_000;
    const results = await memory.queryScoredFragments("auth", [{ namespace: ns, depth: 4 }], farFuture);
    expect(results[0].fragment.id).toBe(f.id);
    expect(results[0].weight).toBe(1);
  });
});

describe("eviction sweep", () => {
  it("deletes only decayed+consolidated+unpinned fragments; leaves un-consolidated ones for consolidation", async () => {
    const noRepo = { branch: "main", files: [], repoRoot: "" };
    // session namespace: half-life 168h — 2000h ≫ enough for w < 0.05
    const consolidated = await memory.storeFragment(
      frag({ sessionId: "se", gitContext: noRepo, content: "old consolidated" }),
    );
    const unconsolidated = await memory.storeFragment(
      frag({ sessionId: "se", gitContext: noRepo, content: "old but never consolidated" }),
    );
    const pinnedOld = await memory.storeFragment(
      frag({ sessionId: "se", gitContext: noRepo, content: "old pinned" }),
    );
    await memory.markFragmentsConsolidated([consolidated.id, pinnedOld.id], "k-1");
    await memory.setFragmentPinned(pinnedOld.id, true);

    const result = await memory.runEvictionSweep({ now: Date.now() + 2000 * 3_600_000 });
    expect(result.decayedDeleted).toBe(1);

    const remaining = await memory.getSessionFragments("se");
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(consolidated.id); // essence lives in the consolidated table
    expect(ids).toContain(unconsolidated.id); // do NOT silently drop (§3.2)
    expect(ids).toContain(pinnedOld.id); // pinned never evicted
  });

  it("enforces the per-namespace hard cap with lowest-weight eviction, sparing pinned rows", async () => {
    const noRepo = { branch: "main", files: [], repoRoot: "" };
    const stored = [];
    for (let i = 0; i < 6; i++) {
      stored.push(
        await memory.storeFragment(frag({ sessionId: "sc", gitContext: noRepo, content: `note ${i}` })),
      );
    }
    await memory.setFragmentPinned(stored[0].id, true);

    const result = await memory.runEvictionSweep({ perNamespaceCap: 3 });
    expect(result.capEvicted).toBe(3);

    const remaining = await memory.getSessionFragments("sc");
    expect(remaining).toHaveLength(3);
    expect(remaining.map((r) => r.id)).toContain(stored[0].id); // pinned survives
  });
});

// ─── Consolidation support APIs (§3.4 Stage 1/3, §1.2 fix) ───────────────────

describe("consolidation support APIs", () => {
  it("getUnconsolidatedFragments works by session id and by namespace, excluding consolidated rows", async () => {
    const a = await memory.storeFragment(frag({ sessionId: "sx", content: "auth one" }));
    const b = await memory.storeFragment(frag({ sessionId: "sx", content: "auth database two" }));
    await memory.markFragmentsConsolidated([a.id], "k-9");

    const bySession = await memory.getUnconsolidatedFragments("sx");
    expect(bySession.map((f) => f.id)).toEqual([b.id]);

    const byNamespace = await memory.getUnconsolidatedFragments(memory.repoNamespace("/repo"));
    expect(byNamespace.map((f) => f.id)).toEqual([b.id]);

    // Embeddings are included so Stage-1 JUDGE can cluster without re-embedding
    expect(byNamespace[0].embedding).toHaveLength(4);
  });

  it("markFragmentsConsolidated sets isConsolidated + consolidatedInto (§1.2 fix)", async () => {
    const f = await memory.storeFragment(frag({ content: "auth mark" }));
    await memory.markFragmentsConsolidated([f.id], "knowledge-42");
    const [row] = await memory.getSessionFragments("session-1");
    expect(row.isConsolidated).toBe(true);
    expect(row.consolidatedInto).toBe("knowledge-42");
  });

  it("upsertKnowledgeFromDistillation upserts by (namespace, tag) with supersession tombstones", async () => {
    const src = await memory.storeFragment(frag({ content: "auth source" }));
    const ctx = { sessionId: "s1", repoRoot: "/repo", backendType: "claude" };

    const [k1] = await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", type: "pattern", summary: "auth uses JWT", confidence: 0.8, sourceFragmentIds: [src.id], namespace: "repo" }],
      ctx,
    );
    expect(k1.namespace).toBe(memory.repoNamespace("/repo"));
    expect(k1.synthesisMethod).toBe("llm"); // default
    expect(k1.repoRoot).toBe("/repo");

    // Sources are marked consolidated into the new row
    const [srcRow] = await memory.getSessionFragments("session-1");
    expect(srcRow.isConsolidated).toBe(true);
    expect(srcRow.consolidatedInto).toBe(k1.id);

    // Second distillation for the same (namespace, tag) replaces, never duplicates
    const [k2] = await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", type: "pattern", summary: "auth uses JWT with RS256", confidence: 0.9, sourceFragmentIds: [], namespace: "repo" }],
      ctx,
    );
    const active = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(k2.id);

    // The replaced row keeps a supersededBy tombstone for audit
    const table = await rawTable("consolidated_v2");
    const [oldRow] = (await table.query().where(`id = '${k1.id}'`).limit(1).toArray()) as unknown as Record<string, unknown>[];
    expect(oldRow.supersededBy).toBe(k2.id);
  });

  it("tombstones rows named in an explicit supersedes list", async () => {
    const ctx = { sessionId: "s1", repoRoot: "/repo", backendType: "claude" };
    const [k1] = await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth-legacy", summary: "auth: old take", confidence: 0.5, sourceFragmentIds: [], namespace: "repo" }],
      ctx,
    );
    const [k2] = await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", summary: "auth: new take", confidence: 0.9, sourceFragmentIds: [], supersedes: [k1.id], namespace: "repo" }],
      ctx,
    );
    const legacy = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth-legacy");
    expect(legacy).toHaveLength(0); // tombstoned by k2 via supersedes
    const active = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"));
    expect(active.map((k) => k.id)).toEqual([k2.id]);
  });

  it("findRelatedKnowledge matches by centroid vector or texts at the 0.80 threshold", async () => {
    const ctx = { sessionId: "s1", repoRoot: "/repo", backendType: "claude" };
    await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", summary: "auth signing conventions", confidence: 0.8, sourceFragmentIds: [], namespace: "repo" }],
      ctx,
    );
    const ns = memory.repoNamespace("/repo");

    const hit = await memory.findRelatedKnowledge(ns, [1, 0, 0, 0]);
    expect(hit).toHaveLength(1);
    expect(hit[0].tag).toBe("auth");

    const miss = await memory.findRelatedKnowledge(ns, [0, 0, 1, 0]);
    expect(miss).toHaveLength(0);

    // Text form: embedded and averaged into a centroid
    const textHit = await memory.findRelatedKnowledge(ns, ["auth token rules"]);
    expect(textHit).toHaveLength(1);
  });

  it("concatFallbackConsolidate marks synthesisMethod 'concat' and is idempotent (§1.2 fix)", async () => {
    await memory.storeFragment(frag({ sessionId: "si", content: "auth: JWT expiry is 7d", tags: ["auth"] }));
    await memory.storeFragment(frag({ sessionId: "si", content: "auth: RS256 signing", tags: ["auth"] }));

    const first = await memory.concatFallbackConsolidate("si", "/repo");
    expect(first).toHaveLength(1);
    expect(first[0].synthesisMethod).toBe("concat");
    expect(first[0].summary).toContain('Knowledge about "auth"');

    // Second run: sources are already consolidated → nothing to do, no duplicates
    const second = await memory.concatFallbackConsolidate("si", "/repo");
    expect(second).toEqual([]);
    const active = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth");
    expect(active).toHaveLength(1);
  });
});

// ─── Enrichment entry point (§3.6.2) ─────────────────────────────────────────

describe("queryForEnrichment", () => {
  it("returns null block and no items when nothing is recalled", async () => {
    const result = await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth",
    });
    expect(result.items).toEqual([]);
    expect(result.block).toBeNull();
  });

  it("formats the §3.6.2 block exactly: header, Knowledge, Notes, footer", async () => {
    await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", type: "decision", summary: "Auth uses JWT with RS256", confidence: 0.9, sourceFragmentIds: [], namespace: "repo" }],
      { sessionId: "s1", repoRoot: "/repo", backendType: "claude" },
    );
    const f = await memory.storeFragment(
      frag({ content: "auth tokens expire after 7 days", tags: ["auth"], confidence: 0.9 }),
    );

    const result = await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth login flow",
    });

    expect(result.block).toBe(
      [
        "--- Campfire memory (auto-recalled; may be stale) ---",
        "Knowledge:",
        "- [auth] Auth uses JWT with RS256",
        "Notes:",
        "- [observation] auth tokens expire after 7 days",
        "--- end memory ---",
      ].join("\n"),
    );

    // Item list mirrors the block: knowledge ranked above fragments
    expect(result.items).toHaveLength(2);
    expect(result.items[0].kind).toBe("knowledge");
    expect(result.items[0].tag).toBe("auth");
    expect(result.items[0].weight).toBe(1); // consolidated knowledge does not decay
    expect(result.items[0].namespace).toBe(memory.repoNamespace("/repo"));
    expect(result.items[1]).toMatchObject({ id: f.id, kind: "fragment", tag: "auth" });
    expect(result.items[1].weight).toBeGreaterThan(0.99); // fresh fragment ≈ 1
  });

  it("excludes session-namespace fragments — same-session context is already in the conversation (§3.6.2)", async () => {
    // Fragment without a repoRoot lands in session:<id> and must NOT be recalled
    await memory.storeFragment(
      frag({ sessionId: "s1", gitContext: { branch: "main", files: [], repoRoot: "" }, content: "auth session-only secret" }),
    );
    const result = await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth",
    });
    expect(result.block).toBeNull();
  });

  it("reinforces exactly the included fragments (§3.2: inclusion reinforces, matching does not)", async () => {
    const f = await memory.storeFragment(frag({ content: "auth recalled note" }));
    await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth",
    });
    await memory.flushReinforcements();
    const [row] = await memory.getSessionFragments("session-1");
    expect(row.id).toBe(f.id);
    expect(row.accessCount).toBe(1);
  });

  it("enforces the context budgets: ≤ ~1200 chars of fragment text, ≤ ~2000 total, max 5 fragment lines", async () => {
    // 6 retrievable fragments of ~280 chars each — only 4 fit the 1200-char
    // fragment budget (each line ≈ 296 chars incl. the "- [observation] " prefix)
    const prefixes = ["auth", "auth database", "auth routing", "auth cache", "auth database routing", "auth database cache"];
    for (const p of prefixes) {
      const content = `${p} ${"x".repeat(280 - p.length - 1)}`;
      await memory.storeFragment(frag({ content }));
    }

    const result = await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth",
    });

    const fragmentItems = result.items.filter((i) => i.kind === "fragment");
    expect(fragmentItems.length).toBeLessThanOrEqual(4);
    expect(result.block!.length).toBeLessThanOrEqual(2000);
  });

  it("caps the total block size when knowledge alone would exceed it", async () => {
    // 10 knowledge rows × ~250-char summaries ≈ 2600 chars — must be cut to fit
    const ctx = { sessionId: "s1", repoRoot: "/repo", backendType: "claude" };
    for (let i = 0; i < 10; i++) {
      await memory.upsertKnowledgeFromDistillation(
        [{ tag: `topic-${i}`, summary: `auth ${"y".repeat(245)}`, confidence: 0.9, sourceFragmentIds: [], namespace: "repo" }],
        ctx,
      );
    }
    const result = await memory.queryForEnrichment({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
      queryText: "auth",
    });
    expect(result.block!.length).toBeLessThanOrEqual(2000);
    expect(result.items.length).toBeLessThan(10);
  });
});

// ─── Namespace overview (UI) ─────────────────────────────────────────────────

describe("getNamespaceOverview", () => {
  it("reports count, avgWeight, and pinnedCount per namespace", async () => {
    const a = await memory.storeFragment(frag({ content: "auth one" }));
    await memory.storeFragment(frag({ content: "auth database two" }));
    await memory.setFragmentPinned(a.id, true);
    await memory.storeFragment(
      frag({ sessionId: "s1", gitContext: { branch: "main", files: [], repoRoot: "" }, content: "session note" }),
    );

    const overview = await memory.getNamespaceOverview({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "claude",
    });

    const repoEntry = overview.find((o) => o.namespace === memory.repoNamespace("/repo"))!;
    expect(repoEntry.count).toBe(2);
    expect(repoEntry.pinnedCount).toBe(1);
    expect(repoEntry.avgWeight).toBeGreaterThan(0.99); // fresh rows ≈ weight 1

    const sessionEntry = overview.find((o) => o.namespace === "session:s1")!;
    expect(sessionEntry.count).toBe(1);

    const globalEntry = overview.find((o) => o.namespace === "global")!;
    expect(globalEntry.count).toBe(0);
    expect(globalEntry.avgWeight).toBe(0);
  });
});

// ─── Migration (§3.5) ────────────────────────────────────────────────────────

/** Create a v1-schema fixture database (pre-namespace, pre-lifecycle columns). */
async function createV1Fixture(dim: number) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(join(testDir, "lancedb"));
  await db.createTable("fragments", [
    {
      id: "v1-frag-repo",
      sessionId: "sess-1",
      agentId: "a1",
      backendType: "claude",
      timestamp: 1_700_000_000_000,
      type: "observation",
      content: "auth: v1 fragment with a real embedding",
      gitContextJson: JSON.stringify({ branch: "main", files: [], repoRoot: "/repo" }),
      referencesJson: "[]",
      tagsJson: JSON.stringify(["auth"]),
      confidence: 0.8,
      consolidatedInto: "",
      isConsolidated: false,
      vector: [1, ...Array(dim - 1).fill(0)] as number[],
    },
    {
      id: "v1-frag-zero",
      sessionId: "sess-1",
      agentId: "a1",
      backendType: "claude",
      timestamp: 1_700_000_100_000,
      type: "observation",
      content: "database: v1 fragment stored with a zero vector",
      gitContextJson: JSON.stringify({ branch: "main", files: [], repoRoot: "" }),
      referencesJson: "[]",
      tagsJson: JSON.stringify(["database"]),
      confidence: 0.6,
      consolidatedInto: "",
      isConsolidated: false,
      vector: Array(dim).fill(0) as number[],
    },
  ]);
  await db.createTable("consolidated", [
    {
      id: "v1-know-repo",
      tag: "auth",
      summary: "auth: v1 knowledge for /repo",
      sourceFragmentsJson: JSON.stringify(["v1-frag-repo"]),
      lastUpdated: 1_700_000_200_000,
      confidence: 0.7,
      repoRoot: "/repo",
    },
    {
      id: "v1-know-global",
      tag: "conventions",
      summary: "cross-repo v1 knowledge",
      sourceFragmentsJson: "[]",
      lastUpdated: 1_700_000_300_000,
      confidence: 0.5,
      repoRoot: "",
    },
  ]);
  return db;
}

describe("v1 → v2 migration", () => {
  it("copies rows with namespace backfill, zero-vector → pending, and retains v1 backups", async () => {
    const db = await createV1Fixture(4);

    // First API call triggers the migration
    const fragments = await memory.getSessionFragments("sess-1");
    expect(fragments).toHaveLength(2);

    const repoFrag = fragments.find((f) => f.id === "v1-frag-repo")!;
    expect(repoFrag.namespace).toBe(memory.repoNamespace("/repo")); // repoRoot → repo:<hash>
    expect(repoFrag.embeddingStatus).toBe("ok"); // real vector, matching dim
    expect(repoFrag.lastReinforcedAt).toBe(repoFrag.timestamp);
    expect(repoFrag.accessCount).toBe(0);
    expect(repoFrag.pinned).toBe(false);

    const zeroFrag = fragments.find((f) => f.id === "v1-frag-zero")!;
    expect(zeroFrag.namespace).toBe("session:sess-1"); // no repoRoot → session:<id>
    expect(zeroFrag.embeddingStatus).toBe("pending"); // §1.6: zero vector detected

    // Zero-vector rows are excluded from ANN results
    const search = await memory.queryFragments("database", { sessionId: "sess-1" });
    expect(search.find((f) => f.id === "v1-frag-zero")).toBeUndefined();
    // ...but migrated ok rows are searchable immediately
    const authHits = await memory.queryFragments("auth", { repoRoot: "/repo" });
    expect(authHits.map((f) => f.id)).toContain("v1-frag-repo");

    // Consolidated: repoRoot "" → global namespace (§1.8 fix), synthesisMethod concat
    const globalKnow = await memory.getConsolidatedKnowledge("");
    expect(globalKnow.map((k) => k.id)).toEqual(["v1-know-global"]);
    const repoKnow = await memory.getConsolidatedKnowledge("/repo");
    expect(repoKnow.map((k) => k.id)).toEqual(["v1-know-repo"]);
    expect(repoKnow[0].synthesisMethod).toBe("concat");

    // meta.json versioning + v1 backup tables retained (never opened again)
    const meta = JSON.parse(readFileSync(join(testDir, "meta.json"), "utf-8"));
    expect(meta.schemaVersion).toBe(2);
    expect(meta.dim).toBe(4);
    expect(meta.activeFragmentsTable).toBe("fragments_v2");
    const names = await db.tableNames();
    expect(names).toContain("fragments");
    expect(names).toContain("consolidated");
    expect(names).toContain("fragments_v2");
    expect(names).toContain("consolidated_v2");
  });

  it("handles a dimension change at migration time: all rows pending at the provider dim", async () => {
    // v1 store was written at dim 4, but the configured provider is 8-dim now
    await createV1Fixture(4);
    mockGetDim.mockReturnValue(8);
    mockEmbed.mockImplementation(deterministicEmbed(8));

    const fragments = await memory.getSessionFragments("sess-1");
    // Even the non-zero v1 vector can't carry over across dims → pending
    expect(fragments.every((f) => f.embeddingStatus === "pending")).toBe(true);

    const meta = JSON.parse(readFileSync(join(testDir, "meta.json"), "utf-8"));
    expect(meta.dim).toBe(8);
  });
});

describe("provider/dimension change on a live v2 store", () => {
  it("creates fragments_v2_<dim> and marks rows pending; the re-embed queue restores them", async () => {
    const f = await memory.storeFragment(frag({ content: "auth: survives provider switch" }));
    expect(f.embeddingStatus).toBe("ok");

    // Switch openai(4) → ollama(8) at runtime
    mockProviderName.mockReturnValue("ollama");
    mockGetDim.mockReturnValue(8);
    mockEmbed.mockImplementation(deterministicEmbed(8));

    // Next store access reconciles: new active table, rows pending
    const rows = await memory.getSessionFragments("session-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].embeddingStatus).toBe("pending");

    const meta = JSON.parse(readFileSync(join(testDir, "meta.json"), "utf-8"));
    expect(meta.dim).toBe(8);
    expect(meta.embeddingProvider).toBe("ollama");
    expect(meta.activeFragmentsTable).toBe("fragments_v2_8");

    // Lazy re-embed queue (≤2 req/s in production; driven manually in tests)
    const processed = await memory.processReembedBatch(10);
    expect(processed).toBeGreaterThanOrEqual(1);
    const after = await memory.getSessionFragments("session-1");
    expect(after[0].embeddingStatus).toBe("ok");

    // Re-embedded rows are searchable at the new dimension
    const hits = await memory.queryFragments("auth", { repoRoot: "/repo" });
    expect(hits.map((r) => r.id)).toContain(f.id);
  });

  it("marks rows pending in place when the provider changes at the same dimension", async () => {
    // Embeddings from different models are not comparable even at equal width
    await memory.storeFragment(frag({ content: "auth: same-dim switch" }));
    mockProviderName.mockReturnValue("custom-4dim");
    const rows = await memory.getSessionFragments("session-1");
    expect(rows[0].embeddingStatus).toBe("pending");
    const meta = JSON.parse(readFileSync(join(testDir, "meta.json"), "utf-8"));
    expect(meta.activeFragmentsTable).toBe("fragments_v2"); // no new table needed
    expect(meta.embeddingProvider).toBe("custom-4dim");
  });

  it("re-embed queue leaves rows pending when the provider keeps failing", async () => {
    mockEmbed.mockResolvedValueOnce(null); // store fails → pending
    await memory.storeFragment(frag({ content: "auth: flaky provider" }));
    mockEmbed.mockResolvedValue(null); // still down
    const processed = await memory.processReembedBatch(5);
    expect(processed).toBe(0);
    const rows = await memory.getSessionFragments("session-1");
    expect(rows[0].embeddingStatus).toBe("pending");
  });

  it("re-embed queue is a no-op with no provider configured", async () => {
    mockGetDim.mockReturnValue(null);
    mockProviderName.mockReturnValue("none");
    mockEmbed.mockResolvedValue(null);
    await memory.storeFragment(frag());
    expect(await memory.processReembedBatch(5)).toBe(0);
  });
});
