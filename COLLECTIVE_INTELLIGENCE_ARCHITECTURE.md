# Collective Intelligence Architecture
## Data Flow, API Design & System Architecture

**Date**: 2026-02-16
**Based on**: COLLECTIVE_INTELLIGENCE_RESEARCH.md
**Scope**: Full technical architecture for implementing shared cognition across Campfire's multi-agent backends.

---

## Overview

This document translates the research findings from `COLLECTIVE_INTELLIGENCE_RESEARCH.md` into a concrete, implementable architecture. The system is built in four layers on top of Campfire's existing infrastructure:

1. **Semantic Memory Layer** — persistent knowledge that survives sessions
2. **Deliberation Protocol** — structured debate before agents act
3. **Capability Discovery & Routing** — intelligent task assignment
4. **Shared Context Stream** — real-time collective reasoning

---

## System Context

### What Already Exists

```
Browser (React 19) ←→ WebSocket ←→ Hono/Bun Server ←→ Agent Backends
     :5174              /ws/browser/:id    :3456       (Claude/Codex/Goose/Aider/OpenHands/OpenCode)
```

- **`WsBridge`** — routes messages between agent backends and browser clients, per-session
- **`CliLauncher`** — spawns agent subprocesses (Claude, Codex, Goose, OpenCode, etc.)
- **`SessionStore`** — debounced JSON persistence (`$TMPDIR/vibe-sessions/`)
- **`RecorderManager`** — JSONL capture of raw protocol messages (`~/.companion/recordings/`)
- **`session-types.ts`** — `BrowserIncomingMessage` / `BrowserOutgoingMessage` — the stable browser protocol contract
- **Permission voting** — `majority-rules` | `any-deny-blocks` | `owner-decides`

### What Needs to Be Added

```
Browser ←→ Collective Intelligence Layer ←→ Semantic Memory / Deliberation Engine
              (new message types + routing)      (new persistence + computation)
```

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                         Browser (React 19)                         │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────────┐   │
│  │ ChatView │  │MemoryPanel   │  │  CollectiveMindPanel       │   │
│  │ ToolBlock│  │(graph viz)   │  │  (shared thought stream)   │   │
│  └──────────┘  └──────────────┘  └────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              DeliberationCard (proposal → response → vote)   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ WebSocket /ws/browser/:id
┌──────────────────────────────▼─────────────────────────────────────┐
│                     Hono + Bun Server (:3456)                       │
│                                                                     │
│  ┌──────────────┐   ┌───────────────────────────────────────────┐  │
│  │  WsBridge    │   │  Collective Intelligence Layer (NEW)       │  │
│  │  (existing)  │◄──┤                                           │  │
│  └──────┬───────┘   │  SemanticMemory  CapabilityRouter         │  │
│         │           │  DeliberationEngine  SharedContextStream  │  │
│         │           └───────────────────────────────────────────┘  │
│         │                      │                                    │
│         │           ┌──────────▼──────────┐                        │
│         │           │   Persistence Layer  │                        │
│         │           │  ~/.companion/memory/│                        │
│         │           │  ~/.companion/       │                        │
│         │           │   capability-learning│                        │
│         │           └─────────────────────┘                        │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ stdio JSON-RPC / NDJSON WebSocket
┌──────────────────────────────▼─────────────────────────────────────┐
│                        Agent Backends                               │
│  Claude Code  │  Codex  │  Goose  │  OpenCode  │  OpenHands  │...  │
└────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Semantic Memory

### Purpose

Give agents a persistent, shared knowledge base anchored to the git repository. When one agent discovers that "the auth module uses JWT with a 7-day expiry", that knowledge is stored and retrievable by all agents in future sessions.

### Data Model

```typescript
// web/server/semantic-memory.ts

interface MemoryFragment {
  id: string;                       // UUID
  sessionId: string;                // Campfire session that produced this
  agentId: string;                  // which backend instance wrote it
  backendType: BackendType;         // "claude" | "codex" | "goose" | "opencode" | ...
  timestamp: number;                // Unix ms

  type: "observation"               // agent noticed something about the codebase
      | "hypothesis"                // agent's unverified belief
      | "decision"                  // a choice was made (and why)
      | "pattern";                  // recurring structure identified

  content: string;                  // human-readable text

  gitContext: {
    commitHash?: string;            // snapshot this was true at
    branch: string;
    files: string[];                // files this memory relates to
    repoRoot: string;
  };

  references: string[];             // IDs of related MemoryFragments
  confidence: number;               // 0.0–1.0
  tags: string[];                   // semantic tags for retrieval ("auth", "jwt", "security")

  consolidatedInto?: string;        // ID of a semantic (consolidated) fragment
  isConsolidated: boolean;          // true = episodic → semantic already happened
}

interface ConsolidatedKnowledge {
  id: string;
  tag: string;                      // primary semantic category
  summary: string;                  // synthesized knowledge
  sourceFragments: string[];        // IDs of episodic fragments this came from
  lastUpdated: number;
  confidence: number;               // weighted average of source fragments
}
```

### Storage: LanceDB

Semantic memory is stored in **LanceDB** — an embedded, TypeScript-native vector database with no separate server process. This is the same stack used by [Continue.dev](https://blog.continue.dev/building-a-semantic-code-history-search-with-lancedb/) for local codebase indexing.

**Why LanceDB over plain files:**
- Vector similarity search is native — no brute-force scan needed
- HNSW indexing available when fragment count grows large
- Hybrid queries: vector similarity + SQL-style metadata filtering in one call
- Fully embedded — files live on disk in `~/.companion/memory/`, no daemon
- TypeScript SDK: `bun add @lancedb/lancedb`
- Versioned columnar format (Lance) — inspectable, no migration locks

**Embedding pipeline:**
Each `MemoryFragment` is embedded at write time. Two options, configurable in settings:
- **OpenAI** `text-embedding-3-small` (1,536 dims) — fast, cheap (~$0.02/1M tokens), requires API key
- **Ollama** `nomic-embed-text` (768 dims) — fully offline, no API key, outperforms ada-002

```typescript
// Embedding generated at write time, stored as Float32 column in LanceDB
embedding: number[];   // 1536-dim (OpenAI) or 768-dim (Ollama)
```

**LanceDB table schema (maps 1:1 to MemoryFragment):**
```typescript
// web/server/semantic-memory.ts
import * as lancedb from "@lancedb/lancedb";

// Opens/creates embedded DB at ~/.companion/memory/lancedb/
const db = await lancedb.connect(memoryDir);
const table = await db.openTable("fragments");
// or: db.createTable("fragments", schema) on first run
```

**Directory layout:**
```
~/.companion/
  memory/
    lancedb/                     ← LanceDB data directory (Lance columnar files)
      fragments.lance            ← all MemoryFragments with embeddings
      consolidated.lance         ← ConsolidatedKnowledge table
```

### Data Flow: Agent → Memory

```
1. Agent emits tool result (e.g. "Read" tool returns auth module code)
2. WsBridge receives assistant message
3. CollectiveIntelligenceLayer intercepts (observer pattern — non-blocking)
4. SemanticMemory.extractAndStore(sessionId, message):
     a. LLM call (or local heuristic) to extract key observations → MemoryFragment.content
     b. Embedding API call (OpenAI or Ollama) → Float32 vector stored in MemoryFragment.embedding
     c. LanceDB upsert: table.add([{ ...fragment, embedding }])
5. On session end: SemanticMemory.consolidate(sessionId)
     a. Query LanceDB for all fragments from this session
     b. Group by tag, synthesize ConsolidatedKnowledge per tag via LLM
     c. Upsert into consolidated.lance table
```

### Data Flow: Agent Query → Memory

```
1. Agent sends user_message: "How does auth work in this repo?"
2. WsBridge routes to agent backend (existing flow)
3. SIMULTANEOUSLY, SemanticMemory.query(sessionId, "How does auth work in this repo?", 10):
     a. Embed the query string via OpenAI/Ollama → queryVector: Float32[]
     b. LanceDB vector search: table.search(queryVector).limit(10).toArray()
        (optionally filter by repoRoot metadata for project-scoping)
     c. Returns top-N MemoryFragments ranked by cosine similarity
4. CollectiveIntelligenceLayer prepends memory context to agent's prompt:
     "[Memory] JWT auth, 7-day expiry. See web/server/auth.ts:45-60"
5. Agent processes enriched prompt
```

### API Endpoints

```
GET  /api/sessions/:id/memory
     → { fragments: MemoryFragment[], consolidated: ConsolidatedKnowledge[] }

POST /api/sessions/:id/memory
     body: { content, type, tags, gitContext }
     → { fragment: MemoryFragment }

GET  /api/sessions/:id/memory/query?q=:query&limit=:n
     → { results: MemoryFragment[], consolidated: ConsolidatedKnowledge[] }

POST /api/sessions/:id/memory/consolidate
     → { consolidated: ConsolidatedKnowledge[], count: number }

GET  /api/memory/global?tag=:tag
     → { knowledge: ConsolidatedKnowledge[] }   (cross-session)
```

### New Browser Message Types

```typescript
// Server → Browser
{ type: "memory_stored", fragment: MemoryFragment }
{ type: "memory_query_result", query: string, results: MemoryFragment[] }
{ type: "memory_consolidated", tag: string, knowledge: ConsolidatedKnowledge }

// Browser → Server
{ type: "memory_query", query: string, limit?: number }
{ type: "memory_store", content: string, type: string, tags: string[] }
```

---

## Layer 2: Deliberation Protocol

### Purpose

Before an agent executes a significant action (large refactor, architectural change, deleting files), it proposes an approach. Other agents and human viewers respond. A consensus engine synthesizes the final direction.

This transforms permission voting (binary yes/no on tool use) into deliberation (nuanced debate on _approach_).

### Data Model

```typescript
// web/server/session-types.ts — new message types

interface DeliberationProposal {
  type: "deliberation_proposal";
  proposalId: string;               // UUID
  sessionId: string;
  agentId: string;
  backendType: BackendType;
  timestamp: number;

  action: "refactor" | "feature" | "fix" | "investigate" | "delete" | "architect";
  title: string;                    // short description
  description: string;              // what and why
  approach: string;                 // detailed plan

  alternatives: Array<{
    description: string;
    tradeoffs: string;
  }>;

  risks: string[];
  affectedFiles: string[];          // predicted file paths
  estimatedTurns?: number;          // predicted length

  requestingFeedbackFrom: string[]; // viewer IDs or "all"
  deadline?: number;                // Unix ms, null = indefinite
}

interface DeliberationResponse {
  type: "deliberation_response";
  proposalId: string;
  responderId: string;              // agent session ID or viewer ID
  responderType: "agent" | "human";
  backendType?: BackendType;        // set if responder is an agent
  timestamp: number;

  stance: "agree" | "disagree" | "suggest_alternative" | "abstain";
  reasoning: string;
  suggestedAlternative?: string;
  concerns?: string[];
}

interface DeliberationResolution {
  type: "deliberation_resolved";
  proposalId: string;
  timestamp: number;

  outcome: "approved"               // original proposal accepted
           | "rejected"             // proposal blocked
           | "synthesized";         // alternative approach created from responses

  finalApproach: string;
  participants: string[];
  voteBreakdown: {
    agree: number;
    disagree: number;
    suggest_alternative: number;
    abstain: number;
  };
  synthesis?: string;               // if outcome = "synthesized"
}
```

### Data Flow: Propose → Debate → Consensus

```
1. Agent decides a significant change is needed
2. Agent (via adapter) emits DeliberationProposal to WsBridge
3. WsBridge:
     a. Stores proposal in session state (pendingDeliberations map)
     b. Broadcasts to all connected browser clients
     c. Optionally sends capability_probe to other agent sessions
4. Human viewers: see DeliberationCard in UI, click Agree/Disagree/Suggest
5. Other agents: receive probe, respond with DeliberationResponse
6. DeliberationEngine.evaluate(proposalId) runs when:
     - deadline reached, OR
     - all requestedFrom parties responded, OR
     - human owner clicks "Resolve Now"
7. Consensus algorithm:
     a. If majority agree → outcome = "approved", execute original approach
     b. If majority disagree → outcome = "rejected", block execution
     c. If alternatives suggested → LLM synthesizes → outcome = "synthesized"
8. DeliberationResolution broadcast to all clients
9. If approved/synthesized: proposal unblocked, agent proceeds
10. Resolution saved to SemanticMemory as type: "decision"
```

### Consensus Algorithm

```typescript
// web/server/deliberation-engine.ts

class DeliberationEngine {
  evaluate(proposal: DeliberationProposal, responses: DeliberationResponse[]): DeliberationResolution {
    const weights = this.computeWeights(responses);
    // Human owner = 2x weight, collaborators = 1.5x, spectators = 0.5x
    // Agents: weighted by historical accuracy for this task type

    const agreeScore = responses
      .filter(r => r.stance === "agree")
      .reduce((sum, r) => sum + weights[r.responderId], 0);

    const disagreeScore = responses
      .filter(r => r.stance === "disagree")
      .reduce((sum, r) => sum + weights[r.responderId], 0);

    const threshold = 0.6; // 60% weighted majority

    if (agreeScore / totalWeight >= threshold) {
      return { outcome: "approved", finalApproach: proposal.approach, ... };
    } else if (disagreeScore / totalWeight >= threshold) {
      return { outcome: "rejected", ... };
    } else {
      // synthesize alternatives
      const synthesis = this.synthesizeAlternatives(proposal, responses);
      return { outcome: "synthesized", finalApproach: synthesis, ... };
    }
  }
}
```

### API Endpoints

```
GET  /api/sessions/:id/deliberations
     → { active: DeliberationProposal[], resolved: DeliberationResolution[] }

GET  /api/sessions/:id/deliberations/:proposalId
     → { proposal, responses: DeliberationResponse[], resolution? }

POST /api/sessions/:id/deliberations/:proposalId/respond
     body: { stance, reasoning, suggestedAlternative? }
     → { response: DeliberationResponse }

POST /api/sessions/:id/deliberations/:proposalId/resolve
     → { resolution: DeliberationResolution }
```

### New Browser Message Types

```typescript
// Server → Browser
{ type: "deliberation_proposal", proposal: DeliberationProposal }
{ type: "deliberation_response", response: DeliberationResponse }
{ type: "deliberation_resolved", resolution: DeliberationResolution }

// Browser → Server (human participation)
{ type: "deliberation_respond", proposalId: string, stance: string, reasoning: string }
{ type: "deliberation_resolve", proposalId: string }
```

---

## Layer 3: Capability Discovery & Intelligent Routing

### Purpose

When a complex task arrives, automatically route subtasks to the best-suited agent backend — not by hardcoded rules, but by dynamic self-reporting + historical performance + real-time probing.

### Data Model

```typescript
// web/server/capability-discovery.ts

interface AgentCapabilities {
  sessionId: string;
  backendType: BackendType;
  reportedAt: number;

  // Self-reported by agent
  strengths: string[];              // ["python", "refactoring", "sql", "react"]
  weaknesses?: string[];
  availableTools: string[];
  contextWindowTokens: number;
  contextUsedPercent: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;

  // Learned from history
  taskSuccessRates?: Record<string, number>;   // task-type → success rate
  avgCompletionTime?: Record<string, number>;  // task-type → ms
}

interface TaskExecution {
  id: string;
  sessionId: string;
  backendType: BackendType;
  taskDescription: string;
  taskType: string;                 // derived from task (e.g. "refactoring", "debugging")
  startedAt: number;
  completedAt?: number;
  outcome: "success" | "failure" | "partial";
  humanFeedback?: "positive" | "negative" | "neutral";
  costUsd?: number;
  turnsUsed?: number;
}

interface RouteTaskRequest {
  taskDescription: string;
  availableSessions: string[];      // session IDs available for routing
  constraints?: {
    maxCostUsd?: number;
    maxTurns?: number;
    requiredTools?: string[];
  };
}

interface RouteTaskResult {
  sessionId: string;
  backendType: BackendType;
  confidence: number;               // 0.0–1.0
  reasoning: string;                // human-readable explanation
  alternatives: Array<{
    sessionId: string;
    confidence: number;
  }>;
}
```

### Storage

```
~/.companion/
  capability-learning.jsonl         ← append-only log of TaskExecution records
  capabilities/
    {sessionId}.json                ← latest AgentCapabilities per session
```

### Data Flow: Task Routing

```
1. User (or orchestrating agent) sends:
   POST /api/sessions/route-task { taskDescription, availableSessions }

2. IntelligentRouter.route(request):
   a. Load AgentCapabilities for each availableSession (from cache or probe)
   b. Load TaskExecution history from capability-learning.jsonl
   c. Score each session:

      score = (selfReportedFit × 0.3)
            + (historicalSuccessRate × 0.4)
            + (contextAvailability × 0.2)
            + (costEfficiency × 0.1)

   d. If low confidence (<0.5) on top candidate → send capability_probe
      to top 3 candidates to get real-time confidence from agent itself
   e. Return RouteTaskResult with reasoning

3. Browser receives route_result message, shows routing card
4. Human can accept or override routing suggestion
5. Task dispatched to selected session as user_message
6. On completion: TaskExecution stored to capability-learning.jsonl
```

### Capability Probe Flow

```
1. Router sends capability_probe to session:
   { type: "capability_probe", probeId, taskDescription,
     instruction: "Rate your confidence (0.0–1.0) for completing this task. Reply with JSON: { confidence, reasoning, approach }" }

2. Agent processes probe as normal user_message
3. Agent's response parsed for JSON confidence/reasoning
4. Router updates scoring with real-time probe result
5. Probe result cached for 5 minutes (short TTL — context changes)
```

### API Endpoints

```
POST /api/sessions/route-task
     body: { taskDescription, availableSessions?, constraints? }
     → RouteTaskResult

GET  /api/capabilities
     → { sessions: AgentCapabilities[] }

GET  /api/capabilities/history?backendType=:type&taskType=:type
     → { executions: TaskExecution[], successRate: number, avgCostUsd: number }

POST /api/capabilities/feedback
     body: { sessionId, taskId, feedback: "positive" | "negative" | "neutral" }
     → { ok: true }
```

### New Browser Message Types

```typescript
// Server → Browser
{ type: "capability_probe", probeId: string, taskDescription: string, instruction: string }
{ type: "route_result", result: RouteTaskResult }
{ type: "agent_capabilities", capabilities: AgentCapabilities }

// Browser → Server
{ type: "capability_probe_response", probeId: string, confidence: number, reasoning: string }
{ type: "route_task", taskDescription: string, availableSessions?: string[] }
```

---

## Layer 4: Shared Context Stream

### Purpose

Make agent reasoning transparent and interconnected. Agents "think aloud" into a shared stream. Other agents and humans can observe, react, and build on each other's thinking. Consensus and disagreements are automatically detected.

### Data Model

```typescript
// web/server/shared-context.ts

interface ContextFragment {
  fragmentId: string;               // UUID
  sessionId: string;
  agentId: string;
  backendType?: BackendType;        // null if from a human
  isHuman: boolean;
  timestamp: number;

  type: "thought"                   // internal reasoning step
      | "observation"               // noticed something
      | "plan"                      // intended next steps
      | "question"                  // posed to others
      | "answer"                    // response to a question
      | "insight"                   // non-obvious connection
      | "concern";                  // risk or issue identified

  content: string;
  parentId?: string;                // thread of reasoning (reply-to)

  // Set by semantic linker after the fact
  semanticLinks?: Array<{
    targetFragmentId: string;
    relation: "agrees_with" | "disagrees_with" | "builds_on" | "contradicts" | "questions";
  }>;

  // Set by consensus detector
  consensusScore?: number;          // how widely agreed upon (0–1)
  isControversial?: boolean;
}

interface ConsensusState {
  sessionId: string;
  updatedAt: number;
  consensusPoints: string[];        // fragment IDs with high consensusScore
  disagreements: Array<{
    fragmentIds: string[];          // fragments in conflict
    topic: string;
    summary: string;
  }>;
  openQuestions: string[];          // unanswered question fragment IDs
}
```

### Storage

```
Stored in-memory within WsBridge session state (not persisted to disk by default).
On session end: significant fragments promoted to SemanticMemory as observations/decisions.
```

### Data Flow: Think Aloud

```
1. Agent emits an agent_thought_chunk (existing — from stream_event type: "thinking")
   OR a new shared_thought message (explicit "think aloud")

2. CollectiveIntelligenceLayer intercepts:
   a. Creates ContextFragment
   b. Runs SemanticLinker (async, non-blocking):
      - Compare new fragment against recent N fragments
      - Identify semantic relations (agrees_with, contradicts, etc.)
      - Update semanticLinks on related fragments
   c. Runs ConsensusDetector (async):
      - Update consensusScore for affected fragments
      - Detect new disagreement clusters
      - Update ConsensusState for session
   d. Broadcasts shared_thought to all browser clients

3. Browser CollectiveMindPanel:
   a. Renders fragment in real-time thought stream
   b. Shows semantic links as graph edges
   c. Highlights consensus (green) and disagreements (orange)
   d. Groups by thread (parentId chain)
```

### Data Flow: Human Injects Thought

```
1. Human viewer types in CollectiveMindPanel input
2. Browser sends shared_thought message with isHuman: true
3. Server creates ContextFragment (isHuman: true)
4. Same semantic linking + consensus detection runs
5. Broadcast to all — including agent backends
6. Agents optionally receive injected human thought as context
   (configurable: agents can subscribe to human thoughts)
```

### API Endpoints

```
GET  /api/sessions/:id/context/stream
     → { fragments: ContextFragment[] }   (current session state)

GET  /api/sessions/:id/context/consensus
     → ConsensusState

GET  /api/sessions/:id/context/thread/:fragmentId
     → { thread: ContextFragment[] }      (root → children chain)
```

### New Browser Message Types

```typescript
// Server → Browser
{ type: "shared_thought", fragment: ContextFragment }
{ type: "semantic_link_added", sourceId: string, targetId: string, relation: string }
{ type: "consensus_update", state: ConsensusState }

// Browser → Server
{ type: "inject_thought", content: string, type: string, parentId?: string }
```

---

## Unified: CollectiveIntelligenceLayer

All four layers are coordinated by a single interceptor that wraps `WsBridge` without modifying it.

### Architecture Pattern

```typescript
// web/server/collective-intelligence.ts

class CollectiveIntelligenceLayer {
  private memory: SemanticMemory;
  private deliberation: DeliberationEngine;
  private router: IntelligentRouter;
  private context: SharedContextStream;

  /**
   * Called by WsBridge for every incoming browser message (browser → agent).
   * Returns enriched message with memory context injected, or blocks if awaiting deliberation.
   */
  async processBrowserMessage(
    sessionId: string,
    msg: BrowserOutgoingMessage,
  ): Promise<BrowserOutgoingMessage | null> {
    if (msg.type === "user_message") {
      // Enrich prompt with relevant memory
      const memories = await this.memory.query(sessionId, msg.content, 5);
      if (memories.length > 0) {
        const context = this.formatMemoryContext(memories);
        return { ...msg, content: `${context}\n\n${msg.content}` };
      }
    }
    if (msg.type === "route_task") {
      const result = await this.router.route(msg.taskDescription, msg.availableSessions);
      // Route to best session rather than current
      return null; // WsBridge reroutes to result.sessionId
    }
    return msg;
  }

  /**
   * Called by WsBridge for every incoming agent message (agent → browser).
   * Extracts memory fragments, handles deliberation proposals, updates shared context.
   */
  async processAgentMessage(
    sessionId: string,
    msg: BrowserIncomingMessage,
  ): Promise<void> {
    // Extract observations for semantic memory (async, non-blocking)
    if (msg.type === "assistant" || msg.type === "result") {
      this.memory.extractAndStore(sessionId, msg).catch(console.error);
    }

    // Route deliberation proposals
    if (msg.type === "deliberation_proposal") {
      this.deliberation.register(msg.proposal);
    }

    // Feed thinking blocks to shared context stream
    if (msg.type === "stream_event" && msg.event.type === "content_block_start") {
      if (msg.event.content_block.type === "thinking") {
        this.context.ingest(sessionId, msg.event.content_block.thinking, "thought");
      }
    }

    // Track capability execution (tool results → learning signal)
    if (msg.type === "result") {
      this.router.recordExecution(sessionId, msg.data);
    }
  }
}
```

### Integration Point in `ws-bridge.ts`

```typescript
// In WsBridge.handleCliMessage() — add 3 lines:
const ciLayer = this.collectiveIntelligence; // injected dependency
if (ciLayer) {
  ciLayer.processAgentMessage(sessionId, browserMsg);
}

// In WsBridge.handleBrowserMessage() — add 3 lines:
if (ciLayer) {
  const enriched = await ciLayer.processBrowserMessage(sessionId, msg);
  if (enriched === null) return; // rerouted or blocked
  msg = enriched;
}
```

---

## Full Data Flow Diagram

### Memory Write Path

```
Agent Backend
    │ tool result (e.g. Read returns auth.ts content)
    ▼
WsBridge.handleCliMessage()
    │ broadcasts BrowserIncomingMessage { type: "assistant" }
    ├──► Browser (existing, no change)
    └──► CollectiveIntelligenceLayer.processAgentMessage()
              │ async (non-blocking)
              ▼
         SemanticMemory.extractAndStore()
              │ LLM extraction or heuristic
              ▼
         MemoryFragment written to
         ~/.companion/memory/{sessionId}.jsonl
              │
              ▼
         index.json updated with new tags
```

### Memory Read Path (Prompt Enrichment)

```
Browser sends user_message: "How does auth work?"
    │
    ▼
WsBridge.handleBrowserMessage()
    │
    ├──► CollectiveIntelligenceLayer.processBrowserMessage()
    │         │ SemanticMemory.query(sessionId, "How does auth work?", 5)
    │         │ → returns top 5 MemoryFragments
    │         │ enriches user_message with "[Memory] ..."
    │         └── returns enriched msg
    │
    └──► Agent Backend (receives enriched prompt)
```

### Deliberation Path

```
Agent Backend
    │ emits deliberation_proposal message
    ▼
WsBridge.handleCliMessage()
    │
    ├──► Browser: DeliberationCard renders
    │
    └──► CollectiveIntelligenceLayer
              │ DeliberationEngine.register(proposal)
              │ sends capability_probe to other agent sessions
              ▼
         Other Agent Sessions
              │ respond with DeliberationResponse
              ▼
         DeliberationEngine.evaluate()
              │ computes consensus
              ▼
         DeliberationResolution broadcast to all browsers
              │
              ▼
         Proposing agent receives resolution
         (agent proceeds or cancels based on outcome)
              │
              ▼
         SemanticMemory.store(decision fragment)
```

### Routing Path

```
User: POST /api/sessions/route-task { taskDescription, availableSessions }
    │
    ▼
IntelligentRouter.route()
    │
    ├── Load capabilities for each session from ~/.companion/capabilities/
    ├── Load history from ~/.companion/capability-learning.jsonl
    ├── Score: selfReported × 0.3 + historical × 0.4 + context × 0.2 + cost × 0.1
    │
    ├── IF low confidence: send capability_probe to top 3 sessions
    │       │ Agent receives: "Rate your confidence 0–1 for: ..."
    │       │ Agent responds with JSON { confidence, reasoning }
    │       └── Router updates scores with real-time probe
    │
    └── Returns RouteTaskResult { sessionId, confidence, reasoning }
    │
    ▼
Browser shows routing card
User accepts (or overrides)
    │
    ▼
task dispatched to selected session as user_message
    │
    ▼
On completion: TaskExecution saved to capability-learning.jsonl
```

---

## New File Structure

```
web/server/
  collective-intelligence.ts      ← orchestrator (layer coordinator)
  semantic-memory.ts              ← memory fragments + consolidation
  deliberation-engine.ts          ← proposal/response/consensus
  capability-discovery.ts         ← self-reporting + historical + probing
  intelligent-router.ts           ← task routing with scoring
  shared-context.ts               ← real-time thought stream
  *.test.ts                       ← colocated tests for each

web/src/components/
  MemoryPanel.tsx                 ← graph visualization of memory
  DeliberationCard.tsx            ← proposal + response thread
  CollectiveMindPanel.tsx         ← real-time thought stream
  CapabilityRouter.tsx            ← routing suggestions UI
  ConsensusView.tsx               ← consensus/disagreement clusters

web/src/
  App.tsx                         ← add #/memory, #/collective-mind routes
```

---

## New Persistence Locations

| Data | Path | Format | Notes |
|------|------|--------|-------|
| Episodic + semantic memory | `~/.companion/memory/lancedb/fragments.lance` | LanceDB (Lance columnar) | Vector similarity search via `@lancedb/lancedb` |
| Consolidated knowledge | `~/.companion/memory/lancedb/consolidated.lance` | LanceDB | Synthesized per-tag summaries |
| Capability learning | `~/.companion/capability-learning.jsonl` | JSONL | Append-only TaskExecution log; rotated at 100k lines |
| Agent capabilities | `~/.companion/capabilities/{sessionId}.json` | JSON | Updated on session init, short TTL (5 min for probe cache) |
| Shared context | In-memory (WsBridge session state) | — | Promoted to LanceDB fragments on session end |

---

## New Browser Message Types Summary

```typescript
// ── Semantic Memory ───────────────────────────────────────────────
{ type: "memory_stored";        fragment: MemoryFragment }
{ type: "memory_query_result";  query: string; results: MemoryFragment[] }
{ type: "memory_consolidated";  tag: string; knowledge: ConsolidatedKnowledge }
{ type: "memory_query";         query: string; limit?: number }
{ type: "memory_store";         content: string; type: string; tags: string[] }

// ── Deliberation ──────────────────────────────────────────────────
{ type: "deliberation_proposal";  proposal: DeliberationProposal }
{ type: "deliberation_response";  response: DeliberationResponse }
{ type: "deliberation_resolved";  resolution: DeliberationResolution }
{ type: "deliberation_respond";   proposalId: string; stance: string; reasoning: string }
{ type: "deliberation_resolve";   proposalId: string }

// ── Capabilities ──────────────────────────────────────────────────
{ type: "capability_probe";           probeId: string; taskDescription: string; instruction: string }
{ type: "route_result";               result: RouteTaskResult }
{ type: "agent_capabilities";         capabilities: AgentCapabilities }
{ type: "capability_probe_response";  probeId: string; confidence: number; reasoning: string }
{ type: "route_task";                 taskDescription: string; availableSessions?: string[] }

// ── Shared Context ────────────────────────────────────────────────
{ type: "shared_thought";     fragment: ContextFragment }
{ type: "semantic_link_added"; sourceId: string; targetId: string; relation: string }
{ type: "consensus_update";   state: ConsensusState }
{ type: "inject_thought";     content: string; type: string; parentId?: string }
```

---

## New REST API Endpoints Summary

```
── Semantic Memory ─────────────────────────────────────
GET  /api/sessions/:id/memory
POST /api/sessions/:id/memory
GET  /api/sessions/:id/memory/query?q=:query&limit=:n
POST /api/sessions/:id/memory/consolidate
GET  /api/memory/global?tag=:tag

── Deliberation ────────────────────────────────────────
GET  /api/sessions/:id/deliberations
GET  /api/sessions/:id/deliberations/:proposalId
POST /api/sessions/:id/deliberations/:proposalId/respond
POST /api/sessions/:id/deliberations/:proposalId/resolve

── Capability Routing ──────────────────────────────────
POST /api/sessions/route-task
GET  /api/capabilities
GET  /api/capabilities/history?backendType=:type&taskType=:type
POST /api/capabilities/feedback

── Shared Context ──────────────────────────────────────
GET  /api/sessions/:id/context/stream
GET  /api/sessions/:id/context/consensus
GET  /api/sessions/:id/context/thread/:fragmentId
```

---

## Design Principles

1. **Non-invasive**: All layers intercept WsBridge messages without modifying existing code paths. The existing Claude/Codex/Goose flows are unchanged.

2. **Async-first**: Memory extraction, semantic linking, and consensus detection all run asynchronously. They never block agent response latency.

3. **File-based persistence**: Consistent with Campfire's existing architecture. No new database dependencies. JSONL for append-only logs, JSON for structured state.

4. **Graceful degradation**: If the CI layer fails (e.g., LLM extraction errors), it logs and continues. The main chat flow is unaffected.

5. **Backend-agnostic**: All four layers work identically whether the agent is Claude, Codex, Goose, OpenCode, or a community adapter. The `BackendType` is stored in fragments for analytics but the protocol is backend-neutral.

6. **Human-in-the-loop**: Every automated decision (routing, deliberation resolution) surfaces in the UI and can be overridden by human viewers with appropriate roles.

7. **Incremental adoption**: Each phase (Memory → Deliberation → Routing → Shared Context) is independently deployable. Phase 1 delivers standalone value without requiring Phase 2–4.
