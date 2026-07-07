/**
 * Tests for the LLM consolidation pipeline (memory-consolidation.ts) —
 * JUDGE → DISTILL → CONSOLIDATE per docs/design/semantic-memory-v2.md §3.4.
 *
 * Isolation:
 *  - The semantic-memory store runs against a fresh temp directory per test
 *    (same mock-homedir pattern as semantic-memory.test.ts).
 *  - The embedding module is mocked with deterministic vectors, so no real
 *    OpenAI/Ollama calls happen and cluster geometry is fully controlled.
 *  - global fetch is stubbed — the OpenRouter DISTILL call NEVER hits the
 *    network; request bodies are inspected to verify the §3.4 prompt contract.
 *
 * Covered areas:
 *  1. Happy-path LLM distillation: valid JSON → knowledge upserted with
 *     synthesisMethod "llm", sources + discarded fragments marked, and the
 *     exact prompt contract (system prompt, JSON user message, temperature 0).
 *  2. existingKnowledge injection + supersedes tombstoning.
 *  3. Invalid output → ONE retry with the validator error appended → valid.
 *  4. Double failure → concat fallback (synthesisMethod "concat").
 *  5. No API key → concat immediately, no fetch, never blocked.
 *  6. Stage-1 JUDGE: low w(t)×confidence dropped, near-duplicates deduped,
 *     greedy clustering into separate distillation calls.
 *  7. In-flight guard: concurrent consolidate → { status: "in_flight" }.
 *  8. shouldConsolidateOnTurn threshold (8, named constant).
 *  9. Budget caps: >40-fragment cluster split into chunks, ≤4 calls/trigger.
 * 10. Idle trigger via the exported _checkIdleSessions test hook +
 *     stopIdleWatcher clearing all tracking.
 * 11. validateDistillationOutput unit cases (fences, unknown ids, bad enum).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock embedding module (hoisted, same harness as semantic-memory.test.ts) ─

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

import * as settingsManager from "./settings-manager.js";
import * as memory from "./semantic-memory.js";
import * as consolidation from "./memory-consolidation.js";

// ─── Deterministic embedding control ─────────────────────────────────────────

/** Per-test exact content → vector overrides (checked before the keyword fallback). */
const vectorByContent = new Map<string, number[]>();

/** Keyword fallback: "auth"→d0, "database"→d1, "routing"→d2, "cache"→d3; else zeros. */
function keywordVector(text: string): number[] {
  const v = [0, 0, 0, 0];
  if (text.toLowerCase().includes("auth")) v[0] = 1;
  if (text.toLowerCase().includes("database")) v[1] = 1;
  if (text.toLowerCase().includes("routing")) v[2] = 1;
  if (text.toLowerCase().includes("cache")) v[3] = 1;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / mag);
}

/** Unit vector at `deg` degrees in the (d0, d1) plane — for precise cluster geometry. */
function vecAt(deg: number): number[] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad), 0, 0];
}

// ─── OpenRouter fetch mock ───────────────────────────────────────────────────

const mockFetch = vi.fn();

/** Minimal OpenRouter chat-completions response whose message content is `content`. */
function openRouterReply(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const EMPTY_OUTPUT = JSON.stringify({ knowledge: [], discardedFragmentIds: [] });

/** Parsed JSON body of the i-th fetch call. */
function requestBody(i: number): {
  model: string;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
} {
  const init = mockFetch.mock.calls[i][1] as RequestInit;
  return JSON.parse(init.body as string);
}

/** Parsed §3.4 user payload (cluster + existingKnowledge) of the i-th fetch call. */
function userPayload(i: number): {
  repoRoot: string;
  cluster: Array<{ id: string; type: string; content: string; confidence: number; ageHours: number; files: string[] }>;
  existingKnowledge: Array<{ id: string; tag: string; summary: string; confidence: number }>;
} {
  return JSON.parse(requestBody(i).messages[1].content);
}

/** The EXACT §3.4 system prompt (prompt contract — must match the design doc verbatim). */
const EXPECTED_SYSTEM_PROMPT =
  "You distill working notes from an AI coding session into durable knowledge for future sessions in this repository. Output ONLY valid JSON matching the schema. Merge duplicates. Resolve contradictions by preferring later, higher-confidence notes and say what superseded what. Discard chit-chat, transient state (branch names, in-progress todo status), and anything true only for this one session. Each summary must be a standalone statement useful with zero session context, ≤ 60 words.";

// ─── Test harness ─────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `campfire-test-consolidation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  settingsManager._resetForTest(join(testDir, "settings.json"));

  vectorByContent.clear();
  mockEmbed.mockImplementation(async (text: string) => vectorByContent.get(text) ?? keywordVector(text));
  mockGetDim.mockReturnValue(4);
  mockProviderName.mockReturnValue("openai");

  memory._resetForTest(testDir);
  consolidation._resetForTest();

  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  consolidation._resetForTest();
  settingsManager._resetForTest();
  vi.unstubAllGlobals();
  rmSync(testDir, { recursive: true, force: true });
});

function setApiKey(): void {
  settingsManager.updateSettings({ openrouterApiKey: "sk-test" });
}

function ctx(reason: consolidation.ConsolidationReason = "manual"): consolidation.ConsolidationContext {
  return { sessionId: "s1", repoRoot: "/repo", backendType: "claude", reason };
}

function storeFrag(overrides: Partial<Parameters<typeof memory.storeFragment>[0]> = {}) {
  return memory.storeFragment({
    sessionId: "s1",
    agentId: "a1",
    backendType: "claude",
    type: "observation",
    content: "auth: note",
    gitContext: { branch: "main", files: ["web/server/x.ts"], repoRoot: "/repo" },
    confidence: 0.9,
    tags: ["auth"],
    ...overrides,
  });
}

// ─── 1. Happy-path LLM distillation ──────────────────────────────────────────

describe("consolidate — happy-path LLM distillation", () => {
  it("distills a cluster into knowledge, marks sources + discarded, and honors the exact prompt contract", async () => {
    // Three fragments at 0°/16°/32°: pairwise cosine ≤ 0.961 (< 0.97 — no
    // near-dup collapse) and all within 0.8 of the running centroid — a single
    // cluster, therefore a single DISTILL call.
    setApiKey();
    vectorByContent.set("auth: JWT signing uses RS256", vecAt(0));
    vectorByContent.set("auth: tokens expire after 7 days", vecAt(16));
    vectorByContent.set("chit-chat: user said hello", vecAt(32));
    const fA = await storeFrag({ content: "auth: JWT signing uses RS256", confidence: 0.9 });
    const fB = await storeFrag({ content: "auth: tokens expire after 7 days", confidence: 0.8, type: "decision" });
    const fC = await storeFrag({ content: "chit-chat: user said hello", confidence: 0.8 });

    mockFetch.mockResolvedValue(
      openRouterReply(
        JSON.stringify({
          knowledge: [
            {
              tag: "auth-tokens",
              type: "pattern",
              summary: "Auth uses RS256-signed JWTs that expire after 7 days.",
              confidence: 0.85,
              sourceFragmentIds: [fA.id, fB.id],
              namespace: "repo",
            },
          ],
          discardedFragmentIds: [fC.id],
        }),
      ),
    );

    const result = await consolidation.consolidate(ctx("manual"));

    // Result accounting: 1 knowledge row, 3 fragments (2 sources + 1 discarded)
    expect(result).toEqual({
      status: "ran",
      synthesisMethod: "llm",
      knowledgeUpserted: 1,
      fragmentsConsolidated: 3,
      reason: "manual",
    });

    // Prompt contract (§3.4): one call, temperature 0, EXACT system prompt,
    // user message is the JSON shape (repoRoot / cluster / existingKnowledge)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = requestBody(0);
    expect(body.temperature).toBe(0);
    expect(body.model).toBe("openrouter/free"); // DEFAULT_OPENROUTER_MODEL
    expect(body.messages[0]).toEqual({ role: "system", content: EXPECTED_SYSTEM_PROMPT });
    expect(body.messages[1].role).toBe("user");
    const payload = userPayload(0);
    expect(payload.repoRoot).toBe("/repo");
    expect(payload.existingKnowledge).toEqual([]);
    expect(payload.cluster.map((c) => c.id).sort()).toEqual([fA.id, fB.id, fC.id].sort());
    const clusterItem = payload.cluster.find((c) => c.id === fB.id)!;
    expect(clusterItem).toMatchObject({
      type: "decision",
      content: "auth: tokens expire after 7 days",
      confidence: 0.8,
      files: ["web/server/x.ts"],
    });
    expect(typeof clusterItem.ageHours).toBe("number");
    expect(clusterItem.ageHours).toBeGreaterThanOrEqual(0);

    // Stage 3: knowledge upserted with synthesisMethod "llm"
    const rows = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth-tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0].synthesisMethod).toBe("llm");
    expect(rows[0].type).toBe("pattern");
    expect(rows[0].sourceFragments.sort()).toEqual([fA.id, fB.id].sort());

    // Sources AND discarded fragments are all marked consolidated
    expect(await memory.getUnconsolidatedFragments("s1")).toEqual([]);
    const all = await memory.getSessionFragments("s1");
    expect(all.find((f) => f.id === fA.id)!.consolidatedInto).toBe(rows[0].id);
    expect(all.find((f) => f.id === fC.id)!.isConsolidated).toBe(true);
    expect(all.find((f) => f.id === fC.id)!.consolidatedInto).toBe("discarded");
  });

  it("feeds existingKnowledge within 0.80 of the cluster centroid and applies supersedes tombstones", async () => {
    // Pre-seed an active knowledge row whose summary embeds at d0 (contains
    // "auth") — the cluster centroid is also d0, so it must be offered to the
    // model as existingKnowledge and be supersede-able.
    setApiKey();
    const [seed] = await memory.upsertKnowledgeFromDistillation(
      [{ tag: "auth", summary: "auth: old take on tokens", confidence: 0.6, sourceFragmentIds: [], namespace: "repo" }],
      { sessionId: "seed", repoRoot: "/repo", backendType: "claude" },
    );
    const f = await storeFrag({ content: "auth: new approach to tokens", confidence: 0.9 });

    mockFetch.mockResolvedValue(
      openRouterReply(
        JSON.stringify({
          knowledge: [
            {
              tag: "auth-v2",
              type: "decision",
              summary: "Tokens now follow the new auth approach.",
              confidence: 0.9,
              sourceFragmentIds: [f.id],
              supersedes: [seed.id],
              namespace: "repo",
            },
          ],
          discardedFragmentIds: [],
        }),
      ),
    );

    await consolidation.consolidate(ctx());

    // existingKnowledge carried the seeded row (id/tag/summary/confidence shape)
    expect(userPayload(0).existingKnowledge).toEqual([
      { id: seed.id, tag: "auth", summary: "auth: old take on tokens", confidence: 0.6 },
    ]);

    // The superseded row is tombstoned; only auth-v2 remains active
    const active = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"));
    expect(active.map((k) => k.tag)).toEqual(["auth-v2"]);
  });

  it("skips when the session has no un-consolidated fragments", async () => {
    // No candidates → status "skipped", nothing else happens (no fetch)
    setApiKey();
    const result = await consolidation.consolidate({ ...ctx(), sessionId: "empty-session" });
    expect(result).toEqual({
      status: "skipped",
      synthesisMethod: "none",
      knowledgeUpserted: 0,
      fragmentsConsolidated: 0,
      reason: "manual",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── 2. Retry + fallback ladder ──────────────────────────────────────────────

describe("consolidate — validation retry and concat fallback", () => {
  it("retries ONCE with the validator error appended, then succeeds", async () => {
    // First reply is not JSON; the retry conversation must contain the raw
    // assistant output plus a user message with the validator error. The
    // second (valid) reply completes the LLM path.
    setApiKey();
    const f = await storeFrag({ content: "auth: retry me", confidence: 0.9 });
    mockFetch
      .mockResolvedValueOnce(openRouterReply("this is not json at all"))
      .mockResolvedValueOnce(
        openRouterReply(
          JSON.stringify({
            knowledge: [
              { tag: "auth-retry", type: "fact", summary: "Retry worked.", confidence: 0.7, sourceFragmentIds: [f.id], namespace: "repo" },
            ],
            discardedFragmentIds: [],
          }),
        ),
      );

    const result = await consolidation.consolidate(ctx());
    expect(result.synthesisMethod).toBe("llm");
    expect(result.knowledgeUpserted).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Retry conversation: [system, user, assistant(raw), user(validator error)]
    const retryBody = requestBody(1);
    expect(retryBody.messages).toHaveLength(4);
    expect(retryBody.messages[2]).toEqual({ role: "assistant", content: "this is not json at all" });
    expect(retryBody.messages[3].role).toBe("user");
    expect(retryBody.messages[3].content).toContain("failed validation");
    expect(retryBody.messages[3].content).toContain("not valid JSON");
  });

  it("falls back to concatFallbackConsolidate after two invalid outputs", async () => {
    // Both attempts fail schema validation → the fragments degrade to the
    // concat path (synthesisMethod "concat"), never silently lost.
    setApiKey();
    const f = await storeFrag({ content: "auth: always fails", confidence: 0.9, tags: ["auth"] });
    mockFetch
      .mockResolvedValueOnce(openRouterReply(JSON.stringify({ knowledge: "nope" })))
      .mockResolvedValueOnce(openRouterReply(JSON.stringify({ knowledge: [], discarded: "missing key" })));

    const result = await consolidation.consolidate(ctx());
    expect(mockFetch).toHaveBeenCalledTimes(2); // exactly one retry
    expect(result.status).toBe("ran");
    expect(result.synthesisMethod).toBe("concat");
    expect(result.knowledgeUpserted).toBe(1);
    expect(result.fragmentsConsolidated).toBe(1);

    const rows = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth");
    expect(rows).toHaveLength(1);
    expect(rows[0].synthesisMethod).toBe("concat");
    expect(rows[0].sourceFragments).toEqual([f.id]);
    expect(await memory.getUnconsolidatedFragments("s1")).toEqual([]);
  });

  it("goes straight to concat when no OpenRouter API key is configured — never blocked", async () => {
    // Degraded mode (§3.4): no key → no LLM call at all, concat consolidation
    // still runs and the result is status "ran" with synthesisMethod "concat".
    const f = await storeFrag({ content: "auth: no key configured", tags: ["auth"] });

    const result = await consolidation.consolidate(ctx("session_end"));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ran",
      synthesisMethod: "concat",
      knowledgeUpserted: 1,
      fragmentsConsolidated: 1,
      reason: "session_end",
    });
    const rows = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth");
    expect(rows[0].synthesisMethod).toBe("concat");
    expect(rows[0].sourceFragments).toEqual([f.id]);
  });
});

// ─── 3. Stage-1 JUDGE ────────────────────────────────────────────────────────

describe("consolidate — Stage-1 JUDGE filtering", () => {
  it("drops fragments with w(t) × confidence < 0.15 and leaves them un-consolidated", async () => {
    // Fresh fragments have w ≈ 1, so confidence 0.1 → judged 0.1 < 0.15 (dropped)
    // while confidence 0.9 survives. The dropped fragment must not reach the
    // LLM and must remain un-consolidated (decay/eviction owns it, not us).
    setApiKey();
    const kept = await storeFrag({ content: "auth: strong signal", confidence: 0.9 });
    const dropped = await storeFrag({ content: "auth low: weak signal", confidence: 0.1 });

    mockFetch.mockResolvedValue(
      openRouterReply(
        JSON.stringify({
          knowledge: [
            { tag: "auth-signal", type: "fact", summary: "Strong auth signal.", confidence: 0.9, sourceFragmentIds: [kept.id], namespace: "repo" },
          ],
          discardedFragmentIds: [],
        }),
      ),
    );

    await consolidation.consolidate(ctx());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(userPayload(0).cluster.map((c) => c.id)).toEqual([kept.id]);

    const remaining = await memory.getUnconsolidatedFragments("s1");
    expect(remaining.map((f) => f.id)).toEqual([dropped.id]);
  });

  it("dedupes near-duplicates within the batch (cosine > 0.97), keeping the higher-scored one", async () => {
    // Both contents contain only "auth" → identical unit vectors (cosine 1).
    // The confidence-0.9 twin wins; only one fragment reaches the LLM.
    setApiKey();
    await storeFrag({ content: "auth: duplicated insight A", confidence: 0.5 });
    const winner = await storeFrag({ content: "auth: duplicated insight B", confidence: 0.9 });

    mockFetch.mockResolvedValue(
      openRouterReply(
        JSON.stringify({
          knowledge: [
            { tag: "auth-dedupe", type: "fact", summary: "One insight.", confidence: 0.9, sourceFragmentIds: [winner.id], namespace: "repo" },
          ],
          discardedFragmentIds: [],
        }),
      ),
    );

    await consolidation.consolidate(ctx());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const cluster = userPayload(0).cluster;
    expect(cluster).toHaveLength(1);
    expect(cluster[0].id).toBe(winner.id);
    expect(cluster[0].content).toBe("auth: duplicated insight B");
  });

  it("clusters greedily at 0.80 — orthogonal topics get separate distillation calls", async () => {
    // "auth" (d0) vs "database" (d1) have cosine 0 < 0.80 → two clusters →
    // two OpenRouter calls, each carrying exactly one fragment.
    setApiKey();
    const a = await storeFrag({ content: "auth: token flow", confidence: 0.9 });
    const b = await storeFrag({ content: "database: pooling strategy", confidence: 0.9 });
    mockFetch.mockResolvedValue(openRouterReply(EMPTY_OUTPUT));

    await consolidation.consolidate(ctx());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const clusters = [userPayload(0).cluster, userPayload(1).cluster];
    expect(clusters[0]).toHaveLength(1);
    expect(clusters[1]).toHaveLength(1);
    const ids = clusters.flat().map((c) => c.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

// ─── 4. In-flight guard ──────────────────────────────────────────────────────

describe("consolidate — in-flight guard", () => {
  it("returns { status: 'in_flight' } for a concurrent call on the same session", async () => {
    // The guard is set synchronously at entry, so a second call issued before
    // the first resolves must short-circuit without touching the store or LLM.
    setApiKey();
    await storeFrag({ content: "auth: pending guard", confidence: 0.9 });
    mockFetch.mockResolvedValue(openRouterReply(EMPTY_OUTPUT));

    const first = consolidation.consolidate(ctx("manual")); // not awaited yet
    const second = await consolidation.consolidate(ctx("turn_boundary"));
    expect(second).toEqual({
      status: "in_flight",
      synthesisMethod: "none",
      knowledgeUpserted: 0,
      fragmentsConsolidated: 0,
      reason: "turn_boundary",
    });

    const firstResult = await first;
    expect(firstResult.status).toBe("ran");

    // Guard is released after completion — a follow-up call runs normally
    const third = await consolidation.consolidate(ctx("manual"));
    expect(third.status).not.toBe("in_flight");
  });
});

// ─── 5. Turn-boundary trigger threshold ──────────────────────────────────────

describe("shouldConsolidateOnTurn", () => {
  it("fires only at ≥ 8 un-consolidated fragments (TURN_CONSOLIDATION_THRESHOLD)", async () => {
    expect(consolidation.TURN_CONSOLIDATION_THRESHOLD).toBe(8);

    for (let i = 0; i < 7; i++) {
      await storeFrag({ sessionId: "st", content: `note ${i} for the turn trigger` });
    }
    expect(await consolidation.shouldConsolidateOnTurn("st")).toBe(false);

    await storeFrag({ sessionId: "st", content: "note 7 for the turn trigger" });
    expect(await consolidation.shouldConsolidateOnTurn("st")).toBe(true);
  });

  it("does not count fragments that are already consolidated", async () => {
    for (let i = 0; i < 8; i++) {
      await storeFrag({ sessionId: "sc", content: `consolidated note ${i}` });
    }
    const fragments = await memory.getUnconsolidatedFragments("sc");
    await memory.markFragmentsConsolidated(fragments.map((f) => f.id), "k-1");
    expect(await consolidation.shouldConsolidateOnTurn("sc")).toBe(false);
  });
});

// ─── 6. Budget caps ──────────────────────────────────────────────────────────

describe("consolidate — budgets (§3.4)", () => {
  it("splits a >40-fragment cluster into ≤40-fragment calls", async () => {
    // Provider "none": fragments carry no embeddings, so the no-embedding
    // fallback makes ONE cluster of 50 — which must be chunked into 40 + 10.
    mockGetDim.mockReturnValue(null);
    mockProviderName.mockReturnValue("none");
    mockEmbed.mockResolvedValue(null);
    setApiKey();

    for (let i = 0; i < 50; i++) {
      await storeFrag({ content: `note ${i} about the system`, confidence: 0.7 });
    }
    mockFetch.mockResolvedValue(openRouterReply(EMPTY_OUTPUT));

    const result = await consolidation.consolidate(ctx());
    expect(result.status).toBe("ran");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(userPayload(0).cluster).toHaveLength(40);
    expect(userPayload(1).cluster).toHaveLength(10);
  });

  it("caps a trigger at 4 distillation calls; extra clusters wait for the next trigger", async () => {
    // Five mutually-orthogonal fragments (4 keyword axes + one zero vector)
    // form five singleton clusters — only MAX_CALLS_PER_TRIGGER (4) may call.
    setApiKey();
    expect(consolidation.MAX_CALLS_PER_TRIGGER).toBe(4);
    await storeFrag({ content: "auth alpha", confidence: 0.9 });
    await storeFrag({ content: "database beta", confidence: 0.9 });
    await storeFrag({ content: "routing gamma", confidence: 0.9 });
    await storeFrag({ content: "cache delta", confidence: 0.9 });
    await storeFrag({ content: "plain misc note", confidence: 0.9 });
    mockFetch.mockResolvedValue(openRouterReply(EMPTY_OUTPUT));

    const result = await consolidation.consolidate(ctx());
    expect(result.status).toBe("ran");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ─── 7. Idle trigger ─────────────────────────────────────────────────────────

describe("idle trigger (noteSessionActivity / _checkIdleSessions / stopIdleWatcher)", () => {
  it("consolidates a session idle > 30 min with un-consolidated fragments (reason 'idle')", async () => {
    // No API key → the idle-triggered consolidation takes the concat path,
    // which is observable via the knowledge table and cleared fragments.
    await storeFrag({ sessionId: "sid", content: "auth: idle note one", tags: ["auth"] });
    await storeFrag({ sessionId: "sid", content: "auth idle: note two", tags: ["auth"] });
    consolidation.noteSessionActivity({ sessionId: "sid", repoRoot: "/repo", backendType: "claude" });

    await consolidation._checkIdleSessions(Date.now() + consolidation.IDLE_TRIGGER_MS + 60_000);

    expect(await memory.getUnconsolidatedFragments("sid")).toEqual([]);
    const rows = await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"), "auth");
    expect(rows).toHaveLength(1);
    expect(rows[0].synthesisMethod).toBe("concat");
  });

  it("does nothing while the session is within the 30-minute window", async () => {
    await storeFrag({ sessionId: "sid", content: "auth: still active" });
    consolidation.noteSessionActivity({ sessionId: "sid", repoRoot: "/repo", backendType: "claude" });

    await consolidation._checkIdleSessions(Date.now() + 5 * 60_000);
    expect((await memory.getUnconsolidatedFragments("sid")).length).toBe(1);

    // Still tracked: crossing the threshold later does fire
    await consolidation._checkIdleSessions(Date.now() + consolidation.IDLE_TRIGGER_MS + 60_000);
    expect(await memory.getUnconsolidatedFragments("sid")).toEqual([]);
  });

  it("skips idle sessions that have nothing un-consolidated", async () => {
    consolidation.noteSessionActivity({ sessionId: "empty-sess", repoRoot: "/repo", backendType: "claude" });
    await consolidation._checkIdleSessions(Date.now() + consolidation.IDLE_TRIGGER_MS + 60_000);
    expect(await memory.getKnowledgeByNamespace(memory.repoNamespace("/repo"))).toEqual([]);
  });

  it("stopIdleWatcher clears all idle tracking (tests / shutdown)", async () => {
    await storeFrag({ sessionId: "sid", content: "auth: never idle-consolidated" });
    consolidation.noteSessionActivity({ sessionId: "sid", repoRoot: "/repo", backendType: "claude" });
    consolidation.stopIdleWatcher();

    await consolidation._checkIdleSessions(Date.now() + consolidation.IDLE_TRIGGER_MS + 60_000);
    expect((await memory.getUnconsolidatedFragments("sid")).length).toBe(1);
  });
});

// ─── 8. Output validator unit cases ──────────────────────────────────────────

describe("validateDistillationOutput", () => {
  const clusterIds = new Set(["frag-1", "frag-2"]);
  const existingIds = new Set(["know-1"]);
  const validItem = {
    tag: "auth-tokens",
    type: "pattern",
    summary: "A durable statement.",
    confidence: 0.8,
    sourceFragmentIds: ["frag-1"],
    namespace: "repo",
  };

  it("accepts a valid payload wrapped in a markdown code fence", () => {
    // Models routinely wrap JSON in ``` fences — stripping them is tolerated;
    // everything inside is still validated strictly.
    const raw = "```json\n" + JSON.stringify({ knowledge: [validItem], discardedFragmentIds: ["frag-2"] }) + "\n```";
    const result = consolidation.validateDistillationOutput(raw, clusterIds, existingIds);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.knowledge[0].tag).toBe("auth-tokens");
      expect(result.value.discardedFragmentIds).toEqual(["frag-2"]);
    }
  });

  it("rejects sourceFragmentIds that are not from the input cluster", () => {
    const raw = JSON.stringify({
      knowledge: [{ ...validItem, sourceFragmentIds: ["frag-999"] }],
      discardedFragmentIds: [],
    });
    const result = consolidation.validateDistillationOutput(raw, clusterIds, existingIds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("frag-999");
  });

  it("rejects supersedes ids that were not offered as existingKnowledge", () => {
    const raw = JSON.stringify({
      knowledge: [{ ...validItem, supersedes: ["know-999"] }],
      discardedFragmentIds: [],
    });
    const result = consolidation.validateDistillationOutput(raw, clusterIds, existingIds);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("know-999");
  });

  it("rejects invalid enum values (type, namespace) and non-kebab tags", () => {
    for (const bad of [
      { ...validItem, type: "musing" },
      { ...validItem, namespace: "session" },
      { ...validItem, tag: "Not Kebab Case" },
      { ...validItem, confidence: 1.5 },
    ]) {
      const result = consolidation.validateDistillationOutput(
        JSON.stringify({ knowledge: [bad], discardedFragmentIds: [] }),
        clusterIds,
        existingIds,
      );
      expect(result.ok).toBe(false);
    }
  });
});
