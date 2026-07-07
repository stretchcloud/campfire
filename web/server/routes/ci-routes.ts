import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import type { BackendType } from "../session-types.js";

export function registerCiRoutes(api: Hono, deps: RouteDeps): void {
  const { wsBridge } = deps;

  /** repoRoot for a session — the namespace anchor for repo-scoped memory. */
  const sessionRepoRoot = (sessionId: string): string => {
    const session = wsBridge.getSession(sessionId);
    return session?.state.repo_root || session?.state.cwd || "";
  };

  // ─── Collective Intelligence: Semantic Memory ──────────────────────────────
  api.get("/sessions/:id/memory", async (c) => {
    const { getConsolidatedKnowledge, getSessionFragments } = await import("../semantic-memory.js");
    const sessionId = c.req.param("id");
    // §1.8 fix: consolidated knowledge lives in namespaces now. "" resolves to
    // the `global` namespace; repo-scoped rows come from repo:<hash of the
    // session cwd> — the old getConsolidatedKnowledge("") matched nothing.
    const repoRoot = sessionRepoRoot(sessionId);
    const [fragments, globalKnowledge, repoKnowledge] = await Promise.all([
      getSessionFragments(sessionId),
      getConsolidatedKnowledge(""), // global namespace
      repoRoot ? getConsolidatedKnowledge(repoRoot) : Promise.resolve([]),
    ]);
    return c.json({ fragments, consolidated: [...repoKnowledge, ...globalKnowledge] });
  });

  api.post("/sessions/:id/memory", async (c) => {
    const { storeFragment } = await import("../semantic-memory.js");
    const sessionId = c.req.param("id");
    const body = await c.req.json() as { content: string; type: string; tags?: string[]; gitContext?: Record<string, unknown> };
    if (!body.content) return c.json({ error: "content is required" }, 400);
    const fragment = await storeFragment({
      sessionId,
      agentId: "human",
      backendType: "claude",
      type: (body.type as "observation" | "hypothesis" | "decision" | "pattern") ?? "observation",
      content: body.content,
      tags: body.tags ?? [],
      gitContext: (body.gitContext as unknown as import("../semantic-memory.js").GitContext) ?? { branch: "unknown", files: [], repoRoot: "" },
    });
    return c.json({ fragment }, 201);
  });

  api.get("/sessions/:id/memory/query", async (c) => {
    const { queryFragments } = await import("../semantic-memory.js");
    const sessionId = c.req.param("id");
    const q = c.req.query("q") ?? "";
    const limit = parseInt(c.req.query("limit") ?? "10", 10);
    const results = await queryFragments(q, { sessionId, limit });
    return c.json({ results });
  });

  api.post("/sessions/:id/memory/consolidate", async (c) => {
    // §3.4 trigger 4: manual consolidation routes through the JUDGE → DISTILL
    // → CONSOLIDATE pipeline and returns its ConsolidationResult.
    const { consolidate } = await import("../memory-consolidation.js");
    const sessionId = c.req.param("id");
    const session = wsBridge.getSession(sessionId);
    const result = await consolidate({
      sessionId,
      repoRoot: sessionRepoRoot(sessionId),
      backendType: session?.backendType ?? session?.state.backend_type ?? "claude",
      reason: "manual",
    });
    return c.json(result);
  });

  api.get("/memory/global", async (c) => {
    // §1.8 fix: query the `global` namespace explicitly (v2 semantics) —
    // the old getConsolidatedKnowledge("") matched only literally-empty
    // repoRoot rows, i.e. nothing.
    const { getKnowledgeByNamespace } = await import("../semantic-memory.js");
    const tag = c.req.query("tag");
    const knowledge = await getKnowledgeByNamespace("global", tag);
    return c.json({ knowledge });
  });

  // Per-namespace fragment stats + active consolidated knowledge for the
  // memory panel. Shape is the frontend contract (api.ts MemoryOverviewResponse):
  // { namespaces: [{namespace, count, avgWeight, pinnedCount}],
  //   knowledge: [{id, tag, summary, confidence, namespace, synthesisMethod?}] }
  api.get("/sessions/:id/memory/overview", async (c) => {
    const { getNamespaceOverview, getKnowledgeByNamespace, repoNamespace } = await import("../semantic-memory.js");
    const sessionId = c.req.param("id");
    const session = wsBridge.getSession(sessionId);
    const repoRoot = sessionRepoRoot(sessionId);
    const backendType = session?.backendType ?? session?.state.backend_type ?? "claude";

    const namespaces = await getNamespaceOverview({ sessionId, repoRoot, backendType });
    const knowledgeRows = [
      ...(repoRoot ? await getKnowledgeByNamespace(repoNamespace(repoRoot)) : []),
      ...(await getKnowledgeByNamespace("global")),
    ];
    const knowledge = knowledgeRows.map((k) => ({
      id: k.id,
      tag: k.tag,
      summary: k.summary,
      confidence: k.confidence,
      namespace: k.namespace ?? "",
      synthesisMethod: k.synthesisMethod,
    }));
    return c.json({ namespaces, knowledge });
  });

  // Pin/unpin a memory fragment (§3.2: pinned rows never decay or get evicted).
  api.post("/memory/pin", async (c) => {
    const { setFragmentPinned } = await import("../semantic-memory.js");
    const body = await c.req.json() as { id?: string; pinned?: boolean };
    if (!body.id || typeof body.pinned !== "boolean") {
      return c.json({ error: "id and pinned are required" }, 400);
    }
    const ok = await setFragmentPinned(body.id, body.pinned);
    return c.json({ ok });
  });

  // ─── Collective Intelligence: Deliberation ─────────────────────────────────
  api.get("/sessions/:id/deliberations", (c) => {
    const { deliberationEngine } = require("../deliberation-engine.js") as typeof import("../deliberation-engine.js");
    const sessionId = c.req.param("id");
    const active = deliberationEngine.getActiveProposals(sessionId);
    return c.json({ active, resolved: [] });
  });

  api.get("/sessions/:id/deliberations/:proposalId", (c) => {
    const { deliberationEngine } = require("../deliberation-engine.js") as typeof import("../deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const proposal = deliberationEngine.getProposal(proposalId);
    if (!proposal) return c.json({ error: "Not found" }, 404);
    const responses = deliberationEngine.getResponses(proposalId);
    return c.json({ proposal, responses });
  });

  api.post("/sessions/:id/deliberations/:proposalId/respond", async (c) => {
    const { deliberationEngine } = await import("../deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const body = await c.req.json() as { stance: string; reasoning: string; suggestedAlternative?: string; concerns?: string[] };
    const response = deliberationEngine.addResponse({
      proposalId,
      responderId: "human",
      responderType: "human",
      timestamp: Date.now(),
      stance: body.stance as "agree" | "disagree" | "suggest_alternative" | "abstain",
      reasoning: body.reasoning,
      suggestedAlternative: body.suggestedAlternative,
      concerns: body.concerns,
    });
    if (!response) return c.json({ error: "Proposal not found or already resolved" }, 404);
    return c.json({ response });
  });

  api.post("/sessions/:id/deliberations/:proposalId/resolve", async (c) => {
    const { deliberationEngine } = await import("../deliberation-engine.js");
    const proposalId = c.req.param("proposalId");
    const resolution = deliberationEngine.resolveById(proposalId);
    if (!resolution) return c.json({ error: "Proposal not found or already resolved" }, 404);
    return c.json({ resolution });
  });

  // ─── Collective Intelligence: Capability Routing ───────────────────────────
  api.post("/sessions/route-task", async (c) => {
    const { capabilityDiscovery } = await import("../capability-discovery.js");
    const body = await c.req.json() as { taskDescription: string; availableSessions?: string[]; constraints?: Record<string, unknown> };
    if (!body.taskDescription) return c.json({ error: "taskDescription is required" }, 400);
    const available = body.availableSessions ?? wsBridge.getConnectedSessionIds();
    const result = await capabilityDiscovery.route({
      taskDescription: body.taskDescription,
      availableSessions: available,
      constraints: body.constraints as Record<string, unknown>,
    });
    return c.json(result);
  });

  api.get("/capabilities", async (c) => {
    const { capabilityDiscovery } = await import("../capability-discovery.js");
    return c.json({ sessions: capabilityDiscovery.getAllCapabilities() });
  });

  api.get("/capabilities/history", async (c) => {
    const { capabilityDiscovery } = await import("../capability-discovery.js");
    const backendType = c.req.query("backendType") as BackendType | undefined;
    const taskType = c.req.query("taskType");
    const executions = capabilityDiscovery.getExecutionHistory({ backendType, taskType });
    const total = executions.length;
    const successes = executions.filter((e) => e.outcome === "success").length;
    return c.json({ executions, successRate: total > 0 ? successes / total : 0, total });
  });

  api.post("/capabilities/feedback", async (c) => {
    const { capabilityDiscovery } = await import("../capability-discovery.js");
    const body = await c.req.json() as { sessionId: string; taskId: string; feedback: "positive" | "negative" | "neutral"; backendType?: string; taskDescription?: string };
    capabilityDiscovery.recordFeedback(body.taskId, body.sessionId, (body.backendType as BackendType) ?? "claude", body.taskDescription ?? "", body.feedback);
    return c.json({ ok: true });
  });

  // ─── Collective Intelligence: Shared Context ───────────────────────────────
  api.get("/sessions/:id/context/stream", (c) => {
    const { sharedContextManager } = require("../shared-context.js") as typeof import("../shared-context.js");
    const sessionId = c.req.param("id");
    const stream = sharedContextManager.get(sessionId);
    return c.json({ fragments: stream?.getAllFragments() ?? [] });
  });

  api.get("/sessions/:id/context/consensus", (c) => {
    const { sharedContextManager } = require("../shared-context.js") as typeof import("../shared-context.js");
    const sessionId = c.req.param("id");
    const stream = sharedContextManager.get(sessionId);
    if (!stream) return c.json({ error: "No active context stream for this session" }, 404);
    return c.json(stream.getConsensusState());
  });

  api.get("/sessions/:id/context/thread/:fragmentId", (c) => {
    const { sharedContextManager } = require("../shared-context.js") as typeof import("../shared-context.js");
    const sessionId = c.req.param("id");
    const fragmentId = c.req.param("fragmentId");
    const stream = sharedContextManager.get(sessionId);
    if (!stream) return c.json({ error: "No active context stream for this session" }, 404);
    const thread = stream.getThread(fragmentId);
    return c.json({ thread });
  });
}
