# Semantic Memory v2 — Design Study

**Status:** Draft for implementation
**Date:** 2026-07-07
**Reference implementation studied:** MetaHarness ReasoningBank (github.com/ruvnet/metaharness, MIT)
**Scope:** Rebuild of Campfire's Layer-1 semantic memory (`web/server/semantic-memory.ts`, `embedding.ts`) and its integration points in `collective-intelligence.ts`, `shared-context.ts`, `ws-bridge.ts`, and `routes/ci-routes.ts`.

This document is a spec for an implementer. It does not change any code. Sections marked **[VERIFIED]** are grounded in code or documents actually read; **[INFERRED]** and **[UNVERIFIED]** are labeled as such.

---

## 1. Why rebuild — current-state audit

The current subsystem is a scaffold: types and storage are real, but every "intelligent" step is a stub, and the single most important consumer path (prompt enrichment) is not actually reachable. Concrete findings, all verified by reading the code:

### 1.1 Consolidation synthesis is a concatenation stub
`web/server/semantic-memory.ts:372-379` — `synthesize()` sorts fragments by confidence and joins the top 10 as a bullet list:

```
Knowledge about "<tag>":
- [observation] <content>
- ...
```

The file's own comment (`semantic-memory.ts:301-302`) says: *"Summary synthesis uses simple concatenation by default. In production, replace the `synthesize` function with an LLM call."* No distillation, dedup, or contradiction resolution happens.

### 1.2 Consolidation is not idempotent and never marks sources
`semantic-memory.ts:304-350` — `consolidateSession()`:
- Never sets `isConsolidated = true` or `consolidatedInto` on source fragments, so `MemoryFragment.isConsolidated` (`semantic-memory.ts:48`) is write-only dead state.
- Inserts a **new** `ConsolidatedKnowledge` row (fresh `randomUUID()`) per tag on every call — no upsert keyed by `(repoRoot, tag)`. Calling `POST /api/sessions/:id/memory/consolidate` twice duplicates every row.
- `getSessionFragments()` (`semantic-memory.ts:286-292`) is a full table scan (`limit(10000)`) filtered in JS.

### 1.3 Memory extraction is keyword-heuristic
`web/server/collective-intelligence.ts:325-355` — `extractMemory()` stores an "observation" only if the assistant text contains one of ten keywords (`"function"`, `"class"`, `"interface"`, ... at lines 337-339), truncates to 500 chars, and hardcodes `confidence: 0.6`. `extractTags()` (lines 376-397) is a fixed keyword→tag map (`"jwt"→"auth"`, `"postgres"→"database"`, ...). Result: noisy, low-signal fragments; long tool-result knowledge and anything phrased without those keywords is lost; everything is typed `observation` regardless of whether it's a decision or pattern.

### 1.4 Enrichment is naive — and, worse, unreachable
- The intended behavior (`collective-intelligence.ts:306-323`): prepend the top-5 `queryFragments()` hits to the user prompt under a `--- Relevant Context from Previous Sessions ---` header. No decay, recency, or confidence weighting — raw ANN order only.
- The header lies: the query is filtered by `{ sessionId }` (line 310), so it can only return fragments from the **current** session, never previous sessions.
- **The path is dead code.** `ws-bridge.ts:1788` routes every browser message through `interceptCIMessage()` (`ws-bridge.ts:1682-1691`), which only forwards message types in `CI_MESSAGE_TYPES` (`ws-bridge.ts:1675-1679`: `memory_query`, `memory_store`, `deliberation_*`, `route_task`, `inject_thought`, `capability_probe_response`). `user_message` is not in the set, so `processBrowserMessage()`'s `user_message` branch (`collective-intelligence.ts:179-181`) never fires. Even if it did, `interceptCIMessage` fire-and-forgets the promise and discards the returned enriched message, so enrichment output could never reach the agent. **User prompts are never enriched with memory today.**

### 1.5 Session-end consolidation only fires on deletion
`ws-bridge.ts:729-743` (`notifySessionEnded` → `collectiveIntelligence.onSessionEnd`) is called only from `removeSession()` (session delete) and `closeSession()` (`ws-bridge.ts:748-752`). Consolidation therefore runs when a session is *destroyed*, not when work concludes (turn end, idle, CLI exit). Sessions that are never deleted — the common case, since sessions persist in the sidebar — are never consolidated. A server crash loses everything un-consolidated. (The wiring itself is recent; `git log -S onSessionEnd` shows it landed in the 0.1.0 release prep commit `3177850`.)

### 1.6 Embeddings are optional and default to off
- `web/server/settings-manager.ts:48` — `embeddingProvider: "none"` is the default. With `"none"`, `embed()` returns `null` (`embedding.ts:32`), vector search is disabled, and `queryFragments()` falls back to a 500-row full scan sorted by recency (`semantic-memory.ts:257-261, 276-278`).
- **Zero-vector pollution:** when the provider is `"none"` *or an embed call fails*, the fragment is still written with `Array(dim).fill(0)` as its vector (`semantic-memory.ts:161`). Once a real provider is enabled, these zero rows sit inside the ANN index and surface with meaningless distances.
- **Dimension lock-in:** the `fragments` table schema is created on first write using `getEmbeddingDim()` — 1536 even when provider is `"none"` (`embedding.ts:43`). Switching later to Ollama (768-dim) makes every subsequent `table.add()` mismatch the schema. There is no migration or re-embedding path.

### 1.7 Retrieval filters are post-hoc and can starve
`semantic-memory.ts:252-273` — vector search over-fetches `limit * 3`, then filters `repoRoot`/`sessionId`/`type`/`tags` in JS. If the nearest 30 vectors belong to other repos/sessions, the caller gets zero results even though matching fragments exist. Filters are never pushed into LanceDB (`where()` is unused).

### 1.8 REST layer bugs
`web/server/routes/ci-routes.ts:14` — `GET /sessions/:id/memory` calls `getConsolidatedKnowledge("")` with a comment "cross-session consolidated"; but that function filters `k.repoRoot === repoRoot` (`semantic-memory.ts:363`), so `""` matches only rows whose repoRoot is the empty string — i.e., in practice, nothing that `consolidateSession` wrote with a real repo path. Same problem at `GET /memory/global` (`ci-routes.ts:54-59`). The endpoints structurally return empty consolidated knowledge.

### 1.9 No lifecycle model at all
There is no decay, no reinforcement, no access tracking (`lastAccessedAt`/`accessCount` don't exist on `MemoryFragment`, `semantic-memory.ts:35-51`), no TTL, no eviction, and no cap. The store only grows, and a fragment written on day 1 with confidence 0.6 outranks nothing and expires never.

**Conclusion:** this is not a tuning problem. The write path (extraction), the read path (enrichment), the compaction path (consolidation), and the lifecycle (decay) all need to be designed, and two integration bugs (1.4, 1.8) mean the feature is presently inert from a user's perspective. A rebuild against a proven reference model is justified.

---

## 2. Reference design: MetaHarness ReasoningBank

### 2.1 What was verified vs. inferred

**[VERIFIED — documents read]**
- `README.md`: confirms MetaHarness ships "a scoped memory namespace + governance policy" per generated harness, and lists `ruvector` (vector + agentic DB, "memory backend") and `@ruvector/emergent-time` ("memory-decay clock the kernel uses") as the underlying packages.
- `docs/adrs/INDEX.md`: ADR-006 "Memory + learning integration" (**status: Proposed**), ADR-074 "Darwin Mode — ruVector memory + RuFlo fabric" (Proposed), ADR-161 "ruVector Memory Tiers" (Proposed), ADR-025 "Browser embeddings (Transformers.js MiniLM)" (Accepted).
- `docs/adrs/ADR-006-memory-and-learning-integration.md`: the full memory design summarized below.
- `docs/ARCHITECTURE.md` and `docs/USERGUIDE.md`: **contain no memory/ReasoningBank sections at all** — the memory design lives exclusively in the ADRs.

**[UNVERIFIED / could not verify]**
- ADR-006 is status **Proposed**, so everything below is documented *intent*; I could not verify how much is implemented in shipping code (the kernel is a Rust crate; source was not audited).
- The exact math of the "Agentic Time Index (ATI)" decay multiplier — the npm page for `@ruvector/emergent-time` returned HTTP 403 and the ADR gives behavior, not formulas.
- ADR-161's five memory tiers define recall *views* and per-tier depth, but explicitly specify **no** decay/expiry/promotion rules ("The document does not specify decay rules, TTL/expiry policies, or promotion/demotion mechanics").
- HNSW performance claims (crossover at N≈5k, 3.2–4.7× speedup, recall@10 ≈ 0.99 at N=20k) are the ADR's own benchmark assertions, not independently reproduced.

### 2.2 The model (per ADR-006)

**Seven layers**, bottom-up:

1. **AgentDB unified backend** — SQLite for transactional metadata + vector store, single physical DB per harness install at `${HARNESS_DATA_PATH}/memory/`. API: `store(namespace, key, value, tags?, ttl?)`, `retrieve`, `search(query, namespaces, limit)`, `delete`, `list`. All hosts (Claude Code, Codex, …) share it → "cross-host continuity."
2. **Emergent-time decay weighting** — per-namespace decay policy driven by `@ruvector/emergent-time` (a 55 KB wasm module: `AgenticClock`, `WindowedDeltaClock`, `PageHinkleyDetector`, `LearnedWeights`). Each namespace declares `halfLifeHours` (nullable = never decays) and `reinforceMultiplier`. Key behavior: *"Frequently-accessed memories extend their half-life adaptively"* — a memory retrieved 100 times has an emergent half-life longer than configured; one never read decays at the configured rate. The clock's ATI becomes a per-memory decay multiplier at retrieval time.
3. **Quantization** — `none` / `int8` (default, 4× compression, cosine ≈ 0.99999) / `rabitq` (32×, recommended > ~100k vectors).
4. **HNSW vector index** — ruvector NAPI. Automatic brute-force fallback below the N≈5k crossover.
5. **Hybrid retrieval** — BM25 (sparse, weight 0.3) + HNSW (dense, weight 0.7) + cross-encoder rerank (`bge-reranker-base`, top-50).
6. **Intelligence pipeline** — `RETRIEVE → JUDGE → DISTILL → CONSOLIDATE`. JUDGE evaluates a finished trajectory (verdict: success/failure/inconclusive; pluggable `JudgeProvider`). DISTILL extracts a durable pattern from the trajectory (pluggable `DistillProvider`; default is a LoRA-style adapter). CONSOLIDATE updates the long-term store with EWC++ (elastic weight consolidation; not pluggable). DISTILL firing is triggered by a Page–Hinkley change-point detector ("fires on regime shift rather than fixed cadence").
7. **ReasoningBank trajectory tracking** — the write API agents use: `trajectory.start({goal, agent})` → `trajectory.step(id, {action, result, quality})` → `trajectory.end(id, {status})`, plus `trajectory.replay(id)`. Every step is passed through `scrubReasoningBlocks` to strip `<think>` contamination before storage.

**Namespace model** — a standard set with per-namespace decay policy, extensible via `harness.config.json` `memory.namespaces`:

| Namespace | Purpose | Default decay |
|---|---|---|
| `patterns` | Distilled learnings from trajectories | 30-day half-life, reinforced |
| `tasks` | Recent task history | 7-day half-life |
| `feedback` | User feedback | no decay |
| `claude-memories` / `auto-memory` | Bridged host auto-memory | 30-day half-life |
| `verifications` | Witness telemetry | no decay |
| `federation` | Federation-shared state | configurable |

Decay config shape (verbatim from ADR-006):

```jsonc
{
  "memory": {
    "decay": {
      "patterns": { "halfLifeHours": 720, "reinforceMultiplier": 1.5 },
      "tasks":    { "halfLifeHours": 168, "reinforceMultiplier": 1.2 },
      "feedback": { "halfLifeHours": null, "reinforceMultiplier": 1.0 }
    }
  }
}
```

**Run-time flow:** retrieve via hybrid search → weight retrieved items by decay multiplier → execute → record steps (scrubbed) → on trajectory end, JUDGE → if warranted, DISTILL a pattern → CONSOLIDATE into long-term store. Bootstrap via `hooks.pretrain(history)` and `memory export | memory import`.

### 2.3 What ADR-161 adds (tiers)
Five *read views* over one underlying store — Working / Repo / Mutation / Cost / Risk — with a per-tier recall **depth** (`0..MAX_K`, `0` disables the tier) that is itself an evolvable policy parameter. Tiers are "non-overlapping read views… avoiding duplication." No new scoring formula, no new storage. The useful idea for us: retrieval depth per scope is a tunable, not a constant.

---

## 3. Proposed Campfire v2 design

Design goals: (a) memories actually reach prompts; (b) old/noisy memories fade unless used; (c) consolidation produces distilled knowledge, not concatenation; (d) everything degrades gracefully when no embedding provider or no OpenRouter key is configured; (e) works identically for all backends (Claude Code, Codex, …) because it lives entirely server-side on the normalized browser-message stream — per the repo rule that features must be backend-compatible.

### 3.1 Namespace scoping

Add a first-class `namespace` string column to both LanceDB tables, replacing today's ad-hoc post-filtering on `sessionId`/`repoRoot`. Namespaces are hierarchical path strings:

| Namespace | Contains | Written by | Default half-life | Reinforce |
|---|---|---|---|---|
| `global` | Cross-repo conventions, user preferences, tool quirks | consolidation promotion; manual `memory_store` | 90 d | ×1.5 |
| `repo:<repoRootHash>` | Architecture, conventions, prior failures, distilled patterns for one repo | consolidation; extraction | 30 d | ×1.5 |
| `session:<sessionId>` | Episodic fragments of one session (pre-consolidation) | extraction; shared-context promotion | 7 d | ×1.2 |
| `agent:<backendType>` | Backend-specific behavior notes ("codex needs X flag", "goose ACP quirk") | consolidation; manual | 60 d | ×1.2 |

Notes:
- `repoRootHash` = short SHA-256 of the absolute repo root (stable, path-privacy-friendly, safe in LanceDB `where()` strings). Keep the raw `repoRoot` as a separate column for display.
- Retrieval for a session queries an ordered namespace set: `[session:<id>, repo:<hash>, agent:<backend>, global]`, each with its own recall depth (ADR-161's idea): defaults `4 / 6 / 2 / 3`, configurable in `~/.campfire/settings.json` under `memory.recallDepth`.
- Decay policy per namespace class lives in settings with the ADR-006 shape (`memory.decay.{class}.halfLifeHours|reinforceMultiplier`), defaults above. `null` half-life = no decay (used for pinned/user-curated memories, below).

### 3.2 Decay + reinforcement model

We implement decay **lazily at read time** — no background clock, no wasm dependency. New fragment columns: `createdAt` (exists as `timestamp`), `lastReinforcedAt`, `accessCount`, `pinned` (bool), `halfLifeHours` (nullable override).

**Weight function** (computed at query time, never stored):

```
halfLife_eff = halfLife_base × reinforceMultiplier ^ min(accessCount, 8)
w(t)         = pinned ? 1.0
             : 0.5 ^ ((now − lastReinforcedAt) / halfLife_eff)
```

- **Reinforcement:** when a fragment is *actually used* — included in an enrichment block or explicitly returned by `memory_query` — bump `accessCount += 1` and set `lastReinforcedAt = now` (batched, debounced write; LanceDB `mergeInsert` or delete+add by id). Merely matching in ANN does not reinforce; inclusion does. This reproduces ADR-006's emergent behavior ("frequently-accessed memories extend their half-life") with a capped multiplier so a hot memory can't become immortal by accident (cap 8 → max extension ×1.5⁸ ≈ ×25.6).
- **Expiry / eviction:** a periodic sweep (piggyback on the existing debounced-persistence timer cadence, e.g. hourly) deletes fragments with `w(t) < 0.05` and `pinned = false` and `isConsolidated = true` (consolidated sources are safe to drop — their essence lives in the consolidated table). Un-consolidated fragments below threshold are consolidated-then-dropped rather than silently lost. Hard cap per namespace (default 5 000 fragments) with lowest-`w` eviction as backstop.
- **No decay for:** `pinned` fragments (user clicks "pin" in UI / `POST /memory` with `pinned: true`) and consolidated knowledge rows (they decay only via *supersession*, §3.4).

### 3.3 Retrieval scoring

Replace raw ANN order with a composite score:

```
score = simNorm ^ 1.5 × w(t) × confidence
  where simNorm = max(0, 1 − cosineDistance)   // LanceDB _distance, cosine metric
```

- `^1.5` sharpens similarity so decay/confidence break ties rather than override a strong semantic match. Tune later; make the exponent a constant in one place.
- **Query plan:** for each namespace in the recall set, run `table.search(vec).where("namespace = '...' AND embeddingStatus = 'ok'").limit(depth × 4)`, score in TS, take top `depth`. Pushing `namespace` into `where()` fixes the starvation bug (§1.7). Merge across namespaces, dedupe near-identical content (cosine > 0.97 → keep higher score), cap total context budget (default 1 200 chars of fragment text + all consolidated summaries for the repo, max ~2 000 chars total).
- **No-embedding fallback:** when provider is `"none"`, fall back to per-namespace recency×confidence ranking (`w(t) × confidence` over a metadata-filtered scan). Never zero-vector search. This keeps the feature useful (recent repo decisions still surface) without vectors.
- Consolidated knowledge is retrieved by namespace + optional tag (cheap metadata query), always ranked above raw fragments in the enrichment block.
- We deliberately do **not** add BM25/hybrid or a cross-encoder reranker in v2 (see §4).

### 3.4 Consolidation pipeline (LLM-backed distillation)

Replace `synthesize()` with a two-stage pipeline modeled on ADR-006's JUDGE→DISTILL→CONSOLIDATE, sized for Campfire:

**Triggers** (all funnel into one `consolidate(sessionId, reason)` with an in-flight guard):
1. **Turn boundary** (primary): on `result` message for a session, if ≥ N (default 8) un-consolidated fragments exist — this fixes §1.5's "only on deletion" problem.
2. **Idle:** session idle > 30 min with un-consolidated fragments.
3. **Session end:** existing `onSessionEnd` hook (keep).
4. **Manual:** existing `POST /api/sessions/:id/memory/consolidate` (keep).

**Stage 1 — JUDGE (cheap, local):** filter the candidate fragment set — drop fragments with `w(t) × confidence < 0.15`, drop near-duplicates (embedding cosine > 0.97 within the batch), group by embedding-cluster (greedy threshold 0.80) instead of today's keyword tags. Tags become *outputs* of distillation, not grouping keys.

**Stage 2 — DISTILL (LLM call, spec only — do not hand-roll prompt at implementation time without this contract):**

Model routing: use the existing OpenRouter plumbing (`settings-manager.ts` `openrouterApiKey` / `openrouterModel`, same path `auto-namer.ts` uses). If no key is configured, consolidation degrades to the current concatenation with a `synthesisMethod: "concat"` marker so the UI can badge it — never blocked.

*Prompt contract:*

- **System prompt (fixed):**
  > You distill working notes from an AI coding session into durable knowledge for future sessions in this repository. Output ONLY valid JSON matching the schema. Merge duplicates. Resolve contradictions by preferring later, higher-confidence notes and say what superseded what. Discard chit-chat, transient state (branch names, in-progress todo status), and anything true only for this one session. Each summary must be a standalone statement useful with zero session context, ≤ 60 words.
- **User message (JSON, not prose):**
  ```json
  {
    "repoRoot": "/abs/path",
    "cluster": [
      { "id": "uuid", "type": "observation|hypothesis|decision|pattern",
        "content": "...", "confidence": 0.6, "ageHours": 3.2,
        "files": ["web/server/x.ts"] }
    ],
    "existingKnowledge": [
      { "id": "uuid", "tag": "auth", "summary": "...", "confidence": 0.8 }
    ]
  }
  ```
  `existingKnowledge` = current consolidated rows for the same namespace whose embedding is within 0.80 of the cluster centroid — this is what makes consolidation an *update*, not append-only.
- **Required output schema (validate strictly; on parse failure retry once with the validator error appended, then fall back to concat):**
  ```json
  {
    "knowledge": [
      { "tag": "kebab-case-topic",
        "type": "pattern|decision|convention|failure|fact",
        "summary": "standalone statement",
        "confidence": 0.0,
        "sourceFragmentIds": ["uuid"],
        "supersedes": ["existing-knowledge-uuid"],
        "namespace": "repo|global|agent" }
    ],
    "discardedFragmentIds": ["uuid"]
  }
  ```
- **Budget:** max 40 fragments per call, max 4 calls per trigger; temperature 0; the call is fire-and-forget off the hot path (same non-blocking posture as the rest of the CI layer).

**Stage 3 — CONSOLIDATE (deterministic):** for each output item: upsert by `(namespace, tag)` — if `supersedes` names existing rows, replace them (keep `supersededBy` tombstone id on the old row for audit); embed the new summary; set `sourceFragments`; mark all `sourceFragmentIds` + `discardedFragmentIds` fragments `isConsolidated = true`, `consolidatedInto = <knowledge id>`. This finally makes §1.2's dead fields live and makes consolidation idempotent.

### 3.5 Migration from current LanceDB tables

Current state: `~/.campfire/memory/lancedb/` with `fragments` (vector dim = whatever provider was configured at first write, default 1536 of zeros) and `consolidated` (no vector column). Migration must be automatic, one-way, and safe to interrupt:

1. **Versioned tables, not in-place ALTER.** On startup, read `~/.campfire/memory/meta.json` (`{ schemaVersion, embeddingProvider, dim }`; absent = v1). If `schemaVersion < 2`, create `fragments_v2` / `consolidated_v2` with the new columns (`namespace`, `repoRootHash`, `lastReinforcedAt`, `accessCount`, `pinned`, `halfLifeHours`, `embeddingStatus`, `synthesisMethod`, `supersededBy`) and copy rows transformed:
   - `namespace` backfill: `repoRoot` present → `repo:<hash>`; else `session:<sessionId>`; consolidated rows with `repoRoot === ""` → `global`.
   - `lastReinforcedAt = timestamp`, `accessCount = 0`, `pinned = false`.
   - **Zero-vector rows:** detect (all-zero vector) → `embeddingStatus = "pending"`, vector kept as zeros but excluded from ANN by the `where()` clause (§3.3). A lazy re-embed queue (drained at ≤ 2 req/s whenever a real provider is configured) fills them in and flips status to `"ok"`.
   - Old tables are renamed to `fragments_v1_backup` (LanceDB: keep directory, don't open) and dropped after 30 days or on `campfire memory prune`.
2. **Dimension changes** (fixes §1.6 lock-in): `meta.json` records `(provider, dim)`. If settings change to a different dim, do **not** rewrite the schema live; mark all rows `embeddingStatus = "pending"`, create `fragments_v2_<dim>` as the active table, and re-embed via the same queue. `getEmbeddingDim()`'s "1536 when none" default goes away — with provider `none`, no vector column is populated and `embeddingStatus = "none"`.
3. Existing REST responses (`GET /sessions/:id/memory`, `/memory/global`) keep their shapes; the `""`-repoRoot bug (§1.8) is fixed by querying `global` + `repo:<hash of session cwd>` namespaces instead.

### 3.6 Feeding the enrichment path (the integration fix)

This is the part that makes everything above matter, and it requires a small `ws-bridge.ts` change:

1. In `routeBrowserMessage()` (`ws-bridge.ts:1773+`), *before* backend dispatch and after `interceptCIMessage`, add an **awaited** enrichment hook for `msg.type === "user_message"`:
   ```
   msg = await this.collectiveIntelligence.enrichUserMessage(session, msg)  // ≤ 250 ms budget
   ```
   with `Promise.race` against a 250 ms timeout returning the original message, and try/catch pass-through — the chat flow must never block on memory. (The existing `processBrowserMessage` fire-and-forget in `interceptCIMessage` stays as-is for consumed CI message types; enrichment becomes its own explicit, awaited call because it *transforms* rather than consumes.)
2. `enrichUserMessage` (new name for the fixed `enrichWithMemory`) queries namespaces `[repo:<hash>, agent:<backend>, global]` — **not** `session:<id>` for the fragment portion, since same-session context is already in the agent's own conversation; that removes §1.4's self-referential filter. Format:
   ```
   --- Campfire memory (auto-recalled; may be stale) ---
   Knowledge: <consolidated summaries, tag-prefixed>
   Notes: [pattern] ... / [decision] ... (fragment lines, max 5)
   --- end memory ---

   <original user message>
   ```
3. Reinforce (§3.2) every fragment/knowledge row actually included.
4. Surface it: broadcast a `memory_enriched` browser message listing what was injected (ids + summaries) so the UI can render a collapsible "recalled context" chip instead of memories being invisible prompt text. Per repo convention, add the corresponding mock state to `web/src/components/Playground.tsx`.
5. Extraction upgrade (write path): keep it heuristic-light but stop keyword-gating (§1.3). Extract candidate fragments from (a) `result`-adjacent assistant text, (b) Edit/Write/Bash tool outcomes already parsed elsewhere in `ws.ts`-equivalent server logic, typed by simple structural cues (contains "decided/instead/because" → `decision`; error+fix pair → `failure`). Precision comes from Stage-1 JUDGE at consolidation time, not from the extractor — extraction can afford recall-biased noise because decay + consolidation clean it up. Scrub thinking-block text from anything stored (ADR-006's `scrubReasoningBlocks` idea): never persist raw `thinking` content into `session:` namespace without stripping — today `collective-intelligence.ts:144-160` ingests thinking blocks verbatim into the shared-context stream that later gets promoted (`collective-intelligence.ts:283-296`).

### 3.7 Testing (repo requirement)

Per CLAUDE.md, all new server code needs colocated Vitest coverage: decay math (pure function, table-driven), namespace query planner (`where()` strings), consolidation contract (mock OpenRouter: valid JSON, invalid JSON → retry → concat fallback), migration (fixture v1 dir → v2 tables, zero-vector detection), and a ws-bridge test that a `user_message` gets enriched and a slow enrichment (>250 ms) passes through unmodified.

---

## 4. What we deliberately do NOT copy (and why)

| ReasoningBank feature | Decision | Why |
|---|---|---|
| **Hybrid retrieval (BM25 + dense + cross-encoder rerank)** | Skip in v2 | Our corpus per repo is thousands of short fragments, not millions of docs. LanceDB ANN + composite scoring is sufficient below ~10k rows; a rerank model is a heavyweight dependency (download, cold-start) for marginal gain at this scale. Revisit if namespaces exceed ~20k rows. |
| **`@ruvector/emergent-time` wasm clock (ATI, Page–Hinkley, LearnedWeights)** | Skip; implement half-life + capped reinforcement in ~30 lines of TS | The ADR's *behavior* (access extends half-life) is what matters; the wasm module is an unverifiable black box for us (npm page unfetchable), adds a native/wasm dep to a Bun server, and change-point-triggered distillation is overkill when we have natural triggers (turn end, idle, session end). |
| **Quantization (int8 / RaBitQ)** | Skip | Justified above ~100k vectors per the ADR itself. We cap namespaces at 5k. |
| **HNSW via ruvector NAPI** | Skip — keep LanceDB's built-in index | Same ADR says brute force wins below N≈5k anyway; LanceDB already gives us ANN without a new native dependency, and it's the stack we ship today. |
| **EWC++ / LoRA-style DISTILL** | Replace with LLM distillation (§3.4) | Those techniques consolidate *model weights*; we consolidate *text*. An LLM call with a strict JSON contract is the text-domain equivalent and matches infrastructure we already have (OpenRouter, used by auto-namer). |
| **Full ReasoningBank trajectory layer (`trajectory.start/step/end/replay`)** | Skip | Campfire already records every raw protocol message to JSONL (`recorder.ts` / `replay.ts`). Building a second trajectory store would duplicate it; if we later want trajectory-level JUDGE, derive it from recordings. |
| **Witness attestation / Ed25519-signed memory manifests** | Skip | Solves a supply-chain trust problem MetaHarness has (shipping harnesses to third parties). Campfire memory is local, single-user-machine state. |
| **Federation / IPFS pattern bundles / `hooks.pretrain`** | Skip (export/import maybe later) | Cross-install sharing is out of scope; a plain `memory export`/`import` JSON command is a cheap future add and needs none of the federation machinery. |
| **Per-tier evolvable depth genomes (ADR-161)** | Copy the idea, not the mechanism | We take "recall depth per scope is a tunable" as a settings knob; we are not running an evolutionary optimizer over it. |

---

## 5. Phased implementation plan

Effort assumes one engineer familiar with the codebase; each phase lands independently behind the existing non-blocking CI-layer posture.

**Phase 0 — Stop the bleeding (bug fixes on current code) — ~1–2 days**
- Wire enrichment for real: awaited `enrichUserMessage` hook in `routeBrowserMessage` with timeout (§3.6.1) — even against the v1 store this makes the feature exist.
- Fix `getConsolidatedKnowledge("")` misuse in `ci-routes.ts:14` and `:57`.
- Make `consolidateSession` idempotent: upsert by `(repoRoot, tag)`, mark sources `isConsolidated`.
- Stop writing zero vectors on embed failure (store `embeddingStatus`, exclude from search).
- Tests for each. *No schema redesign yet.*

**Phase 1 — Schema v2 + namespaces + migration — ~2–3 days**
- New columns, `meta.json` versioning, v1→v2 copy migration, zero-vector → `pending` queue, namespace backfill (§3.1, §3.5).
- Pushed-down `where()` filtering; namespace-aware `queryFragments`.
- Migration tests with fixture DBs (both 1536 and post-provider-switch cases).

**Phase 2 — Decay, reinforcement, scored retrieval — ~2–3 days**
- Weight function + composite score + per-namespace recall depths (§3.2–3.3); reinforcement writes (debounced); eviction sweep + namespace caps.
- No-embedding fallback ranking. Settings surface (`memory.decay.*`, `memory.recallDepth.*`) in `settings-manager.ts` + `SettingsPage`.

**Phase 3 — LLM consolidation pipeline — ~3–4 days**
- Triggers (turn boundary, idle, session end, manual) with in-flight guard; Stage-1 JUDGE filtering/clustering; DISTILL prompt contract + strict-JSON validation + retry + concat fallback (§3.4); Stage-3 upsert/supersede.
- Contract tests with mocked OpenRouter; badge `synthesisMethod` in memory REST responses.

**Phase 4 — Extraction upgrade + UI surfacing — ~2–3 days**
- Recall-biased extractor replacing keyword gate; thinking-block scrubbing before any store/promotion (§3.6.5).
- `memory_enriched` broadcast + collapsible recalled-context UI + Playground mocks; pin/unpin control; memory panel showing per-namespace counts and decayed weights.

**Total: ~10–15 engineer-days.** Phase 0 alone is user-visible (memory finally reaches prompts); Phases 1–2 make it trustworthy; Phase 3 makes it good; Phase 4 makes it legible.

---

## Appendix: verification ledger

- **Read in full (local):** `semantic-memory.ts`, `embedding.ts`, `shared-context.ts`, `collective-intelligence.ts`, `routes/ci-routes.ts`, `settings-manager.ts` (embedding section), `ws-bridge.ts` (lines 380–410, 700–760, 1380–1410, 1655–1800).
- **Fetched (metaharness@main):** `README.md`, `docs/ARCHITECTURE.md` (no memory content), `docs/USERGUIDE.md` (no memory content), `docs/adrs/INDEX.md`, `ADR-006`, `ADR-074`, `ADR-161`.
- **Could not verify:** MetaHarness kernel source (Rust) — ADR-006 is *Proposed*, so implementation depth unknown; `@ruvector/emergent-time` internals/ATI formula (npm 403); HNSW benchmark claims (taken as reported).
