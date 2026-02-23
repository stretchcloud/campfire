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
import { storeFragment, queryFragments, consolidateSession, getConsolidatedKnowledge } from "./semantic-memory.js";
import type { MemoryFragment, ConsolidatedKnowledge, GitContext } from "./semantic-memory.js";
import { deliberationEngine } from "./deliberation-engine.js";
import type { DeliberationProposal, DeliberationResolution } from "./deliberation-engine.js";
import { capabilityDiscovery } from "./capability-discovery.js";
import type { AgentCapabilities, RouteTaskResult } from "./capability-discovery.js";
import { sharedContextManager } from "./shared-context.js";
import type { ContextFragment, ConsensusState } from "./shared-context.js";

// ─── Broadcast callback ───────────────────────────────────────────────────────

/** Called by WsBridge to send CI-generated messages to all browsers in a session */
type BroadcastFn = (sessionId: string, msg: BrowserIncomingMessage) => void;

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
      // Layer 1: Enrich user prompts with semantic memory context
      if (msg.type === "user_message") {
        return await this.enrichWithMemory(sessionId, msg);
      }

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

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Called when a session ends. Consolidates memory and promotes significant
   * shared context fragments to semantic memory.
   */
  async onSessionEnd(sessionId: string, backendType: BackendType, repoRoot: string): Promise<void> {
    try {
      // Consolidate episodic → semantic memory
      await consolidateSession(sessionId, repoRoot);

      // Promote significant shared context fragments to semantic memory
      const stream = sharedContextManager.get(sessionId);
      if (stream) {
        const significant = stream.getSignificantFragments();
        for (const f of significant) {
          await storeFragment({
            sessionId,
            agentId: f.agentId,
            backendType,
            type: "observation",
            content: f.content,
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

  private async enrichWithMemory(
    sessionId: string,
    msg: BrowserOutgoingMessage & { type: "user_message" },
  ): Promise<BrowserOutgoingMessage> {
    const memories = await queryFragments(msg.content, { sessionId, limit: 5 });
    if (memories.length === 0) return msg;

    const context = this.formatMemoryContext(memories);
    return { ...msg, content: `${context}\n\n${msg.content}` };
  }

  private formatMemoryContext(memories: MemoryFragment[]): string {
    const lines = memories
      .slice(0, 5)
      .map((m) => `[Memory/${m.type}] ${m.content}${m.gitContext.files.length > 0 ? ` (${m.gitContext.files.slice(0, 2).join(", ")})` : ""}`)
      .join("\n");
    return `--- Relevant Context from Previous Sessions ---\n${lines}\n---`;
  }

  private async extractMemory(
    sessionId: string,
    backendType: BackendType,
    message: unknown,
    gitContext?: Partial<GitContext>,
  ): Promise<void> {
    // Extract meaningful observations from assistant messages.
    // We look for tool results (Read/Write/Edit/Bash) which are rich in codebase knowledge.
    const content = this.extractTextContent(message);
    if (!content || content.length < 50) return; // too short to be meaningful

    // Heuristic: only store if content looks like codebase knowledge
    const keywords = ["function", "class", "interface", "module", "import", "export", "config", "pattern", "architecture", "convention"];
    const hasKeyword = keywords.some((k) => content.toLowerCase().includes(k));
    if (!hasKeyword) return;

    await storeFragment({
      sessionId,
      agentId: sessionId,
      backendType,
      type: "observation",
      content: content.slice(0, 500), // cap fragment length
      gitContext: {
        branch: gitContext?.branch ?? "unknown",
        files: gitContext?.files ?? [],
        repoRoot: gitContext?.repoRoot ?? "",
      },
      tags: this.extractTags(content),
      confidence: 0.6,
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
