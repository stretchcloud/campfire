/**
 * Tests for the semantic-memory REST endpoints in ci-routes.ts.
 *
 * Covers the semantic-memory v2 wiring (design doc §1.8 + §3.4):
 *  - GET  /sessions/:id/memory            — §1.8 fix: consolidated knowledge
 *    comes from the global namespace PLUS repo:<hash of the session cwd>;
 *    the old getConsolidatedKnowledge("") matched nothing.
 *  - GET  /memory/global                  — §1.8 fix: explicit global namespace.
 *  - GET  /sessions/:id/memory/overview   — frontend contract (MemoryOverviewResponse).
 *  - POST /memory/pin                     — frontend contract ({ ok: boolean }).
 *  - POST /sessions/:id/memory/consolidate — §3.4 trigger 4 (manual) routes
 *    through the consolidation pipeline and returns its ConsolidationResult.
 *
 * semantic-memory and memory-consolidation are mocked: these tests assert the
 * route wiring and response shapes, not LanceDB/pipeline behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerCiRoutes } from "./ci-routes.js";
import * as semanticMemory from "../semantic-memory.js";
import * as memoryConsolidation from "../memory-consolidation.js";

vi.mock("../semantic-memory.js", () => ({
  getSessionFragments: vi.fn(async () => [{ id: "frag-1", content: "session fragment" }]),
  // v2 semantics: "" resolves to the global namespace, a path to repo:<hash>
  getConsolidatedKnowledge: vi.fn(async (repoRoot: string) =>
    repoRoot === ""
      ? [{ id: "k-global", tag: "conventions", summary: "global knowledge", confidence: 0.8, repoRoot: "", namespace: "global" }]
      : [{ id: "k-repo", tag: "arch", summary: "repo knowledge", confidence: 0.9, repoRoot, namespace: `repo:hash-${repoRoot}` }],
  ),
  getKnowledgeByNamespace: vi.fn(async (namespace: string) => [
    {
      id: `k-${namespace}`,
      tag: "arch",
      summary: `knowledge in ${namespace}`,
      confidence: 0.9,
      repoRoot: "/repo",
      namespace,
      synthesisMethod: "llm",
      sourceFragments: [],
      lastUpdated: 1,
    },
  ]),
  getNamespaceOverview: vi.fn(async () => [
    { namespace: "session:s1", count: 3, avgWeight: 0.7, pinnedCount: 0 },
    { namespace: "global", count: 10, avgWeight: 0.5, pinnedCount: 2 },
  ]),
  setFragmentPinned: vi.fn(async () => true),
  repoNamespace: vi.fn((repoRoot: string) => `repo:hash-${repoRoot}`),
  storeFragment: vi.fn(async (opts: Record<string, unknown>) => ({ id: "frag-new", ...opts })),
  queryFragments: vi.fn(async () => []),
  consolidateSession: vi.fn(async () => []),
}));

vi.mock("../memory-consolidation.js", () => ({
  consolidate: vi.fn(async (ctx: { reason: string }) => ({
    status: "ran",
    synthesisMethod: "llm",
    knowledgeUpserted: 2,
    fragmentsConsolidated: 5,
    reason: ctx.reason,
  })),
  shouldConsolidateOnTurn: vi.fn(async () => false),
  noteSessionActivity: vi.fn(),
  stopIdleWatcher: vi.fn(),
}));

// ─── Test setup ──────────────────────────────────────────────────────────────

let app: Hono;
let getSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // clearAllMocks resets call history only — the factory implementations
  // above survive, so every test starts from the same store behavior.
  vi.clearAllMocks();
  getSession = vi.fn(() => ({
    id: "s1",
    backendType: "codex",
    state: { cwd: "/repo", repo_root: "/repo", backend_type: "codex" },
  }));
  app = new Hono();
  registerCiRoutes(app, { wsBridge: { getSession, getConnectedSessionIds: vi.fn(() => []) } } as any);
});

// ─── GET /sessions/:id/memory ────────────────────────────────────────────────

describe("GET /sessions/:id/memory", () => {
  it("returns session fragments plus consolidated knowledge from repo AND global namespaces", async () => {
    // §1.8 fix: the old handler called getConsolidatedKnowledge("") which
    // matched only literally-empty repoRoot rows (nothing). It must now merge
    // repo-scoped knowledge (repo:<hash of session cwd>) with global.
    const res = await app.request("/sessions/s1/memory");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fragments).toEqual([{ id: "frag-1", content: "session fragment" }]);
    // Repo knowledge ranked before global
    expect(json.consolidated.map((k: { id: string }) => k.id)).toEqual(["k-repo", "k-global"]);
    expect(semanticMemory.getConsolidatedKnowledge).toHaveBeenCalledWith("");
    expect(semanticMemory.getConsolidatedKnowledge).toHaveBeenCalledWith("/repo");
  });

  it("falls back to global-only knowledge when the session (and its cwd) is unknown", async () => {
    getSession.mockReturnValue(null);

    const res = await app.request("/sessions/ghost/memory");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.consolidated.map((k: { id: string }) => k.id)).toEqual(["k-global"]);
    // No repo-scoped lookup without a repoRoot
    expect(semanticMemory.getConsolidatedKnowledge).toHaveBeenCalledTimes(1);
    expect(semanticMemory.getConsolidatedKnowledge).toHaveBeenCalledWith("");
  });
});

// ─── GET /memory/global ──────────────────────────────────────────────────────

describe("GET /memory/global", () => {
  it("queries the global namespace explicitly (v2 semantics), passing the tag filter", async () => {
    const res = await app.request("/memory/global?tag=arch");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.knowledge).toHaveLength(1);
    expect(json.knowledge[0].namespace).toBe("global");
    expect(semanticMemory.getKnowledgeByNamespace).toHaveBeenCalledWith("global", "arch");
  });
});

// ─── GET /sessions/:id/memory/overview ───────────────────────────────────────

describe("GET /sessions/:id/memory/overview", () => {
  it("returns the frontend MemoryOverviewResponse shape (namespaces + knowledge)", async () => {
    const res = await app.request("/sessions/s1/memory/overview");

    expect(res.status).toBe(200);
    const json = await res.json();

    // namespaces come straight from getNamespaceOverview, called with the
    // session context (repoRoot + backendType plumbing, §3.6 item 5)
    expect(json.namespaces).toEqual([
      { namespace: "session:s1", count: 3, avgWeight: 0.7, pinnedCount: 0 },
      { namespace: "global", count: 10, avgWeight: 0.5, pinnedCount: 2 },
    ]);
    expect(semanticMemory.getNamespaceOverview).toHaveBeenCalledWith({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "codex",
    });

    // knowledge is mapped to the exact frontend contract fields — repo
    // namespace first, then global
    expect(json.knowledge).toEqual([
      {
        id: "k-repo:hash-/repo",
        tag: "arch",
        summary: "knowledge in repo:hash-/repo",
        confidence: 0.9,
        namespace: "repo:hash-/repo",
        synthesisMethod: "llm",
      },
      {
        id: "k-global",
        tag: "arch",
        summary: "knowledge in global",
        confidence: 0.9,
        namespace: "global",
        synthesisMethod: "llm",
      },
    ]);
  });

  it("skips the repo namespace when the session has no cwd", async () => {
    getSession.mockReturnValue({ id: "s1", backendType: "claude", state: { cwd: "", repo_root: "" } });

    const res = await app.request("/sessions/s1/memory/overview");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.knowledge.map((k: { namespace: string }) => k.namespace)).toEqual(["global"]);
    expect(semanticMemory.getKnowledgeByNamespace).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /memory/pin ────────────────────────────────────────────────────────

describe("POST /memory/pin", () => {
  it("pins a fragment and returns { ok: true }", async () => {
    const res = await app.request("/memory/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "frag-1", pinned: true }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(semanticMemory.setFragmentPinned).toHaveBeenCalledWith("frag-1", true);
  });

  it("unpins a fragment (pinned: false is a valid body, not a missing field)", async () => {
    const res = await app.request("/memory/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "frag-1", pinned: false }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(semanticMemory.setFragmentPinned).toHaveBeenCalledWith("frag-1", false);
  });

  it("returns ok: false when the fragment does not exist", async () => {
    vi.mocked(semanticMemory.setFragmentPinned).mockResolvedValueOnce(false);

    const res = await app.request("/memory/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ghost", pinned: true }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false });
  });

  it("rejects requests missing id or pinned with 400", async () => {
    for (const body of [{}, { id: "frag-1" }, { pinned: true }, { id: "frag-1", pinned: "yes" }]) {
      const res = await app.request("/memory/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(semanticMemory.setFragmentPinned).not.toHaveBeenCalled();
  });
});

// ─── POST /sessions/:id/memory/consolidate ───────────────────────────────────

describe("POST /sessions/:id/memory/consolidate", () => {
  it("routes through consolidate({ reason: 'manual' }) and returns its ConsolidationResult", async () => {
    const res = await app.request("/sessions/s1/memory/consolidate", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: "ran",
      synthesisMethod: "llm",
      knowledgeUpserted: 2,
      fragmentsConsolidated: 5,
      reason: "manual",
    });
    expect(memoryConsolidation.consolidate).toHaveBeenCalledWith({
      sessionId: "s1",
      repoRoot: "/repo",
      backendType: "codex",
      reason: "manual",
    });
  });

  it("defaults backendType to claude and repoRoot to '' for unknown sessions", async () => {
    getSession.mockReturnValue(null);

    const res = await app.request("/sessions/ghost/memory/consolidate", { method: "POST" });

    expect(res.status).toBe(200);
    expect(memoryConsolidation.consolidate).toHaveBeenCalledWith({
      sessionId: "ghost",
      repoRoot: "",
      backendType: "claude",
      reason: "manual",
    });
  });
});
