/**
 * Layer 1: Semantic Memory — v2 core store.
 *
 * Persistent, shared knowledge base anchored to namespaces (design doc
 * docs/design/semantic-memory-v2.md §3.1–§3.5). Backed by LanceDB.
 *
 * Two active tables (names tracked in ~/.campfire/memory/meta.json):
 *   - fragments_v2[_<dim>]:    episodic/semantic MemoryFragments with vectors
 *   - consolidated_v2[_<dim>]: distilled ConsolidatedKnowledge per (namespace, tag)
 *
 * v2 adds:
 *   - namespaces (global / repo:<hash> / session:<id> / agent:<backend>) with
 *     pushed-down where() filtering (§3.1, fixes §1.7 starvation)
 *   - lazy decay + capped reinforcement (§3.2) — computed at read time
 *   - composite scored retrieval simNorm^1.5 × w(t) × confidence (§3.3)
 *   - embeddingStatus lifecycle ("ok"/"pending"/"none") — no zero vectors in
 *     ANN results (§1.6) + lazy re-embed queue at ≤ 2 req/s
 *   - consolidation primitives: idempotent upsert by (namespace, tag) with
 *     supersession tombstones and source marking (§1.2, §3.4 Stage 3)
 *   - v1 → v2 migration + dimension-change handling (§3.5, memory-migration.ts)
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BackendType, MemoryEnrichmentItem } from "./session-types.js";
import { embed, getEmbeddingDim, getEmbeddingProviderName } from "./embedding.js";
import { getMemorySettings, type MemoryDecayPolicy } from "./settings-manager.js";
import {
  ensureSchemaV2,
  hashRepoRoot,
  repoNamespace,
  sessionNamespace,
  agentNamespace,
  namespaceClass,
  isNamespaceString,
  toNumberArray,
  type MemoryMeta,
  type NamespaceClass,
} from "./memory-migration.js";

// Re-export the namespace model so consumers only need this module.
export {
  hashRepoRoot,
  repoNamespace,
  sessionNamespace,
  agentNamespace,
  namespaceClass,
  isNamespaceString,
  type NamespaceClass,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryType = "observation" | "hypothesis" | "decision" | "pattern";
export type EmbeddingStatus = "ok" | "pending" | "none";
export type SynthesisMethod = "llm" | "concat";
export type KnowledgeType = "pattern" | "decision" | "convention" | "failure" | "fact";

export interface GitContext {
  commitHash?: string;
  branch: string;
  files: string[];
  repoRoot: string;
}

export interface MemoryFragment {
  id: string;
  sessionId: string;
  agentId: string;
  backendType: BackendType;
  timestamp: number;
  type: MemoryType;
  content: string;
  gitContext: GitContext;
  references: string[];
  confidence: number;
  tags: string[];
  consolidatedInto?: string;
  isConsolidated: boolean;
  // Stored in LanceDB as a Float32 vector column — populated on read only
  // when embeddingStatus === "ok"
  embedding?: number[];
  // ── v2 lifecycle fields (§3.1/§3.2) — always populated by the store;
  //    optional so pre-v2 constructors/mocks keep compiling.
  namespace?: string;
  repoRootHash?: string;
  lastReinforcedAt?: number;
  accessCount?: number;
  pinned?: boolean;
  /** Per-fragment half-life override in hours; null = use namespace policy. */
  halfLifeHours?: number | null;
  embeddingStatus?: EmbeddingStatus;
}

export interface ConsolidatedKnowledge {
  id: string;
  tag: string;
  summary: string;
  sourceFragments: string[];
  lastUpdated: number;
  confidence: number;
  repoRoot: string;
  // ── v2 fields
  namespace?: string;
  type?: KnowledgeType;
  synthesisMethod?: SynthesisMethod;
  /** Tombstone: id of the knowledge row that superseded this one ("" / undefined = active). */
  supersededBy?: string;
}

export interface MemoryQueryOptions {
  limit?: number;
  repoRoot?: string;
  tags?: string[];
  type?: MemoryType;
  sessionId?: string;
  /** v2: restrict to a single namespace (pushed down into LanceDB where()). */
  namespace?: string;
}

// ─── Tunables (§3.2/§3.3) ────────────────────────────────────────────────────

/** Similarity sharpening exponent — decay/confidence break ties, not override matches. */
export const SIM_EXPONENT = 1.5;
/** Fragments with pairwise cosine above this are near-duplicates (keep higher score). */
export const NEAR_DUP_COSINE = 0.97;
/** Decayed-weight floor below which consolidated, unpinned fragments are evicted. */
export const EVICTION_WEIGHT_THRESHOLD = 0.05;
/** Hard cap of fragments per namespace (lowest-w eviction backstop). */
export const NAMESPACE_HARD_CAP = 5000;
/** Reinforcement cap: half-life extension multiplier applies at most this many times. */
export const REINFORCE_ACCESS_CAP = 8;
/** Enrichment budget: max chars of raw fragment text in the block. */
export const FRAGMENT_BUDGET_CHARS = 1200;
/** Enrichment budget: max chars of the whole injected block. */
export const TOTAL_BUDGET_CHARS = 2000;
/** Max fragment lines in the enrichment block (§3.6.2). */
export const MAX_ENRICHMENT_FRAGMENTS = 5;

const REINFORCE_DEBOUNCE_MS = 500;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly (§3.2)
const REEMBED_INTERVAL_MS = 1000; // batch of 2 per second = ≤ 2 req/s (§3.5)

// ─── Decay + reinforcement (§3.2) ────────────────────────────────────────────

export type DecayPolicy = MemoryDecayPolicy;

/** Minimal shape needed to compute a decayed weight (table-driven-testable). */
export interface DecayableLike {
  pinned?: boolean;
  lastReinforcedAt?: number;
  timestamp?: number;
  accessCount?: number;
  halfLifeHours?: number | null;
}

/**
 * Lazy decay weight, computed at read time and never stored:
 *
 *   halfLife_eff = halfLife_base × reinforceMultiplier ^ min(accessCount, 8)
 *   w(t)         = pinned ? 1.0 : 0.5 ^ ((now − lastReinforcedAt) / halfLife_eff)
 *
 * Pinned rows and null half-lives never decay (w = 1).
 */
export function computeDecayedWeight(fragment: DecayableLike, now: number, policy: DecayPolicy): number {
  if (fragment.pinned) return 1;
  const override = fragment.halfLifeHours;
  const baseHalfLife = typeof override === "number" && override > 0 ? override : policy.halfLifeHours;
  if (baseHalfLife === null || baseHalfLife <= 0) return 1;
  const multiplier = policy.reinforceMultiplier > 0 ? policy.reinforceMultiplier : 1;
  const capped = Math.min(Math.max(fragment.accessCount ?? 0, 0), REINFORCE_ACCESS_CAP);
  const effectiveHalfLife = baseHalfLife * Math.pow(multiplier, capped);
  const anchor = fragment.lastReinforcedAt ?? fragment.timestamp ?? now;
  const ageHours = Math.max(0, now - anchor) / 3_600_000;
  return Math.pow(0.5, ageHours / effectiveHalfLife);
}

/** Decay policy for a namespace, from settings (defaults per §3.1). */
export function policyForNamespace(namespace: string): DecayPolicy {
  const cls: NamespaceClass = namespaceClass(namespace);
  return getMemorySettings().decay[cls];
}

// ─── SQL helpers (pushed-down filters, §1.7 fix) ─────────────────────────────

/** Quote a string literal for a LanceDB (DataFusion) where() predicate. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Where-clause for a namespace query. `embeddedOnly` additionally excludes
 * rows without a usable embedding from ANN search (§1.6 / §3.3).
 */
export function buildNamespaceWhere(namespace: string, embeddedOnly = true): string {
  const base = `namespace = ${sqlQuote(namespace)}`;
  return embeddedOnly ? `${base} AND embeddingStatus = 'ok'` : base;
}

// ─── LanceDB integration ─────────────────────────────────────────────────────

type LanceDB = typeof import("@lancedb/lancedb");
type LanceConnection = Awaited<ReturnType<LanceDB["connect"]>>;
type LanceTable = Awaited<ReturnType<LanceConnection["openTable"]>>;

interface StoreState {
  db: LanceConnection;
  fragments: LanceTable;
  consolidated: LanceTable;
  meta: MemoryMeta;
}

let _memoryRoot = join(homedir(), ".campfire", "memory");
let _initPromise: Promise<StoreState> | null = null;

async function initState(): Promise<StoreState> {
  const lancedb = await import("@lancedb/lancedb");
  const dbDir = join(_memoryRoot, "lancedb");
  mkdirSync(dbDir, { recursive: true });
  const db = await lancedb.connect(dbDir);
  const { meta, fragments, consolidated } = await ensureSchemaV2({
    db,
    memoryRoot: _memoryRoot,
    provider: getEmbeddingProviderName(),
    providerDim: getEmbeddingDim(),
  });
  return { db, fragments, consolidated, meta };
}

async function getState(): Promise<StoreState> {
  let state = await (_initPromise ??= initState());
  // Live provider/dimension change (settings edited at runtime): re-run the
  // reconciliation path so the active tables always match the provider (§3.5.2).
  const provider = getEmbeddingProviderName();
  const dim = getEmbeddingDim();
  if (provider !== state.meta.embeddingProvider || (dim !== null && dim !== state.meta.dim)) {
    _initPromise = initState();
    state = await _initPromise;
  }
  ensureMaintenanceTimers();
  return state;
}

// ─── Row <-> domain object mapping ───────────────────────────────────────────

function rowStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rowNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fragmentToRow(fragment: MemoryFragment, vector: number[], status: EmbeddingStatus) {
  return {
    id: fragment.id,
    sessionId: fragment.sessionId,
    agentId: fragment.agentId,
    backendType: fragment.backendType,
    timestamp: fragment.timestamp,
    type: fragment.type,
    content: fragment.content,
    gitContextJson: JSON.stringify(fragment.gitContext),
    referencesJson: JSON.stringify(fragment.references),
    tagsJson: JSON.stringify(fragment.tags),
    confidence: fragment.confidence,
    consolidatedInto: fragment.consolidatedInto ?? "",
    isConsolidated: fragment.isConsolidated,
    namespace: fragment.namespace ?? "",
    repoRoot: fragment.gitContext.repoRoot ?? "",
    repoRootHash: fragment.repoRootHash ?? "",
    lastReinforcedAt: fragment.lastReinforcedAt ?? fragment.timestamp,
    accessCount: fragment.accessCount ?? 0,
    pinned: fragment.pinned ?? false,
    // 0 = no override (null in the domain model)
    halfLifeHours: fragment.halfLifeHours ?? 0,
    embeddingStatus: status,
    vector,
  };
}

function rowToFragment(row: Record<string, unknown>): MemoryFragment {
  const status = (rowStr(row.embeddingStatus) || "none") as EmbeddingStatus;
  const halfLife = rowNum(row.halfLifeHours);
  return {
    id: rowStr(row.id),
    sessionId: rowStr(row.sessionId),
    agentId: rowStr(row.agentId),
    backendType: (rowStr(row.backendType) || "claude") as BackendType,
    timestamp: rowNum(row.timestamp),
    type: (rowStr(row.type) || "observation") as MemoryType,
    content: rowStr(row.content),
    gitContext: JSON.parse(rowStr(row.gitContextJson) || "{}") as GitContext,
    references: JSON.parse(rowStr(row.referencesJson) || "[]") as string[],
    tags: JSON.parse(rowStr(row.tagsJson) || "[]") as string[],
    confidence: rowNum(row.confidence),
    consolidatedInto: rowStr(row.consolidatedInto) || undefined,
    isConsolidated: row.isConsolidated === true,
    embedding: status === "ok" ? toNumberArray(row.vector) : undefined,
    namespace: rowStr(row.namespace),
    repoRootHash: rowStr(row.repoRootHash),
    lastReinforcedAt: rowNum(row.lastReinforcedAt) || rowNum(row.timestamp),
    accessCount: rowNum(row.accessCount),
    pinned: row.pinned === true,
    halfLifeHours: halfLife > 0 ? halfLife : null,
    embeddingStatus: status,
  };
}

function rowToConsolidated(row: Record<string, unknown>): ConsolidatedKnowledge {
  return {
    id: rowStr(row.id),
    tag: rowStr(row.tag),
    summary: rowStr(row.summary),
    sourceFragments: JSON.parse(rowStr(row.sourceFragmentsJson) || "[]") as string[],
    lastUpdated: rowNum(row.lastUpdated),
    confidence: rowNum(row.confidence),
    repoRoot: rowStr(row.repoRoot),
    namespace: rowStr(row.namespace),
    type: (rowStr(row.knowledgeType) || undefined) as KnowledgeType | undefined,
    synthesisMethod: (rowStr(row.synthesisMethod) || undefined) as SynthesisMethod | undefined,
    supersededBy: rowStr(row.supersededBy) || undefined,
  };
}

// ─── Vector math ─────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function zeros(dim: number): number[] {
  return Array(dim).fill(0) as number[];
}

// ─── storeFragment ───────────────────────────────────────────────────────────

export interface StoreFragmentOptions {
  sessionId: string;
  agentId: string;
  backendType: BackendType;
  type: MemoryType;
  content: string;
  gitContext: GitContext;
  tags?: string[];
  confidence?: number;
  references?: string[];
  /** v2: explicit target namespace. Default: repo:<hash> when a repoRoot is present, else session:<id>. */
  namespace?: string;
  pinned?: boolean;
  /** Per-fragment half-life override in hours (null/omitted = namespace policy). */
  halfLifeHours?: number | null;
}

/**
 * Store a new memory fragment. Generates an embedding at write time.
 *
 * §1.6 fix: no zero-vector pollution — when the provider is "none" the row is
 * stored with embeddingStatus "none"; when an embed call fails (or the dim
 * mismatches mid-migration) it is stored "pending" and picked up by the lazy
 * re-embed queue. Both states are excluded from ANN by where() (§3.3).
 */
export async function storeFragment(opts: StoreFragmentOptions): Promise<MemoryFragment> {
  const repoRoot = opts.gitContext.repoRoot ?? "";
  const namespace =
    opts.namespace ?? (repoRoot ? repoNamespace(repoRoot) : sessionNamespace(opts.sessionId));
  const now = Date.now();
  const fragment: MemoryFragment = {
    id: randomUUID(),
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    backendType: opts.backendType,
    timestamp: now,
    type: opts.type,
    content: opts.content,
    gitContext: opts.gitContext,
    references: opts.references ?? [],
    confidence: opts.confidence ?? 0.7,
    tags: opts.tags ?? [],
    isConsolidated: false,
    namespace,
    repoRootHash: repoRoot ? hashRepoRoot(repoRoot) : "",
    lastReinforcedAt: now,
    accessCount: 0,
    pinned: opts.pinned ?? false,
    halfLifeHours: opts.halfLifeHours ?? null,
  };

  const embedding = await embed(opts.content);
  const state = await getState();
  const dim = state.meta.dim;

  let status: EmbeddingStatus;
  let vector: number[];
  if (embedding && embedding.length === dim) {
    status = "ok";
    vector = embedding;
  } else if (getEmbeddingDim() === null) {
    status = "none";
    vector = zeros(dim);
  } else {
    status = "pending";
    vector = zeros(dim);
  }
  fragment.embeddingStatus = status;
  if (status === "ok") fragment.embedding = embedding as number[];

  await state.fragments.add([fragmentToRow(fragment, vector, status)]);
  return fragment;
}

// ─── Scored retrieval (§3.3) ─────────────────────────────────────────────────

export interface RecallPlanEntry {
  namespace: string;
  depth: number;
}

export interface ScoredFragment {
  fragment: MemoryFragment;
  /** Composite score: simNorm^1.5 × w(t) × confidence. */
  score: number;
  /** Decayed weight w(t) at recall time. */
  weight: number;
  /** Normalized similarity (1 when retrieval had no query vector). */
  simNorm: number;
}

function scoreRow(
  row: Record<string, unknown>,
  queryVector: number[] | null,
  policy: DecayPolicy,
  now: number,
): ScoredFragment {
  const fragment = rowToFragment(row);
  const weight = computeDecayedWeight(fragment, now, policy);
  let simNorm = 1;
  if (queryVector) {
    simNorm = Math.max(0, cosineSimilarity(queryVector, toNumberArray(row.vector)));
  }
  const score = Math.pow(simNorm, SIM_EXPONENT) * weight * fragment.confidence;
  return { fragment, score, weight, simNorm };
}

/** Near-duplicate dedupe: cosine > 0.97 (or identical content) keeps the higher score. */
function dedupeNearDuplicates(scored: ScoredFragment[]): ScoredFragment[] {
  const kept: ScoredFragment[] = [];
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  for (const candidate of sorted) {
    const isDup = kept.some((existing) => {
      if (existing.fragment.content === candidate.fragment.content) return true;
      const a = existing.fragment.embedding;
      const b = candidate.fragment.embedding;
      if (!a || !b) return false;
      return cosineSimilarity(a, b) > NEAR_DUP_COSINE;
    });
    if (!isDup) kept.push(candidate);
  }
  return kept;
}

/**
 * Per-namespace scored search (§3.3). For each namespace: pushed-down
 * where("namespace = ... AND embeddingStatus = 'ok'"), limit depth×4, composite
 * scoring in TS, top-depth per namespace, merged + near-dup deduped.
 *
 * No-embedding fallback: metadata scan per namespace ranked by w(t)×confidence.
 */
export async function queryScoredFragments(
  queryText: string,
  plan: RecallPlanEntry[],
  now: number = Date.now(),
): Promise<ScoredFragment[]> {
  const state = await getState();
  const queryVector = await embed(queryText);
  const useVector = !!queryVector && queryVector.length === state.meta.dim;
  const merged: ScoredFragment[] = [];

  for (const entry of plan) {
    if (entry.depth <= 0) continue;
    const policy = policyForNamespace(entry.namespace);
    let rows: Record<string, unknown>[];
    if (useVector) {
      rows = (await state.fragments
        .search(queryVector as number[])
        .where(buildNamespaceWhere(entry.namespace, true))
        .limit(entry.depth * 4)
        .toArray()) as unknown as Record<string, unknown>[];
    } else {
      rows = (await state.fragments
        .query()
        .where(buildNamespaceWhere(entry.namespace, false))
        .limit(1000)
        .toArray()) as unknown as Record<string, unknown>[];
    }
    const scored = rows
      .map((row) => scoreRow(row, useVector ? (queryVector as number[]) : null, policy, now))
      .sort((a, b) => b.score - a.score)
      .slice(0, entry.depth);
    merged.push(...scored);
  }

  return dedupeNearDuplicates(merged).sort((a, b) => b.score - a.score);
}

/**
 * Semantic similarity search over stored fragments (legacy-compatible API).
 *
 * v2: metadata filters (repoRoot/sessionId/type/namespace) are pushed down
 * into LanceDB where() instead of post-hoc JS filtering (§1.7 fix), and
 * results are ranked by the composite score simNorm^1.5 × w(t) × confidence.
 * Without a provider, falls back to a metadata scan ranked by w(t)×confidence.
 */
export async function queryFragments(
  query: string,
  options: MemoryQueryOptions = {},
): Promise<MemoryFragment[]> {
  const { limit = 10, repoRoot, tags, type, sessionId, namespace } = options;
  const state = await getState();
  const now = Date.now();
  const queryVector = await embed(query);
  const useVector = !!queryVector && queryVector.length === state.meta.dim;

  const conds: string[] = [];
  if (namespace) conds.push(`namespace = ${sqlQuote(namespace)}`);
  if (repoRoot) conds.push(`repoRootHash = ${sqlQuote(hashRepoRoot(repoRoot))}`);
  if (sessionId) conds.push(`sessionId = ${sqlQuote(sessionId)}`);
  if (type) conds.push(`type = ${sqlQuote(type)}`);

  let rows: Record<string, unknown>[];
  if (useVector) {
    conds.push("embeddingStatus = 'ok'");
    rows = (await state.fragments
      .search(queryVector as number[])
      .where(conds.join(" AND "))
      .limit(limit * 4)
      .toArray()) as unknown as Record<string, unknown>[];
  } else {
    let q = state.fragments.query();
    if (conds.length > 0) q = q.where(conds.join(" AND "));
    rows = (await q.limit(2000).toArray()) as unknown as Record<string, unknown>[];
  }

  let scored = rows.map((row) => {
    const ns = rowStr(row.namespace);
    return scoreRow(row, useVector ? (queryVector as number[]) : null, policyForNamespace(ns), now);
  });

  // Tags live in a JSON column — post-filter only this one.
  if (tags && tags.length > 0) {
    scored = scored.filter((s) => {
      const fragTags = new Set(s.fragment.tags);
      return tags.some((t) => fragTags.has(t));
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fragment);
}

/**
 * Retrieve all fragments for a session (used during consolidation).
 * v2: sessionId filter pushed down into where().
 */
export async function getSessionFragments(sessionId: string): Promise<MemoryFragment[]> {
  const state = await getState();
  const rows = (await state.fragments
    .query()
    .where(`sessionId = ${sqlQuote(sessionId)}`)
    .limit(10000)
    .toArray()) as unknown as Record<string, unknown>[];
  return rows.map(rowToFragment);
}

// ─── Reinforcement (§3.2) ────────────────────────────────────────────────────

const _pendingReinforce = {
  fragments: new Map<string, number>(),
  knowledge: new Map<string, number>(),
};
let _reinforceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReinforceFlush(): void {
  if (_reinforceTimer) return;
  _reinforceTimer = setTimeout(() => {
    flushReinforcements().catch((err) => console.warn("[memory] reinforcement flush failed:", err));
  }, REINFORCE_DEBOUNCE_MS);
  _reinforceTimer.unref?.();
}

/**
 * Reinforce fragments that were *actually used* (included in an enrichment
 * block or explicitly returned by memory_query): accessCount += 1 and
 * lastReinforcedAt = now. Writes are debounced/batched; the reinforcement cap
 * (×multiplier at most 8 times) is applied at read time in computeDecayedWeight.
 */
export function reinforceFragments(ids: string[]): void {
  for (const id of ids) {
    _pendingReinforce.fragments.set(id, (_pendingReinforce.fragments.get(id) ?? 0) + 1);
  }
  if (ids.length > 0) scheduleReinforceFlush();
}

/** Same as reinforceFragments but for consolidated knowledge rows. */
export function reinforceKnowledge(ids: string[]): void {
  for (const id of ids) {
    _pendingReinforce.knowledge.set(id, (_pendingReinforce.knowledge.get(id) ?? 0) + 1);
  }
  if (ids.length > 0) scheduleReinforceFlush();
}

async function applyReinforcements(
  table: LanceTable,
  pending: Map<string, number>,
  now: number,
): Promise<void> {
  if (pending.size === 0) return;
  const ids = [...pending.keys()];
  const rows = (await table
    .query()
    .where(`id IN (${ids.map(sqlQuote).join(", ")})`)
    .limit(ids.length)
    .toArray()) as unknown as Record<string, unknown>[];
  for (const row of rows) {
    const id = rowStr(row.id);
    const inc = pending.get(id) ?? 0;
    if (inc <= 0) continue;
    await table.update({
      where: `id = ${sqlQuote(id)}`,
      values: { accessCount: rowNum(row.accessCount) + inc, lastReinforcedAt: now },
    });
  }
}

/** Force the debounced reinforcement batch to write now (tests / shutdown). */
export async function flushReinforcements(): Promise<void> {
  if (_reinforceTimer) {
    clearTimeout(_reinforceTimer);
    _reinforceTimer = null;
  }
  const fragmentBatch = new Map(_pendingReinforce.fragments);
  const knowledgeBatch = new Map(_pendingReinforce.knowledge);
  _pendingReinforce.fragments.clear();
  _pendingReinforce.knowledge.clear();
  if (fragmentBatch.size === 0 && knowledgeBatch.size === 0) return;
  const state = await getState();
  const now = Date.now();
  await applyReinforcements(state.fragments, fragmentBatch, now);
  await applyReinforcements(state.consolidated, knowledgeBatch, now);
}

/** Pin/unpin a fragment. Pinned rows never decay and are never evicted. */
export async function setFragmentPinned(id: string, pinned: boolean): Promise<boolean> {
  const state = await getState();
  const exists = (await state.fragments.countRows(`id = ${sqlQuote(id)}`)) > 0;
  if (!exists) return false;
  await state.fragments.update({ where: `id = ${sqlQuote(id)}`, values: { pinned } });
  return true;
}

// ─── Eviction sweep (§3.2) ───────────────────────────────────────────────────

export interface EvictionSweepOptions {
  now?: number;
  perNamespaceCap?: number;
  weightThreshold?: number;
}

export interface EvictionSweepResult {
  /** Consolidated, unpinned fragments deleted because w(t) < threshold. */
  decayedDeleted: number;
  /** Fragments evicted by the per-namespace hard cap (lowest-w first). */
  capEvicted: number;
}

async function deleteFragmentIds(table: LanceTable, ids: string[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await table.delete(`id IN (${chunk.map(sqlQuote).join(", ")})`);
  }
}

/**
 * Eviction sweep (runs hourly):
 *  - w(t) < threshold AND unpinned AND isConsolidated → delete (essence lives
 *    in the consolidated table).
 *  - Un-consolidated low-w fragments are left alone — consolidation drops
 *    them, never a silent delete.
 *  - Per-namespace hard cap (default 5000) with lowest-w eviction as backstop.
 *  - Pinned rows are never evicted.
 */
export async function runEvictionSweep(opts: EvictionSweepOptions = {}): Promise<EvictionSweepResult> {
  const now = opts.now ?? Date.now();
  const cap = opts.perNamespaceCap ?? NAMESPACE_HARD_CAP;
  const threshold = opts.weightThreshold ?? EVICTION_WEIGHT_THRESHOLD;
  const state = await getState();

  const rows = (await state.fragments.query().limit(200000).toArray()) as unknown as Record<
    string,
    unknown
  >[];

  const byNamespace = new Map<string, Array<{ id: string; weight: number; pinned: boolean; consolidated: boolean }>>();
  for (const row of rows) {
    const ns = rowStr(row.namespace) || "global";
    const fragment = rowToFragment(row);
    const weight = computeDecayedWeight(fragment, now, policyForNamespace(ns));
    const list = byNamespace.get(ns) ?? [];
    list.push({
      id: fragment.id,
      weight,
      pinned: fragment.pinned === true,
      consolidated: fragment.isConsolidated,
    });
    byNamespace.set(ns, list);
  }

  const decayedIds: string[] = [];
  const capIds: string[] = [];
  for (const [, list] of byNamespace) {
    const remaining: typeof list = [];
    for (const item of list) {
      if (!item.pinned && item.consolidated && item.weight < threshold) {
        decayedIds.push(item.id);
      } else {
        remaining.push(item);
      }
    }
    if (remaining.length > cap) {
      const evictable = remaining.filter((i) => !i.pinned).sort((a, b) => a.weight - b.weight);
      const overflow = remaining.length - cap;
      for (const item of evictable.slice(0, overflow)) capIds.push(item.id);
    }
  }

  if (decayedIds.length > 0) await deleteFragmentIds(state.fragments, decayedIds);
  if (capIds.length > 0) await deleteFragmentIds(state.fragments, capIds);
  return { decayedDeleted: decayedIds.length, capEvicted: capIds.length };
}

// ─── Lazy re-embed queue (§3.5) ──────────────────────────────────────────────

/**
 * Re-embed up to `maxItems` rows with embeddingStatus = "pending" (fragments
 * first, then consolidated knowledge). Called at ≤ 2 req/s by the maintenance
 * timer whenever a real provider is configured; also directly callable.
 * Returns the number of rows re-embedded.
 */
export async function processReembedBatch(maxItems = 2): Promise<number> {
  if (getEmbeddingDim() === null) return 0; // no provider — nothing to do
  const state = await getState();
  let processed = 0;

  for (const table of [state.fragments, state.consolidated]) {
    if (processed >= maxItems) break;
    const rows = (await table
      .query()
      .where("embeddingStatus = 'pending'")
      .limit(maxItems - processed)
      .toArray()) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      const id = rowStr(row.id);
      const text = rowStr(row.content) || rowStr(row.summary);
      if (!text) {
        // Nothing to embed — flip to "none" so we don't retry forever.
        await table.update({ where: `id = ${sqlQuote(id)}`, values: { embeddingStatus: "none" } });
        continue;
      }
      const vector = await embed(text);
      if (!vector || vector.length !== state.meta.dim) return processed; // provider failing — retry next tick
      await table.update({
        where: `id = ${sqlQuote(id)}`,
        values: { vector, embeddingStatus: "ok" },
      });
      processed++;
    }
  }
  return processed;
}

// ─── Maintenance timers ──────────────────────────────────────────────────────

let _sweepTimer: ReturnType<typeof setInterval> | null = null;
let _reembedTimer: ReturnType<typeof setInterval> | null = null;

function ensureMaintenanceTimers(): void {
  // Tests drive sweeps/re-embeds explicitly — background timers would make
  // row states flip mid-assertion.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (!_sweepTimer) {
    _sweepTimer = setInterval(() => {
      runEvictionSweep().catch((err) => console.warn("[memory] eviction sweep failed:", err));
    }, SWEEP_INTERVAL_MS);
    _sweepTimer.unref?.();
  }
  if (!_reembedTimer) {
    _reembedTimer = setInterval(() => {
      processReembedBatch(2).catch((err) => console.warn("[memory] re-embed batch failed:", err));
    }, REEMBED_INTERVAL_MS);
    _reembedTimer.unref?.();
  }
}

/** Stop background maintenance timers (shutdown / tests). */
export function stopMemoryMaintenance(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
  if (_reembedTimer) {
    clearInterval(_reembedTimer);
    _reembedTimer = null;
  }
}

// ─── Consolidated knowledge retrieval ────────────────────────────────────────

/**
 * Active (non-superseded) consolidated knowledge for a namespace, optionally
 * filtered by tag, ranked by confidence then recency.
 */
export async function getKnowledgeByNamespace(
  namespace: string,
  tag?: string,
): Promise<ConsolidatedKnowledge[]> {
  const state = await getState();
  const conds = [`namespace = ${sqlQuote(namespace)}`, "supersededBy = ''"];
  if (tag) conds.push(`tag = ${sqlQuote(tag)}`);
  const rows = (await state.consolidated
    .query()
    .where(conds.join(" AND "))
    .limit(1000)
    .toArray()) as unknown as Record<string, unknown>[];
  return rows
    .map(rowToConsolidated)
    .sort((a, b) => b.confidence - a.confidence || b.lastUpdated - a.lastUpdated);
}

/**
 * Retrieve consolidated knowledge for a repo, optionally filtered by tag
 * (legacy-compatible API).
 *
 * v2 behavior change (§1.8 fix): repoRoot === "" now means the `global`
 * namespace instead of matching literally-empty repoRoot rows, so existing
 * callers that pass "" get cross-repo knowledge rather than nothing.
 */
export async function getConsolidatedKnowledge(
  repoRoot: string,
  tag?: string,
): Promise<ConsolidatedKnowledge[]> {
  const namespace = repoRoot ? repoNamespace(repoRoot) : "global";
  return getKnowledgeByNamespace(namespace, tag);
}

// ─── Consolidation support APIs (§3.4 Stage 1/3) ─────────────────────────────

/**
 * Un-consolidated fragments for a namespace (e.g. "session:abc", "repo:<hash>")
 * or a bare session id, newest first. Embeddings are included (when status is
 * "ok") so Stage-1 JUDGE can cluster/dedupe without re-embedding.
 */
export async function getUnconsolidatedFragments(
  namespaceOrSessionId: string,
  limit = 200,
): Promise<MemoryFragment[]> {
  const state = await getState();
  const scopeCond = isNamespaceString(namespaceOrSessionId)
    ? `namespace = ${sqlQuote(namespaceOrSessionId)}`
    : `sessionId = ${sqlQuote(namespaceOrSessionId)}`;
  const rows = (await state.fragments
    .query()
    .where(`${scopeCond} AND isConsolidated = false`)
    .limit(10000)
    .toArray()) as unknown as Record<string, unknown>[];
  return rows
    .map(rowToFragment)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

/**
 * Mark source fragments as consolidated into a knowledge row (§1.2 fix —
 * makes isConsolidated/consolidatedInto live state).
 */
export async function markFragmentsConsolidated(ids: string[], knowledgeId: string): Promise<void> {
  if (ids.length === 0) return;
  const state = await getState();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await state.fragments.update({
      where: `id IN (${chunk.map(sqlQuote).join(", ")})`,
      values: { isConsolidated: true, consolidatedInto: knowledgeId },
    });
  }
}

export interface DistilledKnowledgeItem {
  tag: string;
  type?: KnowledgeType;
  summary: string;
  confidence: number;
  sourceFragmentIds: string[];
  /** Existing knowledge ids this item replaces (tombstoned with supersededBy). */
  supersedes?: string[];
  /** Namespace class from the distillation output ("repo" | "global" | "agent") or a full namespace string. */
  namespace: string;
}

export interface DistillationContext {
  sessionId: string;
  repoRoot: string;
  backendType: string;
  /** Defaults to "llm"; the concat fallback passes "concat". */
  synthesisMethod?: SynthesisMethod;
}

function resolveKnowledgeNamespace(nsField: string, ctx: DistillationContext): string {
  if (isNamespaceString(nsField)) return nsField;
  if (nsField === "repo") return ctx.repoRoot ? repoNamespace(ctx.repoRoot) : "global";
  if (nsField === "agent") return agentNamespace(ctx.backendType);
  if (nsField === "session") return sessionNamespace(ctx.sessionId);
  return "global";
}

/**
 * Stage-3 CONSOLIDATE (§3.4): upsert distilled knowledge by (namespace, tag).
 *  - Any active row with the same (namespace, tag), plus any rows named in
 *    `supersedes`, is tombstoned with supersededBy = <new id> (audit trail).
 *  - The new summary is embedded (status "pending" if that fails/no provider).
 *  - All sourceFragmentIds are marked consolidated into the new row.
 * Idempotent: re-running with the same (namespace, tag) replaces, never duplicates.
 */
export async function upsertKnowledgeFromDistillation(
  items: DistilledKnowledgeItem[],
  ctx: DistillationContext,
): Promise<ConsolidatedKnowledge[]> {
  const state = await getState();
  const dim = state.meta.dim;
  const results: ConsolidatedKnowledge[] = [];
  const synthesisMethod: SynthesisMethod = ctx.synthesisMethod ?? "llm";

  for (const item of items) {
    const namespace = resolveKnowledgeNamespace(item.namespace, ctx);
    const cls = namespaceClass(namespace);
    const repoRoot = cls === "repo" ? ctx.repoRoot : "";
    const newId = randomUUID();
    const now = Date.now();

    // Tombstone: same (namespace, tag) active rows + explicit supersedes list.
    await state.consolidated.update({
      where: `namespace = ${sqlQuote(namespace)} AND tag = ${sqlQuote(item.tag)} AND supersededBy = ''`,
      values: { supersededBy: newId },
    });
    const supersedes = (item.supersedes ?? []).filter(Boolean);
    if (supersedes.length > 0) {
      await state.consolidated.update({
        where: `id IN (${supersedes.map(sqlQuote).join(", ")})`,
        values: { supersededBy: newId },
      });
    }

    const embedding = await embed(item.summary);
    let status: EmbeddingStatus;
    let vector: number[];
    if (embedding && embedding.length === dim) {
      status = "ok";
      vector = embedding;
    } else if (getEmbeddingDim() === null) {
      status = "none";
      vector = zeros(dim);
    } else {
      status = "pending";
      vector = zeros(dim);
    }

    await state.consolidated.add([
      {
        id: newId,
        tag: item.tag,
        summary: item.summary,
        sourceFragmentsJson: JSON.stringify(item.sourceFragmentIds),
        lastUpdated: now,
        confidence: item.confidence,
        repoRoot,
        namespace,
        repoRootHash: repoRoot ? hashRepoRoot(repoRoot) : "",
        knowledgeType: item.type ?? "",
        synthesisMethod,
        supersededBy: "",
        accessCount: 0,
        lastReinforcedAt: now,
        embeddingStatus: status,
        vector,
      },
    ]);

    await markFragmentsConsolidated(item.sourceFragmentIds, newId);

    results.push({
      id: newId,
      tag: item.tag,
      summary: item.summary,
      sourceFragments: item.sourceFragmentIds,
      lastUpdated: now,
      confidence: item.confidence,
      repoRoot,
      namespace,
      type: item.type,
      synthesisMethod,
      supersededBy: undefined,
    });
  }

  return results;
}

/**
 * Active knowledge in a namespace whose embedding is within `threshold`
 * cosine similarity of a centroid (§3.4 Stage 2 — `existingKnowledge` input).
 * Accepts a precomputed centroid vector or texts to embed-and-average.
 * Returns [] when no provider/vectors are available.
 */
export async function findRelatedKnowledge(
  namespace: string,
  centroidVectorOrTexts: number[] | string[],
  threshold = 0.8,
): Promise<ConsolidatedKnowledge[]> {
  const state = await getState();
  if (centroidVectorOrTexts.length === 0) return [];

  let centroid: number[] | null = null;
  if (typeof centroidVectorOrTexts[0] === "number") {
    centroid = centroidVectorOrTexts as number[];
  } else {
    const vectors: number[][] = [];
    for (const text of centroidVectorOrTexts as string[]) {
      const v = await embed(text);
      if (v && v.length === state.meta.dim) vectors.push(v);
    }
    if (vectors.length > 0) {
      centroid = zeros(state.meta.dim);
      for (const v of vectors) for (let i = 0; i < v.length; i++) centroid[i] += v[i];
      for (let i = 0; i < centroid.length; i++) centroid[i] /= vectors.length;
    }
  }
  if (!centroid || centroid.length !== state.meta.dim) return [];

  const rows = (await state.consolidated
    .search(centroid)
    .where(`namespace = ${sqlQuote(namespace)} AND supersededBy = '' AND embeddingStatus = 'ok'`)
    .limit(50)
    .toArray()) as unknown as Record<string, unknown>[];
  return rows
    .filter((row) => cosineSimilarity(centroid as number[], toNumberArray(row.vector)) >= threshold)
    .map(rowToConsolidated);
}

/**
 * No-LLM consolidation fallback: today's concatenation synthesis, grouped by
 * tag, upserted by (namespace, tag) with synthesisMethod = "concat" and all
 * sources marked consolidated. Used when no OpenRouter key is configured or
 * when distillation output fails validation (§3.4).
 */
export async function concatFallbackConsolidate(
  sessionId: string,
  repoRoot: string,
  backendType = "claude",
): Promise<ConsolidatedKnowledge[]> {
  const fragments = await getUnconsolidatedFragments(sessionId, 10000);
  if (fragments.length === 0) return [];

  const byTag = new Map<string, MemoryFragment[]>();
  for (const f of fragments) {
    for (const tag of f.tags.length > 0 ? f.tags : ["general"]) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(f);
    }
  }

  const items: DistilledKnowledgeItem[] = [];
  for (const [tag, tagFragments] of byTag) {
    const avgConfidence =
      tagFragments.reduce((s, f) => s + f.confidence, 0) / tagFragments.length;
    items.push({
      tag,
      summary: synthesize(tag, tagFragments),
      confidence: avgConfidence,
      sourceFragmentIds: tagFragments.map((f) => f.id),
      namespace: repoRoot ? "repo" : "global",
    });
  }

  return upsertKnowledgeFromDistillation(items, {
    sessionId,
    repoRoot,
    backendType,
    synthesisMethod: "concat",
  });
}

/**
 * Consolidate episodic fragments from a session into semantic knowledge
 * (legacy-compatible API — routes to the v2 concat fallback).
 *
 * v2 (§1.2 fix): idempotent — upserts by (namespace, tag), tombstones the
 * replaced rows, and marks source fragments isConsolidated/consolidatedInto.
 * Running twice no longer duplicates rows (the second run sees no
 * un-consolidated fragments and returns []).
 */
export async function consolidateSession(
  sessionId: string,
  repoRoot: string,
): Promise<ConsolidatedKnowledge[]> {
  return concatFallbackConsolidate(sessionId, repoRoot);
}

// ─── Enrichment entry point (§3.3 + §3.6.2) ──────────────────────────────────

export interface EnrichmentQueryOptions {
  sessionId: string;
  repoRoot: string;
  backendType: string;
  queryText: string;
}

export interface EnrichmentResult {
  items: MemoryEnrichmentItem[];
  /** Injectable block per §3.6.2, or null when nothing was recalled. */
  block: string | null;
}

const ENRICHMENT_HEADER = "--- Campfire memory (auto-recalled; may be stale) ---";
const ENRICHMENT_FOOTER = "--- end memory ---";
const LINE_CLIP_CHARS = 300;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Query memory for prompt enrichment. Namespace recall order per §3.6.2:
 * fragments query [repo:<hash>, agent:<backend>, global] — NOT session:<id>,
 * since same-session context is already in the agent's own conversation.
 * Consolidated knowledge (same namespaces) is ranked above fragments.
 *
 * Budgets: ≤ ~1200 chars of fragment text, ≤ ~2000 chars total, max 5
 * fragment lines. Every included row is reinforced (§3.2). Returns the exact
 * injectable block plus the item list for the UI `memory_enriched` chip.
 */
export async function queryForEnrichment(opts: EnrichmentQueryOptions): Promise<EnrichmentResult> {
  const depths = getMemorySettings().recallDepth;
  const now = Date.now();
  const nsRepo = opts.repoRoot ? repoNamespace(opts.repoRoot) : null;
  const nsAgent = agentNamespace(opts.backendType);

  // Consolidated knowledge, priority order: repo → agent → global.
  const knowledgeNamespaces = [nsRepo, nsAgent, "global"].filter((n): n is string => !!n);
  const knowledgeCandidates: ConsolidatedKnowledge[] = [];
  for (const ns of knowledgeNamespaces) {
    knowledgeCandidates.push(...(await getKnowledgeByNamespace(ns)));
  }

  // Fragments: repo/agent/global with per-namespace recall depths (§3.1).
  const plan: RecallPlanEntry[] = [];
  if (nsRepo) plan.push({ namespace: nsRepo, depth: depths.repo });
  plan.push({ namespace: nsAgent, depth: depths.agent });
  plan.push({ namespace: "global", depth: depths.global });
  const scoredFragments = await queryScoredFragments(opts.queryText, plan, now);

  // Assemble under budgets. Header/footer + section labels count toward total.
  const items: MemoryEnrichmentItem[] = [];
  const knowledgeLines: string[] = [];
  const fragmentLines: string[] = [];
  const baseOverhead =
    ENRICHMENT_HEADER.length + ENRICHMENT_FOOTER.length + "Knowledge:".length + "Notes:".length + 4;
  let totalChars = baseOverhead;

  for (const k of knowledgeCandidates) {
    const line = `- [${k.tag}] ${clip(k.summary, LINE_CLIP_CHARS)}`;
    if (totalChars + line.length + 1 > TOTAL_BUDGET_CHARS) break;
    knowledgeLines.push(line);
    totalChars += line.length + 1;
    items.push({
      id: k.id,
      kind: "knowledge",
      namespace: k.namespace ?? "",
      summary: k.summary,
      tag: k.tag,
      weight: 1, // consolidated knowledge does not decay (§3.2)
    });
  }

  let fragmentChars = 0;
  for (const s of scoredFragments) {
    if (fragmentLines.length >= MAX_ENRICHMENT_FRAGMENTS) break;
    if (s.score <= 0) continue;
    const line = `- [${s.fragment.type}] ${clip(s.fragment.content, LINE_CLIP_CHARS)}`;
    if (fragmentChars + line.length + 1 > FRAGMENT_BUDGET_CHARS) break;
    if (totalChars + line.length + 1 > TOTAL_BUDGET_CHARS) break;
    fragmentLines.push(line);
    fragmentChars += line.length + 1;
    totalChars += line.length + 1;
    items.push({
      id: s.fragment.id,
      kind: "fragment",
      namespace: s.fragment.namespace ?? "",
      summary: clip(s.fragment.content, LINE_CLIP_CHARS),
      tag: s.fragment.tags[0],
      weight: s.weight,
    });
  }

  if (items.length === 0) return { items: [], block: null };

  const parts: string[] = [ENRICHMENT_HEADER];
  if (knowledgeLines.length > 0) parts.push("Knowledge:", ...knowledgeLines);
  if (fragmentLines.length > 0) parts.push("Notes:", ...fragmentLines);
  parts.push(ENRICHMENT_FOOTER);

  // Reinforce exactly what was included (§3.2: inclusion reinforces, matching doesn't).
  reinforceFragments(items.filter((i) => i.kind === "fragment").map((i) => i.id));
  reinforceKnowledge(items.filter((i) => i.kind === "knowledge").map((i) => i.id));

  return { items, block: parts.join("\n") };
}

// ─── Namespace overview (UI) ─────────────────────────────────────────────────

export interface NamespaceOverviewEntry {
  namespace: string;
  count: number;
  avgWeight: number;
  pinnedCount: number;
}

/**
 * Per-namespace fragment stats for the memory panel: count, average decayed
 * weight, and pinned count, over [session:<id>, repo:<hash>, agent:<backend>, global].
 */
export async function getNamespaceOverview(opts: {
  sessionId: string;
  repoRoot: string;
  backendType: string;
}): Promise<NamespaceOverviewEntry[]> {
  const state = await getState();
  const now = Date.now();
  const namespaces = [
    sessionNamespace(opts.sessionId),
    ...(opts.repoRoot ? [repoNamespace(opts.repoRoot)] : []),
    agentNamespace(opts.backendType),
    "global",
  ];

  const overview: NamespaceOverviewEntry[] = [];
  for (const namespace of namespaces) {
    const rows = (await state.fragments
      .query()
      .where(buildNamespaceWhere(namespace, false))
      .limit(100000)
      .toArray()) as unknown as Record<string, unknown>[];
    const policy = policyForNamespace(namespace);
    let weightSum = 0;
    let pinnedCount = 0;
    for (const row of rows) {
      const fragment = rowToFragment(row);
      weightSum += computeDecayedWeight(fragment, now, policy);
      if (fragment.pinned) pinnedCount++;
    }
    overview.push({
      namespace,
      count: rows.length,
      avgWeight: rows.length > 0 ? weightSum / rows.length : 0,
      pinnedCount,
    });
  }
  return overview;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Concatenation synthesis — the no-LLM fallback (§3.4). Kept from v1; the
 * LLM distillation pipeline (memory-consolidation.ts) replaces this as the
 * primary path.
 */
function synthesize(tag: string, fragments: MemoryFragment[]): string {
  const sorted = [...fragments].sort((a, b) => b.confidence - a.confidence);
  const bullets = sorted
    .slice(0, 10)
    .map((f) => `- [${f.type}] ${f.content}`)
    .join("\n");
  return `Knowledge about "${tag}":\n${bullets}`;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Override the memory root dir for tests — must be called before any DB access.
 * v2 note: the argument is the memory ROOT (meta.json lives here; LanceDB in
 * <dir>/lancedb), where v1 treated it as the LanceDB dir itself.
 */
export function _resetForTest(dir: string): void {
  _initPromise = null;
  _memoryRoot = dir;
  stopMemoryMaintenance();
  if (_reinforceTimer) {
    clearTimeout(_reinforceTimer);
    _reinforceTimer = null;
  }
  _pendingReinforce.fragments.clear();
  _pendingReinforce.knowledge.clear();
}
