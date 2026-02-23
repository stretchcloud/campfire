/**
 * Layer 4: Shared Context Stream
 *
 * Real-time collective reasoning stream where agents and humans "think aloud"
 * into a shared space. Other agents and humans can observe, react, and build
 * on each other's thinking.
 *
 * Features:
 * - ContextFragments (thought/observation/plan/question/answer/insight/concern)
 * - Semantic linking: detects agrees_with / disagrees_with / builds_on / contradicts / questions
 * - Consensus detection: tracks which fragments are widely agreed upon vs controversial
 * - Thread support via parentId chains
 * - On session end, significant fragments promoted to SemanticMemory (not done here — done in CI orchestrator)
 *
 * Storage: In-memory per session (ephemeral).
 * Significant fragments are promoted to LanceDB SemanticMemory on session end.
 */

import { randomUUID } from "node:crypto";
import type { BackendType } from "./session-types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ContextFragmentType =
  | "thought"       // internal reasoning step
  | "observation"   // noticed something
  | "plan"          // intended next steps
  | "question"      // posed to others
  | "answer"        // response to a question
  | "insight"       // non-obvious connection
  | "concern";      // risk or issue identified

export type SemanticRelation =
  | "agrees_with"
  | "disagrees_with"
  | "builds_on"
  | "contradicts"
  | "questions";

export interface SemanticLink {
  targetFragmentId: string;
  relation: SemanticRelation;
}

export interface ContextFragment {
  fragmentId: string;
  sessionId: string;
  agentId: string;
  backendType?: BackendType;
  isHuman: boolean;
  timestamp: number;
  type: ContextFragmentType;
  content: string;
  parentId?: string;
  semanticLinks: SemanticLink[];
  consensusScore: number;   // 0–1: how widely agreed upon
  isControversial: boolean;
}

export interface DisagreementCluster {
  fragmentIds: string[];
  topic: string;
  summary: string;
}

export interface ConsensusState {
  sessionId: string;
  updatedAt: number;
  consensusPoints: string[];    // fragmentIds with high consensusScore (> 0.7)
  disagreements: DisagreementCluster[];
  openQuestions: string[];      // unanswered question fragmentIds
}

export type FragmentCallback = (fragment: ContextFragment, links: SemanticLink[]) => void;
export type ConsensusCallback = (state: ConsensusState) => void;

// ─── SharedContextStream ──────────────────────────────────────────────────────

/**
 * Per-session shared context stream.
 * Instantiated by CollectiveIntelligenceLayer, one per session.
 */
export class SharedContextStream {
  private fragments = new Map<string, ContextFragment>(); // fragmentId → fragment
  private onFragment: FragmentCallback | null = null;
  private onConsensus: ConsensusCallback | null = null;

  constructor(public readonly sessionId: string) {}

  setOnFragment(cb: FragmentCallback): void { this.onFragment = cb; }
  setOnConsensus(cb: ConsensusCallback): void { this.onConsensus = cb; }

  /**
   * Ingest a new fragment into the stream.
   * Runs semantic linking and consensus detection asynchronously.
   */
  async ingest(opts: {
    agentId: string;
    backendType?: BackendType;
    isHuman: boolean;
    type: ContextFragmentType;
    content: string;
    parentId?: string;
  }): Promise<ContextFragment> {
    const fragment: ContextFragment = {
      fragmentId: randomUUID(),
      sessionId: this.sessionId,
      agentId: opts.agentId,
      backendType: opts.backendType,
      isHuman: opts.isHuman,
      timestamp: Date.now(),
      type: opts.type,
      content: opts.content,
      parentId: opts.parentId,
      semanticLinks: [],
      consensusScore: 0.5, // neutral prior
      isControversial: false,
    };

    this.fragments.set(fragment.fragmentId, fragment);

    // Semantic linking (lightweight heuristic, non-blocking)
    const links = this.detectSemanticLinks(fragment);
    if (links.length > 0) {
      fragment.semanticLinks = links;
      // Update target fragments with back-references
      this.applyLinks(fragment.fragmentId, links);
    }

    // Consensus detection
    this.updateConsensus(fragment);

    // Emit callback (broadcast to browsers)
    this.onFragment?.(fragment, links);

    // Check if consensus state changed materially
    const state = this.getConsensusState();
    this.onConsensus?.(state);

    return fragment;
  }

  getFragment(fragmentId: string): ContextFragment | null {
    return this.fragments.get(fragmentId) ?? null;
  }

  getAllFragments(): ContextFragment[] {
    return Array.from(this.fragments.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Return a thread: the root fragment and all replies in chain order.
   */
  getThread(fragmentId: string): ContextFragment[] {
    // Find root
    let current = this.fragments.get(fragmentId);
    if (!current) return [];

    // Walk up to root
    const root = this.findRoot(fragmentId);
    // Collect all descendants
    return this.collectThread(root);
  }

  getConsensusState(): ConsensusState {
    const allFragments = Array.from(this.fragments.values());

    const consensusPoints = allFragments
      .filter((f) => f.consensusScore > 0.7)
      .map((f) => f.fragmentId);

    const controversialPairs = allFragments
      .filter((f) => f.isControversial)
      .slice(0, 10); // cap for performance

    const disagreements: DisagreementCluster[] = [];
    if (controversialPairs.length > 0) {
      // Group controversial fragments as a single cluster per topic
      const topics = new Map<string, string[]>();
      for (const f of controversialPairs) {
        const topic = this.extractTopic(f.content);
        if (!topics.has(topic)) topics.set(topic, []);
        topics.get(topic)!.push(f.fragmentId);
      }
      for (const [topic, ids] of topics) {
        disagreements.push({
          fragmentIds: ids,
          topic,
          summary: `Disagreement detected around: ${topic}`,
        });
      }
    }

    const openQuestions = allFragments
      .filter((f) => f.type === "question" && !this.hasAnswer(f.fragmentId))
      .map((f) => f.fragmentId);

    return {
      sessionId: this.sessionId,
      updatedAt: Date.now(),
      consensusPoints,
      disagreements,
      openQuestions,
    };
  }

  /**
   * Return fragments that are significant enough to promote to SemanticMemory.
   * Criteria: consensusScore > 0.6 OR type is "insight" or "decision".
   */
  getSignificantFragments(): ContextFragment[] {
    return Array.from(this.fragments.values()).filter(
      (f) => f.consensusScore > 0.6 || f.type === "insight",
    );
  }

  // ─── Internal: Semantic Linking ───────────────────────────────────────────

  private detectSemanticLinks(fragment: ContextFragment): SemanticLink[] {
    const links: SemanticLink[] = [];
    const content = fragment.content.toLowerCase();

    // Heuristic patterns for detecting semantic relations
    // In production, replace with a fast embedding similarity check or LLM call
    const recent = Array.from(this.fragments.values())
      .filter((f) => f.fragmentId !== fragment.fragmentId)
      .slice(-20); // compare against recent N fragments only (for performance)

    for (const other of recent) {
      const otherContent = other.content.toLowerCase();
      const relation = this.inferRelation(content, otherContent, fragment, other);
      if (relation) {
        links.push({ targetFragmentId: other.fragmentId, relation });
        if (links.length >= 5) break; // cap links per fragment
      }
    }

    // Thread reply: if parentId is set, always "builds_on" parent
    if (fragment.parentId && this.fragments.has(fragment.parentId)) {
      const alreadyLinked = links.some((l) => l.targetFragmentId === fragment.parentId);
      if (!alreadyLinked) {
        links.unshift({ targetFragmentId: fragment.parentId, relation: "builds_on" });
      }
    }

    return links;
  }

  private inferRelation(
    content: string,
    otherContent: string,
    fragment: ContextFragment,
    other: ContextFragment,
  ): SemanticRelation | null {
    // Agreement signals
    if (content.includes("agree") || content.includes("correct") || content.includes("exactly")) {
      if (this.topicOverlap(content, otherContent) > 0.3) return "agrees_with";
    }

    // Disagreement signals
    if (content.includes("disagree") || content.includes("wrong") || content.includes("no,") || content.includes("actually,")) {
      if (this.topicOverlap(content, otherContent) > 0.3) return "disagrees_with";
    }

    // Contradiction signals
    if (content.includes("contradict") || content.includes("opposite") || content.includes("not true")) {
      return "contradicts";
    }

    // Question about previous fragment
    if (fragment.type === "question" && other.type !== "question") {
      if (this.topicOverlap(content, otherContent) > 0.4) return "questions";
    }

    // Building on previous
    if (fragment.type === "answer" && other.type === "question") return "builds_on";
    if (fragment.type === "insight" && this.topicOverlap(content, otherContent) > 0.5) return "builds_on";

    return null;
  }

  private topicOverlap(a: string, b: string): number {
    const aWords = new Set(a.split(/\s+/).filter((w) => w.length > 4));
    const bWords = new Set(b.split(/\s+/).filter((w) => w.length > 4));
    let overlap = 0;
    for (const word of aWords) {
      if (bWords.has(word)) overlap++;
    }
    const total = Math.max(aWords.size, bWords.size);
    return total > 0 ? overlap / total : 0;
  }

  private applyLinks(sourceId: string, links: SemanticLink[]): void {
    // Update consensusScore on linked fragments based on relation type
    for (const link of links) {
      const target = this.fragments.get(link.targetFragmentId);
      if (!target) continue;

      if (link.relation === "agrees_with" || link.relation === "builds_on") {
        target.consensusScore = Math.min(1, target.consensusScore + 0.1);
      } else if (link.relation === "disagrees_with" || link.relation === "contradicts") {
        target.consensusScore = Math.max(0, target.consensusScore - 0.15);
        target.isControversial = target.consensusScore < 0.4;
      }
    }
  }

  // ─── Internal: Consensus Detection ───────────────────────────────────────

  private updateConsensus(fragment: ContextFragment): void {
    // Agreements boost consensus score; disagreements lower it
    const agreementLinks = fragment.semanticLinks.filter(
      (l) => l.relation === "agrees_with" || l.relation === "builds_on"
    ).length;
    const disagreementLinks = fragment.semanticLinks.filter(
      (l) => l.relation === "disagrees_with" || l.relation === "contradicts"
    ).length;

    fragment.consensusScore = Math.max(0, Math.min(1,
      fragment.consensusScore + agreementLinks * 0.1 - disagreementLinks * 0.15
    ));
    fragment.isControversial = fragment.consensusScore < 0.4 && disagreementLinks > 0;
  }

  private findRoot(fragmentId: string): string {
    let current = this.fragments.get(fragmentId);
    const visited = new Set<string>();
    while (current?.parentId && !visited.has(current.parentId)) {
      visited.add(current.fragmentId);
      current = this.fragments.get(current.parentId);
    }
    return current?.fragmentId ?? fragmentId;
  }

  private collectThread(rootId: string): ContextFragment[] {
    const result: ContextFragment[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const fragment = this.fragments.get(id);
      if (!fragment) continue;
      result.push(fragment);
      // Find children
      for (const f of this.fragments.values()) {
        if (f.parentId === id) queue.push(f.fragmentId);
      }
    }
    return result;
  }

  private hasAnswer(questionId: string): boolean {
    for (const f of this.fragments.values()) {
      if (f.type === "answer" && f.parentId === questionId) return true;
      if (f.semanticLinks.some((l) => l.targetFragmentId === questionId && l.relation === "builds_on")) return true;
    }
    return false;
  }

  private extractTopic(content: string): string {
    // Extract topic heuristically: longest noun phrase in first 100 chars
    const words = content.slice(0, 100).split(/\s+/);
    const meaningful = words.filter((w) => w.length > 5).slice(0, 3);
    return meaningful.join(" ") || "general";
  }
}

// ─── Manager ──────────────────────────────────────────────────────────────────

/**
 * Manages SharedContextStream instances per session.
 * One SharedContextManager per server (singleton).
 */
export class SharedContextManager {
  private streams = new Map<string, SharedContextStream>();
  private onFragment: FragmentCallback | null = null;
  private onConsensus: ConsensusCallback | null = null;

  setOnFragment(cb: FragmentCallback): void { this.onFragment = cb; }
  setOnConsensus(cb: ConsensusCallback): void { this.onConsensus = cb; }

  getOrCreate(sessionId: string): SharedContextStream {
    if (!this.streams.has(sessionId)) {
      const stream = new SharedContextStream(sessionId);
      stream.setOnFragment((f, links) => this.onFragment?.(f, links));
      stream.setOnConsensus((state) => this.onConsensus?.(state));
      this.streams.set(sessionId, stream);
    }
    return this.streams.get(sessionId)!;
  }

  get(sessionId: string): SharedContextStream | null {
    return this.streams.get(sessionId) ?? null;
  }

  remove(sessionId: string): void {
    this.streams.delete(sessionId);
  }
}

// Singleton instance
export const sharedContextManager = new SharedContextManager();
