/**
 * Collective Intelligence Layer — Orchestrator
 *
 * Wires all four CI layers together and hooks into WsBridge via two interception points:
 *   1. processAgentMessage() — called for every agent → browser message
 *   2. processBrowserMessage() — called for every browser → agent message
 *
 * Integration in ws-bridge.ts (3 lines each):
 *
 *   // In handleCLIMessage / adapter message handler:
 *   if (this.collectiveIntelligence) {
 *     this.collectiveIntelligence.processAgentMessage(sessionId, browserMsg);
 *   }
 *
 *   // In routeBrowserMessage before forwarding to agent:
 *   if (this.collectiveIntelligence) {
 *     const enriched = await this.collectiveIntelligence.processBrowserMessage(sessionId, msg);
 *     if (enriched === null) return; // rerouted or blocked
 *     msg = enriched;
 *   }
 *
 * Design: non-invasive observer pattern. All processing is async and non-blocking.
 * If any CI layer throws, it logs and continues — the main chat flow is never affected.
 */

import type { BrowserIncomingMessage, BrowserOutgoingMessage, BackendType } from "./session-types.js";
import { storeFragment, queryFragments, queryForEnrichment } from "./semantic-memory.js";
import type { GitContext, MemoryType, EnrichmentResult } from "./semantic-memory.js";
import { consolidate } from "./memory-consolidation.js";
import { deliberationEngine } from "./deliberation-engine.js";
import type { DeliberationProposal, DeliberationResolution } from "./deliberation-engine.js";
import { capabilityDiscovery } from "./capability-discovery.js";
import type { AgentCapabilities, RouteTaskResult } from "./capability-discovery.js";
import { sharedContextManager } from "./shared-context.js";
import type { ContextFragment, ConsensusState } from "./shared-context.js";

// ─── Broadcast callback ───────────────────────────────────────────────────────

/** Called by WsBridge to send CI-generated messages to all browsers in a session */
type BroadcastFn = (sessionId: string, msg: BrowserIncomingMessage) => void;

// ─── Session context (enrichment / consolidation plumbing) ───────────────────

/** Minimal session context the CI layer needs for namespace-scoped memory ops. */
export interface CISessionContext {
  sessionId: string;
  repoRoot: string;
  backendType: BackendType;
}

// ─── Thinking-block scrubbing (§3.6.5) ────────────────────────────────────────

/**
 * Strip reasoning/thinking-block content from text before it is persisted to
 * semantic memory (ADR-006's scrubReasoningBlocks idea, design doc §3.6.5).
 * Removes <thinking>…</thinking> / <think>…</think> blocks (including an
 * unterminated trailing block) and collapses the leftover whitespace.
 * Raw thinking text must never reach storeFragment or shared-context
 * promotion — it is verbose, session-specific, and often speculative.
 */
export function scrubThinkingText(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Recall-biased extraction classification (§3.6.5) ─────────────────────────

/** Structural cues signalling a decision was made ("decided/instead/because"). */
const DECISION_CUE_RE =
  /\b(decided|decision|instead(?: of)?|because|chose|opted (?:for|to)|going with|settled on|we(?:'ll| will) use)\b/i;
/** Error-side cue of an error+fix pair. */
const ERROR_CUE_RE = /\b(error|exception|failed|failing|failure|crash(?:ed)?|broken|bug|traceback)\b/i;
/** Fix-side cue of an error+fix pair. */
const FIX_CUE_RE = /\b(fix(?:ed|es)?|resolved|solution|workaround|root cause|caused by|turned out)\b/i;

interface ExtractionClassification {
  type: MemoryType;
  extraTags: string[];
  confidence: number;
}

/**
 * Classify assistant text by structural cues (design doc §3.6.5). The old
 * ten-keyword *gate* is gone — extraction is deliberately recall-biased and
 * only classifies; precision comes from the consolidation JUDGE stage, and
 * decay + eviction clean up the noise.
 *
 * - decision cues → type "decision"
 * - error+fix pair → type "pattern" tagged "failure" (MemoryType has no
 *   "failure" variant; the tag lets consolidation distill it into a
 *   KnowledgeType "failure" row)
 * - everything else → plain "observation"
 */
export function classifyExtraction(content: string): ExtractionClassification {
  if (ERROR_CUE_RE.test(content) && FIX_CUE_RE.test(content)) {
    return { type: "pattern", extraTags: ["failure"], confidence: 0.7 };
  }
  if (DECISION_CUE_RE.test(content)) {
    return { type: "decision", extraTags: [], confidence: 0.7 };
  }
  return { type: "observation", extraTags: [], confidence: 0.6 };
}

// ─── CollectiveIntelligenceLayer ──────────────────────────────────────────────

export class CollectiveIntelligenceLayer {
  private broadcast: BroadcastFn | null = null;

  constructor() {
    // Wire up deliberation resolution → broadcast
    deliberationEngine.setOnResolution((resolution) => {
      // Find which session this belongs to (resolution has proposalId, not sessionId)
      // The proposal was registered with sessionId, but resolutions don't carry it.
      // We broadcast to all sessions for now — ws-bridge filters by sessionId in practice.
      // In a stricter implementation, store proposalId→sessionId mapping.
      this.broadcast?.("__all__", {
        type: "deliberation_resolved",
        resolution,
      } as BrowserIncomingMessage);
    });

    // Wire up shared context stream callbacks
    sharedContextManager.setOnFragment((fragment, links) => {
      this.broadcast?.(fragment.sessionId, {
        type: "shared_thought",
        fragment,
      } as BrowserIncomingMessage);

      for (const link of links) {
        this.broadcast?.(fragment.sessionId, {
          type: "semantic_link_added",
          sourceId: fragment.fragmentId,
          targetId: link.targetFragmentId,
          relation: link.relation,
        } as BrowserIncomingMessage);
      }
    });

    sharedContextManager.setOnConsensus((state) => {
      this.broadcast?.(state.sessionId, {
        type: "consensus_update",
        state,
      } as BrowserIncomingMessage);
    });
  }

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  // ─── Agent → Browser ────────────────────────────────────────────────────

  /**
   * Called for every message coming from an agent backend before it's sent to browsers.
   * Non-blocking: runs async side effects (memory extraction, context stream update).
   * Never delays the main message delivery.
   */
  processAgentMessage(
    sessionId: string,
    backendType: BackendType,
    msg: BrowserIncomingMessage,
    gitContext?: Partial<GitContext>,
  ): void {
    // Run all CI processing in background — never block the chat flow
    this.processAgentMessageAsync(sessionId, backendType, msg, gitContext).catch((err) => {
      console.warn("[ci] processAgentMessage error:", err);
    });
  }

  private async processAgentMessageAsync(
    sessionId: string,
    backendType: BackendType,
    msg: BrowserIncomingMessage,
    gitContext?: Partial<GitContext>,
  ): Promise<void> {
    // Layer 1: Extract memory observations from assistant messages
    if (msg.type === "assistant") {
      await this.extractMemory(sessionId, backendType, msg.message, gitContext);
    }

    // Layer 2: Handle deliberation proposals emitted by agents
    if (msg.type === "deliberation_proposal") {
      const proposal = (msg as { type: "deliberation_proposal"; proposal: DeliberationProposal }).proposal;
      deliberationEngine.register({
        ...proposal,
        sessionId,
        backendType,
      });
      // Broadcast back so all browsers see it
      this.broadcast?.(sessionId, msg);
    }

    // Layer 3: Track capability probe responses
    if (msg.type === "assistant") {
      // Check if assistant message is a probe response
      const content = this.extractTextContent(msg.message);
      if (content) {
        // Try to resolve any pending probe (the agent may be responding to a probe)
        // Probes embed their ID in the instruction, and agents include it in their response
        const probeMatch = content.match(/Capability Probe ([a-f0-9-]{36})/i);
        if (probeMatch) {
          capabilityDiscovery.resolveProbe(probeMatch[1], content);
        }
      }
    }

    // Layer 4: Feed agent thoughts to shared context stream
    if (msg.type === "stream_event") {
      const event = (msg as { type: "stream_event"; event: Record<string, unknown> }).event as Record<string, unknown>;
      // Capture Claude's thinking blocks
      if (event?.type === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "thinking" && typeof block.thinking === "string") {
          const stream = sharedContextManager.getOrCreate(sessionId);
          await stream.ingest({
            agentId: sessionId,
            backendType,
            isHuman: false,
            type: "thought",
            content: block.thinking,
          });
        }
      }
    }
  }

  // ─── Browser → Agent ────────────────────────────────────────────────────

  /**
   * Called for every browser → agent message.
   * Returns the (possibly enriched) message to forward to the agent,
   * or null if the message was consumed (rerouted or blocked).
   *
   * Enrichment: prepends relevant memory context to user_message prompts.
   */
  async processBrowserMessage(
    sessionId: string,
    msg: BrowserOutgoingMessage,
  ): Promise<BrowserOutgoingMessage | null> {
    try {
      // NOTE (§3.6.1): user_message enrichment does NOT happen here. This
      // method is fire-and-forget for consumed CI message types; enrichment
      // *transforms* the message, so WsBridge awaits enrichUserMessage()
      // explicitly (with a timeout) in its user_message routing path.

      // Layer 2: Handle human deliberation responses
      if (msg.type === "deliberation_respond") {
        const m = msg as { type: "deliberation_respond"; proposalId: string; stance: string; reasoning: string; suggestedAlternative?: string; concerns?: string[] };
        deliberationEngine.addResponse({
          proposalId: m.proposalId,
          responderId: "human",
          responderType: "human",
          timestamp: Date.now(),
          stance: m.stance as "agree" | "disagree" | "suggest_alternative" | "abstain",
          reasoning: m.reasoning,
          suggestedAlternative: m.suggestedAlternative,
          concerns: m.concerns,
        });
        return null; // consumed — no need to forward to agent
      }

      if (msg.type === "deliberation_resolve") {
        const m = msg as { type: "deliberation_resolve"; proposalId: string };
        deliberationEngine.resolveById(m.proposalId);
        return null;
      }

      // Layer 1: Manual memory query from browser
      if (msg.type === "memory_query") {
        const m = msg as { type: "memory_query"; query: string; limit?: number };
        const results = await queryFragments(m.query, { sessionId, limit: m.limit ?? 10 });
        this.broadcast?.(sessionId, {
          type: "memory_query_result",
          query: m.query,
          results,
        } as BrowserIncomingMessage);
        return null;
      }

      // Layer 1: Manual memory store from browser
      if (msg.type === "memory_store") {
        const m = msg as { type: "memory_store"; content: string; memoryType: string; tags: string[]; gitContext?: Record<string, unknown> };
        const fragment = await storeFragment({
          sessionId,
          agentId: "human",
          backendType: "claude",
          type: (m.memoryType as "observation" | "hypothesis" | "decision" | "pattern") || "observation",
          content: m.content,
          tags: m.tags,
          gitContext: (m.gitContext as unknown as GitContext) ?? { branch: "unknown", files: [], repoRoot: "" },
        });
        this.broadcast?.(sessionId, {
          type: "memory_stored",
          fragment,
        } as BrowserIncomingMessage);
        return null;
      }

      // Layer 3: Route task request
      if (msg.type === "route_task") {
        const m = msg as { type: "route_task"; taskDescription: string; availableSessions?: string[] };
        const result = await capabilityDiscovery.route({
          taskDescription: m.taskDescription,
          availableSessions: m.availableSessions ?? [],
        });
        this.broadcast?.(sessionId, {
          type: "route_result",
          result,
        } as BrowserIncomingMessage);
        return null;
      }

      // Layer 4: Human injects thought into shared context stream
      if (msg.type === "inject_thought") {
        const m = msg as { type: "inject_thought"; content: string; thoughtType: string; parentId?: string };
        const stream = sharedContextManager.getOrCreate(sessionId);
        await stream.ingest({
          agentId: "human",
          isHuman: true,
          type: m.thoughtType as "thought" | "observation" | "concern" | "question" | "answer" | "insight" | "plan",
          content: m.content,
          parentId: m.parentId,
        });
        return null;
      }
    } catch (err) {
      console.warn("[ci] processBrowserMessage error:", err);
    }

    return msg; // pass through unchanged
  }

  // ─── Prompt enrichment (§3.6.1–3.6.3) ─────────────────────────────────────

  /**
   * Enrich a user prompt with recalled memory (the fixed successor of the old
   * dead-code enrichWithMemory, §1.4). Queries namespaces
   * [repo:<hash>, agent:<backend>, global] — NOT session:<id>, since
   * same-session context is already in the agent's own conversation.
   *
   * Returns the injectable block + the item list for the UI chip.
   * Reinforcement of included rows happens INSIDE queryForEnrichment (§3.2) —
   * callers must not reinforce again. WsBridge is responsible for the timeout
   * / pass-through posture; this method just queries.
   */
  async enrichUserMessage(ctx: CISessionContext, content: string): Promise<EnrichmentResult> {
    return queryForEnrichment({
      sessionId: ctx.sessionId,
      repoRoot: ctx.repoRoot,
      backendType: ctx.backendType,
      queryText: content,
    });
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Called when a session ends. Routes consolidation through the JUDGE →
   * DISTILL → CONSOLIDATE pipeline (§3.4 trigger 3, reason "session_end")
   * and promotes significant shared context fragments to semantic memory —
   * the same semantics as before, with the concat-only consolidateSession
   * call replaced by the pipeline entry point.
   */
  async onSessionEnd(sessionId: string, backendType: BackendType, repoRoot: string): Promise<void> {
    try {
      // Consolidate episodic → semantic memory via the v2 pipeline
      await consolidate({ sessionId, repoRoot, backendType, reason: "session_end" });

      // Promote significant shared context fragments to semantic memory
      const stream = sharedContextManager.get(sessionId);
      if (stream) {
        const significant = stream.getSignificantFragments();
        for (const f of significant) {
          // §3.6.5: never persist raw thinking-block content. Agent "thought"
          // fragments are the verbatim thinking blocks ingested from
          // stream_events (processAgentMessageAsync) — exclude them from
          // promotion entirely; scrub inline <thinking> markup from the rest.
          if (f.type === "thought" && !f.isHuman) continue;
          const content = scrubThinkingText(f.content);
          if (!content) continue;
          await storeFragment({
            sessionId,
            agentId: f.agentId,
            backendType,
            type: "observation",
            content,
            gitContext: { branch: "unknown", files: [], repoRoot },
            tags: [f.type, "shared-context"],
            confidence: f.consensusScore,
          });
        }
        sharedContextManager.remove(sessionId);
      }
    } catch (err) {
      console.warn("[ci] onSessionEnd error:", err);
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async extractMemory(
    sessionId: string,
    backendType: BackendType,
    message: unknown,
    gitContext?: Partial<GitContext>,
  ): Promise<void> {
    // Recall-biased extraction (§3.6.5): the old ten-keyword gate dropped
    // anything not phrased with those exact words. Extraction now stores any
    // substantial assistant text, typed by structural cues; precision comes
    // from the consolidation JUDGE, and decay + eviction clean up the noise.
    const raw = this.extractTextContent(message);
    if (!raw) return;

    // Scrub thinking-block content BEFORE any length check or store — raw
    // reasoning must never be persisted (§3.6.5 / ADR-006 scrubReasoningBlocks).
    const content = scrubThinkingText(raw);
    if (content.length < 50) return; // too short to be meaningful

    const classification = classifyExtraction(content);
    await storeFragment({
      sessionId,
      agentId: sessionId,
      backendType,
      type: classification.type,
      content: content.slice(0, 500), // cap fragment length
      gitContext: {
        branch: gitContext?.branch ?? "unknown",
        files: gitContext?.files ?? [],
        repoRoot: gitContext?.repoRoot ?? "",
      },
      tags: [...classification.extraTags, ...this.extractTags(content)].slice(0, 5),
      confidence: classification.confidence,
    });
  }

  private extractTextContent(message: unknown): string | null {
    if (typeof message === "string") return message;
    if (!message || typeof message !== "object") return null;
    const msg = message as Record<string, unknown>;

    // Claude-style: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(msg.content)) {
      const texts = (msg.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join(" ");
      return texts || null;
    }

    if (typeof msg.content === "string") return msg.content;
    if (typeof msg.text === "string") return msg.text;
    return null;
  }

  private extractTags(content: string): string[] {
    const tags: string[] = [];
    const lower = content.toLowerCase();
    const tagKeywords: [string, string][] = [
      ["auth", "auth"], ["jwt", "auth"], ["oauth", "auth"],
      ["database", "database"], ["sql", "database"], ["postgres", "database"], ["redis", "cache"],
      ["api", "api"], ["rest", "api"], ["graphql", "api"],
      ["test", "testing"], ["spec", "testing"],
      ["route", "routing"], ["router", "routing"],
      ["config", "config"], ["env", "config"],
      ["deploy", "deployment"], ["docker", "deployment"],
      ["type", "typescript"], ["interface", "typescript"],
    ];
    const seen = new Set<string>();
    for (const [keyword, tag] of tagKeywords) {
      if (lower.includes(keyword) && !seen.has(tag)) {
        tags.push(tag);
        seen.add(tag);
      }
    }
    return tags.slice(0, 5);
  }
}

// Singleton instance — injected into WsBridge at startup
export const collectiveIntelligenceLayer = new CollectiveIntelligenceLayer();
