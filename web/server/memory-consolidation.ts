/**
 * Memory consolidation pipeline — JUDGE → DISTILL → CONSOLIDATE.
 *
 * Implements docs/design/semantic-memory-v2.md §3.4 on top of the v2 store
 * (semantic-memory.ts). The exported signatures are the contract with the
 * call sites (ws-bridge / collective-intelligence) — do not change them.
 *
 * Flow per trigger (turn boundary / idle / session end / manual — all funnel
 * into consolidate() with a per-session in-flight guard):
 *
 *   1. Candidates: the session's un-consolidated fragments (all namespaces the
 *      session wrote to — the store filters by sessionId).
 *   2. JUDGE (local, cheap): drop fragments with w(t) × confidence < 0.15;
 *      drop near-duplicates within the batch (cosine > 0.97 when embeddings
 *      exist, content equality otherwise — higher judged score wins); group
 *      survivors by greedy embedding clustering at the 0.80 threshold
 *      (fragments without embeddings fall back into a single shared cluster).
 *   3. DISTILL (OpenRouter chat call, temperature 0): the fixed §3.4 prompt
 *      contract — exact system prompt, JSON user message with the cluster and
 *      `existingKnowledge` (active rows within 0.80 of the cluster centroid).
 *      Output is strictly validated against the §3.4 schema; on parse or
 *      validation failure the call is retried ONCE with the validator error
 *      appended to the conversation; a second failure degrades those fragments
 *      to the concat fallback. Budgets: ≤ 40 fragments per call and ≤ 4
 *      distillation calls per trigger (each call may retry once; clusters
 *      beyond the call budget stay un-consolidated for the next trigger).
 *   4. CONSOLIDATE: upsertKnowledgeFromDistillation() with synthesisMethod
 *      "llm" (handles upsert-by-(namespace, tag), supersession tombstones,
 *      embedding, and source marking), then markFragmentsConsolidated() for
 *      discardedFragmentIds so judged-away noise never re-triggers.
 *
 * Degraded mode: no OpenRouter API key → straight to concatFallbackConsolidate
 * (synthesisMethod "concat"); consolidation is never blocked on configuration.
 * Fire-and-forget posture: consolidate() never throws to callers — internal
 * errors are logged and reported with best-effort accounting.
 */

import { DEFAULT_OPENROUTER_MODEL, getSettings } from "./settings-manager.js";
import {
  NEAR_DUP_COSINE,
  computeDecayedWeight,
  concatFallbackConsolidate,
  findRelatedKnowledge,
  getUnconsolidatedFragments,
  markFragmentsConsolidated,
  policyForNamespace,
  repoNamespace,
  upsertKnowledgeFromDistillation,
  type ConsolidatedKnowledge,
  type DistilledKnowledgeItem,
  type KnowledgeType,
  type MemoryFragment,
} from "./semantic-memory.js";

export type ConsolidationReason = "turn_boundary" | "idle" | "session_end" | "manual";

export interface ConsolidationContext {
  sessionId: string;
  repoRoot: string;
  backendType: string;
  reason: ConsolidationReason;
}

export interface ConsolidationResult {
  status: "ran" | "skipped" | "in_flight";
  synthesisMethod: "llm" | "concat" | "none";
  knowledgeUpserted: number;
  fragmentsConsolidated: number;
  reason: ConsolidationReason;
}

// ─── Tunables (§3.4) ─────────────────────────────────────────────────────────

/** Turn-boundary trigger: consolidate when ≥ this many un-consolidated fragments exist. */
export const TURN_CONSOLIDATION_THRESHOLD = 8;
/** JUDGE floor: fragments with w(t) × confidence below this are dropped. */
export const JUDGE_MIN_WEIGHTED_CONFIDENCE = 0.15;
/** Greedy clustering threshold — also the `existingKnowledge` centroid radius. */
export const CLUSTER_SIM_THRESHOLD = 0.8;
/** Budget: max fragments per distillation call. */
export const MAX_FRAGMENTS_PER_CALL = 40;
/** Budget: max distillation calls per trigger (each may retry once on invalid output). */
export const MAX_CALLS_PER_TRIGGER = 4;
/** Idle trigger: a session inactive longer than this is consolidated. */
export const IDLE_TRIGGER_MS = 30 * 60 * 1000;

const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const DISTILL_TIMEOUT_MS = 30_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** consolidatedInto sentinel for fragments the distiller discarded (no knowledge row). */
const DISCARDED_KNOWLEDGE_ID = "discarded";

/**
 * EXACT system prompt from the §3.4 prompt contract. Do not edit without
 * updating docs/design/semantic-memory-v2.md — the doc is the source of truth.
 */
const DISTILL_SYSTEM_PROMPT =
  "You distill working notes from an AI coding session into durable knowledge for future sessions in this repository. " +
  "Output ONLY valid JSON matching the schema. Merge duplicates. Resolve contradictions by preferring later, " +
  "higher-confidence notes and say what superseded what. Discard chit-chat, transient state (branch names, " +
  "in-progress todo status), and anything true only for this one session. Each summary must be a standalone " +
  "statement useful with zero session context, ≤ 60 words.";

/** Compact schema restatement appended to retry messages so the model can self-correct. */
const SCHEMA_HINT =
  '{"knowledge":[{"tag":"kebab-case-topic","type":"pattern|decision|convention|failure|fact",' +
  '"summary":"standalone statement","confidence":0.0,"sourceFragmentIds":["uuid"],' +
  '"supersedes":["existing-knowledge-uuid"],"namespace":"repo|global|agent"}],"discardedFragmentIds":["uuid"]}';

const KNOWLEDGE_TYPES = new Set<string>(["pattern", "decision", "convention", "failure", "fact"]);
const OUTPUT_NAMESPACES = new Set<string>(["repo", "global", "agent"]);
const KEBAB_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── Small vector helpers (local — the store does not export these) ─────────

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

function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0].length;
  const out = Array(dim).fill(0) as number[];
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

// ─── Stage 1 — JUDGE (§3.4) ──────────────────────────────────────────────────

interface JudgedFragment {
  fragment: MemoryFragment;
  /** w(t) × confidence at judge time. */
  judgedScore: number;
}

/**
 * Cheap local filter: drop low-signal fragments (w(t) × confidence < 0.15)
 * and near-duplicates within the batch (cosine > 0.97 when both embeddings
 * exist; content-equality fallback otherwise). Higher judged score wins.
 * Dropped fragments are simply excluded — decay/eviction handles them later.
 */
function judgeFragments(candidates: MemoryFragment[], now: number): MemoryFragment[] {
  const weighted: JudgedFragment[] = [];
  for (const fragment of candidates) {
    const policy = policyForNamespace(fragment.namespace ?? "");
    const weight = computeDecayedWeight(fragment, now, policy);
    const judgedScore = weight * fragment.confidence;
    if (judgedScore >= JUDGE_MIN_WEIGHTED_CONFIDENCE) weighted.push({ fragment, judgedScore });
  }

  const kept: JudgedFragment[] = [];
  for (const candidate of [...weighted].sort((a, b) => b.judgedScore - a.judgedScore)) {
    const isDup = kept.some((existing) => {
      if (existing.fragment.content === candidate.fragment.content) return true;
      const a = existing.fragment.embedding;
      const b = candidate.fragment.embedding;
      if (!a || !b) return false;
      return cosineSimilarity(a, b) > NEAR_DUP_COSINE;
    });
    if (!isDup) kept.push(candidate);
  }
  return kept.map((k) => k.fragment);
}

/**
 * Greedy embedding clustering at the 0.80 threshold: each fragment joins the
 * first cluster whose running-mean centroid is within the threshold, else it
 * seeds a new cluster. Fragments without embeddings share a single fallback
 * cluster (when nothing has embeddings that is the batch — §3.4 Stage 1).
 */
function clusterFragments(fragments: MemoryFragment[]): MemoryFragment[][] {
  const clusters: Array<{ members: MemoryFragment[]; centroid: number[] }> = [];
  const noEmbedding: MemoryFragment[] = [];

  for (const fragment of fragments) {
    const vec = fragment.embedding;
    if (!vec || vec.length === 0) {
      noEmbedding.push(fragment);
      continue;
    }
    let placed = false;
    for (const cluster of clusters) {
      if (cosineSimilarity(vec, cluster.centroid) >= CLUSTER_SIM_THRESHOLD) {
        cluster.members.push(fragment);
        const n = cluster.members.length;
        for (let i = 0; i < cluster.centroid.length; i++) {
          cluster.centroid[i] = (cluster.centroid[i] * (n - 1) + vec[i]) / n;
        }
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ members: [fragment], centroid: [...vec] });
  }

  const out = clusters.map((c) => c.members);
  if (noEmbedding.length > 0) out.push(noEmbedding);
  return out;
}

// ─── Stage 2 — DISTILL: strict output validation (§3.4 schema) ───────────────

interface DistillationOutput {
  knowledge: DistilledKnowledgeItem[];
  discardedFragmentIds: string[];
}

type ValidationResult = { ok: true; value: DistillationOutput } | { ok: false; error: string };

/** Strip a single fenced code block (``` / ```json) around the payload, if present. */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

/**
 * Hand-rolled strict validator for the §3.4 output schema. All fragment ids
 * must come from the input cluster and all `supersedes` ids from the
 * `existingKnowledge` we offered — the model may not touch rows it wasn't shown.
 */
export function validateDistillationOutput(
  raw: string,
  clusterIds: ReadonlySet<string>,
  existingKnowledgeIds: ReadonlySet<string>,
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch (err) {
    return {
      ok: false,
      error: `output is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "top-level output must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.knowledge)) {
    return { ok: false, error: '"knowledge" must be an array' };
  }
  if (!Array.isArray(obj.discardedFragmentIds)) {
    return { ok: false, error: '"discardedFragmentIds" must be an array' };
  }

  const discarded: string[] = [];
  for (const id of obj.discardedFragmentIds as unknown[]) {
    if (typeof id !== "string") {
      return { ok: false, error: '"discardedFragmentIds" entries must be strings' };
    }
    if (!clusterIds.has(id)) {
      return {
        ok: false,
        error: `discardedFragmentIds contains "${id}" which is not a fragment id from the input cluster`,
      };
    }
    discarded.push(id);
  }

  const items: DistilledKnowledgeItem[] = [];
  const rawItems = obj.knowledge as unknown[];
  for (let i = 0; i < rawItems.length; i++) {
    const where = `knowledge[${i}]`;
    const rawItem = rawItems[i];
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.tag !== "string" || !KEBAB_TAG_RE.test(item.tag)) {
      return { ok: false, error: `${where}.tag must be a kebab-case string (e.g. "auth-tokens")` };
    }
    if (typeof item.type !== "string" || !KNOWLEDGE_TYPES.has(item.type)) {
      return { ok: false, error: `${where}.type must be one of pattern|decision|convention|failure|fact` };
    }
    if (typeof item.summary !== "string" || item.summary.trim() === "") {
      return { ok: false, error: `${where}.summary must be a non-empty string` };
    }
    if (
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      return { ok: false, error: `${where}.confidence must be a number between 0 and 1` };
    }
    if (!Array.isArray(item.sourceFragmentIds)) {
      return { ok: false, error: `${where}.sourceFragmentIds must be an array of fragment ids` };
    }
    const sourceIds: string[] = [];
    for (const id of item.sourceFragmentIds as unknown[]) {
      if (typeof id !== "string") {
        return { ok: false, error: `${where}.sourceFragmentIds entries must be strings` };
      }
      if (!clusterIds.has(id)) {
        return {
          ok: false,
          error: `${where}.sourceFragmentIds contains "${id}" which is not a fragment id from the input cluster`,
        };
      }
      sourceIds.push(id);
    }
    let supersedes: string[] | undefined;
    if (item.supersedes !== undefined) {
      if (!Array.isArray(item.supersedes)) {
        return { ok: false, error: `${where}.supersedes must be an array of existing knowledge ids` };
      }
      supersedes = [];
      for (const id of item.supersedes as unknown[]) {
        if (typeof id !== "string" || !existingKnowledgeIds.has(id)) {
          return {
            ok: false,
            error: `${where}.supersedes contains "${String(id)}" which is not an id from existingKnowledge`,
          };
        }
        supersedes.push(id);
      }
    }
    if (typeof item.namespace !== "string" || !OUTPUT_NAMESPACES.has(item.namespace)) {
      return { ok: false, error: `${where}.namespace must be one of repo|global|agent` };
    }
    items.push({
      tag: item.tag,
      type: item.type as KnowledgeType,
      summary: item.summary,
      confidence: item.confidence,
      sourceFragmentIds: sourceIds,
      supersedes,
      namespace: item.namespace,
    });
  }

  return { ok: true, value: { knowledge: items, discardedFragmentIds: discarded } };
}

// ─── Stage 2 — DISTILL: OpenRouter call (same pattern as auto-namer.ts) ──────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const maybe = item as { text?: unknown };
          return typeof maybe.text === "string" ? maybe.text : "";
        }
        return "";
      })
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

/** One OpenRouter chat completion at temperature 0. Returns the raw text or null on transport failure. */
async function callOpenRouter(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISTILL_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[memory-consolidation] OpenRouter request failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return extractTextContent(data.choices?.[0]?.message?.content);
  } catch (err) {
    console.warn("[memory-consolidation] OpenRouter request failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface DistillOutcome {
  ok: boolean;
  items: DistilledKnowledgeItem[];
  discardedFragmentIds: string[];
}

/**
 * Distill one ≤40-fragment chunk: build the §3.4 user message (cluster +
 * existingKnowledge within 0.80 of the centroid), call OpenRouter, validate
 * strictly; on failure retry ONCE with the validator error appended to the
 * conversation. Returns ok=false after the second failure (→ concat fallback).
 */
async function distillChunk(
  chunk: MemoryFragment[],
  ctx: ConsolidationContext,
  apiKey: string,
  model: string,
  now: number,
): Promise<DistillOutcome> {
  const knowledgeNamespace = ctx.repoRoot ? repoNamespace(ctx.repoRoot) : "global";
  const vectors = chunk
    .map((f) => f.embedding)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);

  let related: ConsolidatedKnowledge[] = [];
  try {
    related =
      vectors.length > 0
        ? await findRelatedKnowledge(knowledgeNamespace, meanVector(vectors), CLUSTER_SIM_THRESHOLD)
        : await findRelatedKnowledge(
            knowledgeNamespace,
            chunk.map((f) => f.content),
            CLUSTER_SIM_THRESHOLD,
          );
  } catch (err) {
    console.warn("[memory-consolidation] findRelatedKnowledge failed:", err);
  }

  // User message — the exact JSON shape from the §3.4 prompt contract.
  const userPayload = {
    repoRoot: ctx.repoRoot,
    cluster: chunk.map((f) => ({
      id: f.id,
      type: f.type,
      content: f.content,
      confidence: f.confidence,
      ageHours: Math.round(Math.max(0, now - f.timestamp) / 360_000) / 10,
      files: f.gitContext.files ?? [],
    })),
    existingKnowledge: related.map((k) => ({
      id: k.id,
      tag: k.tag,
      summary: k.summary,
      confidence: k.confidence,
    })),
  };

  const messages: ChatMessage[] = [
    { role: "system", content: DISTILL_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  const clusterIds = new Set(chunk.map((f) => f.id));
  const existingIds = new Set(related.map((k) => k.id));

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callOpenRouter(messages, apiKey, model);
    if (raw === null) {
      // Transport failure — nothing to append; one blind retry, then give up.
      if (attempt === 0) continue;
      return { ok: false, items: [], discardedFragmentIds: [] };
    }
    const validated = validateDistillationOutput(raw, clusterIds, existingIds);
    if (validated.ok) {
      return {
        ok: true,
        items: validated.value.knowledge,
        discardedFragmentIds: validated.value.discardedFragmentIds,
      };
    }
    if (attempt === 0) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your output failed validation: ${validated.error}\nRespond with ONLY valid JSON matching this schema: ${SCHEMA_HINT}`,
      });
    } else {
      console.warn(`[memory-consolidation] distillation output invalid after retry: ${validated.error}`);
    }
  }
  return { ok: false, items: [], discardedFragmentIds: [] };
}

// ─── consolidate() — the single entry point for all triggers ─────────────────

const _inFlight = new Set<string>();

function emptyResult(
  status: ConsolidationResult["status"],
  reason: ConsolidationReason,
): ConsolidationResult {
  return { status, synthesisMethod: "none", knowledgeUpserted: 0, fragmentsConsolidated: 0, reason };
}

async function runConcatFallback(
  ctx: ConsolidationContext,
  knowledgeUpserted: number,
  consolidatedIds: Set<string>,
): Promise<number> {
  const rows = await concatFallbackConsolidate(ctx.sessionId, ctx.repoRoot, ctx.backendType);
  for (const row of rows) for (const id of row.sourceFragments) consolidatedIds.add(id);
  return knowledgeUpserted + rows.length;
}

async function runConsolidation(ctx: ConsolidationContext): Promise<ConsolidationResult> {
  const candidates = await getUnconsolidatedFragments(ctx.sessionId);
  if (candidates.length === 0) return emptyResult("skipped", ctx.reason);

  const settings = getSettings();
  const apiKey = settings.openrouterApiKey.trim();
  const consolidatedIds = new Set<string>();

  // No API key → degrade to concat, never block (§3.4).
  if (!apiKey) {
    const knowledgeUpserted = await runConcatFallback(ctx, 0, consolidatedIds);
    return {
      status: "ran",
      synthesisMethod: "concat",
      knowledgeUpserted,
      fragmentsConsolidated: consolidatedIds.size,
      reason: ctx.reason,
    };
  }
  const model = settings.openrouterModel?.trim() || DEFAULT_OPENROUTER_MODEL;

  // Stage 1 — JUDGE.
  const now = Date.now();
  const survivors = judgeFragments(candidates, now);
  if (survivors.length === 0) return { ...emptyResult("ran", ctx.reason) };
  const clusters = clusterFragments(survivors);

  // Budgets: split oversized clusters into ≤40-fragment chunks, cap at 4 calls.
  const chunks: MemoryFragment[][] = [];
  for (const cluster of clusters) {
    for (let i = 0; i < cluster.length; i += MAX_FRAGMENTS_PER_CALL) {
      chunks.push(cluster.slice(i, i + MAX_FRAGMENTS_PER_CALL));
    }
  }
  const budgeted = chunks.slice(0, MAX_CALLS_PER_TRIGGER);

  // Stage 2 + 3 — DISTILL each chunk, then CONSOLIDATE its validated output.
  let knowledgeUpserted = 0;
  let anyLlmSuccess = false;
  let anyFailure = false;
  for (const chunk of budgeted) {
    const outcome = await distillChunk(chunk, ctx, apiKey, model, now);
    if (!outcome.ok) {
      anyFailure = true;
      continue;
    }
    anyLlmSuccess = true;
    if (outcome.items.length > 0) {
      const rows = await upsertKnowledgeFromDistillation(outcome.items, {
        sessionId: ctx.sessionId,
        repoRoot: ctx.repoRoot,
        backendType: ctx.backendType,
        synthesisMethod: "llm",
      });
      knowledgeUpserted += rows.length;
      for (const item of outcome.items) for (const id of item.sourceFragmentIds) consolidatedIds.add(id);
    }
    if (outcome.discardedFragmentIds.length > 0) {
      await markFragmentsConsolidated(outcome.discardedFragmentIds, DISCARDED_KNOWLEDGE_ID);
      for (const id of outcome.discardedFragmentIds) consolidatedIds.add(id);
    }
  }

  // Chunks that failed twice degrade to the concat fallback (it consolidates
  // whatever is still un-consolidated for the session — best-effort, §3.4).
  if (anyFailure) {
    try {
      knowledgeUpserted = await runConcatFallback(ctx, knowledgeUpserted, consolidatedIds);
    } catch (err) {
      console.warn("[memory-consolidation] concat fallback failed:", err);
    }
  }

  const synthesisMethod: ConsolidationResult["synthesisMethod"] = anyLlmSuccess
    ? "llm"
    : anyFailure
      ? "concat"
      : "none";
  return {
    status: "ran",
    synthesisMethod,
    knowledgeUpserted,
    fragmentsConsolidated: consolidatedIds.size,
    reason: ctx.reason,
  };
}

/**
 * Run consolidation for a session. Idempotent per in-flight guard: concurrent
 * calls for the same session return { status: "in_flight" }.
 */
export async function consolidate(ctx: ConsolidationContext): Promise<ConsolidationResult> {
  if (_inFlight.has(ctx.sessionId)) return emptyResult("in_flight", ctx.reason);
  _inFlight.add(ctx.sessionId);
  try {
    return await runConsolidation(ctx);
  } catch (err) {
    // Fire-and-forget posture: never throw to callers.
    console.warn("[memory-consolidation] consolidate failed:", err);
    return emptyResult("ran", ctx.reason);
  } finally {
    _inFlight.delete(ctx.sessionId);
  }
}

/** True when the session has ≥ threshold un-consolidated fragments (turn-boundary trigger). */
export async function shouldConsolidateOnTurn(sessionId: string): Promise<boolean> {
  try {
    const fragments = await getUnconsolidatedFragments(sessionId, TURN_CONSOLIDATION_THRESHOLD);
    return fragments.length >= TURN_CONSOLIDATION_THRESHOLD;
  } catch (err) {
    console.warn("[memory-consolidation] shouldConsolidateOnTurn failed:", err);
    return false;
  }
}

// ─── Idle trigger (§3.4 trigger 2) ───────────────────────────────────────────

interface IdleEntry {
  ctx: Omit<ConsolidationContext, "reason">;
  lastActivityAt: number;
}

const _idleSessions = new Map<string, IdleEntry>();
let _idleTimer: ReturnType<typeof setInterval> | null = null;

function ensureIdleWatcher(): void {
  // Tests drive the idle check explicitly via _checkIdleSessions — a live
  // interval would fire consolidations mid-assertion (same gating as the
  // store's maintenance timers in semantic-memory.ts).
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  if (_idleTimer) return;
  _idleTimer = setInterval(() => {
    _checkIdleSessions().catch((err) =>
      console.warn("[memory-consolidation] idle check failed:", err),
    );
  }, IDLE_CHECK_INTERVAL_MS);
  _idleTimer.unref?.();
}

/**
 * Record session activity for the idle trigger. The module owns the idle
 * timer internally; callers just report activity with enough context to
 * consolidate later.
 */
export function noteSessionActivity(ctx: Omit<ConsolidationContext, "reason">): void {
  _idleSessions.set(ctx.sessionId, { ctx, lastActivityAt: Date.now() });
  ensureIdleWatcher();
}

/**
 * Idle sweep: sessions inactive > 30 min with un-consolidated fragments are
 * consolidated with reason "idle". One-shot per idle period — the entry is
 * removed on firing and re-registered by the next noteSessionActivity call.
 * Exported as a test hook (the interval is disabled under vitest) and invoked
 * by the internal unref()'d interval in production.
 */
export async function _checkIdleSessions(now: number = Date.now()): Promise<void> {
  for (const [sessionId, entry] of [..._idleSessions]) {
    if (now - entry.lastActivityAt <= IDLE_TRIGGER_MS) continue;
    _idleSessions.delete(sessionId);
    try {
      const pending = await getUnconsolidatedFragments(sessionId, 1);
      if (pending.length === 0) continue;
      await consolidate({ ...entry.ctx, reason: "idle" });
    } catch (err) {
      console.warn("[memory-consolidation] idle consolidation failed:", err);
    }
  }
}

/** Stop all idle timers (tests / shutdown). */
export function stopIdleWatcher(): void {
  if (_idleTimer) {
    clearInterval(_idleTimer);
    _idleTimer = null;
  }
  _idleSessions.clear();
}

/** Reset module state between tests (in-flight guard + idle tracking). */
export function _resetForTest(): void {
  _inFlight.clear();
  stopIdleWatcher();
}
