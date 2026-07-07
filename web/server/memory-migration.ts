/**
 * Semantic memory schema v2 — meta.json versioning, namespaces, and the
 * v1 → v2 / dimension-change migrations (design doc §3.1 and §3.5).
 *
 * Layout under the memory root (default ~/.campfire/memory/):
 *   meta.json   — { schemaVersion, embeddingProvider, dim, active table names }
 *   lancedb/    — LanceDB database directory (tables: fragments_v2, consolidated_v2,
 *                 fragments_v2_<dim> after a dimension change, plus retained v1
 *                 tables "fragments"/"consolidated" kept as backups)
 *
 * Migration properties (per §3.5):
 *  - Versioned tables, never in-place ALTER.
 *  - v1 rows are copied with namespace backfill (repoRoot → repo:<hash>, else
 *    session:<sessionId>; consolidated rows with repoRoot === "" → global).
 *  - Zero-vector rows are detected and marked embeddingStatus = "pending" so
 *    they are excluded from ANN (§1.6 fix) and lazily re-embedded.
 *  - v1 tables are retained untouched as backups. (The installed LanceDB SDK
 *    has no renameTable, so instead of renaming to *_v1_backup we simply never
 *    open them again once meta.schemaVersion >= 2.)
 *  - meta.json is written only after a successful copy, so an interrupted
 *    migration re-runs from scratch (partially-copied v2 tables are dropped).
 *  - Dimension/provider changes create a new active table fragments_v2_<dim>
 *    and mark all rows "pending" for the lazy re-embed queue.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Namespace model (§3.1) ──────────────────────────────────────────────────

export type NamespaceClass = "global" | "repo" | "session" | "agent";

/** Short SHA-256 of the absolute repo root — stable, path-privacy-friendly, safe in where() strings. */
export function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

export function repoNamespace(repoRoot: string): string {
  return `repo:${hashRepoRoot(repoRoot)}`;
}

export function sessionNamespace(sessionId: string): string {
  return `session:${sessionId}`;
}

export function agentNamespace(backendType: string): string {
  return `agent:${backendType}`;
}

/** Classify a namespace string into its decay-policy class. Unknown prefixes fall back to "global". */
export function namespaceClass(namespace: string): NamespaceClass {
  if (namespace.startsWith("repo:")) return "repo";
  if (namespace.startsWith("session:")) return "session";
  if (namespace.startsWith("agent:")) return "agent";
  return "global";
}

/** True when the string is a namespace (vs. a bare session id). */
export function isNamespaceString(value: string): boolean {
  return value === "global" || value.includes(":");
}

// ─── meta.json ───────────────────────────────────────────────────────────────

export const MEMORY_SCHEMA_VERSION = 2;

/** Vector-column width used when no embedding provider is configured. */
export const NO_PROVIDER_DIM = 1;

export interface MemoryMeta {
  schemaVersion: number;
  embeddingProvider: string;
  /** Width of the vector column on the active tables. */
  dim: number;
  activeFragmentsTable: string;
  activeConsolidatedTable: string;
  /** v1 table names retained as backups (never opened again). */
  v1BackupTables?: string[];
  migratedFromV1?: boolean;
  updatedAt: number;
}

export function metaPath(memoryRoot: string): string {
  return join(memoryRoot, "meta.json");
}

export function readMemoryMeta(memoryRoot: string): MemoryMeta | null {
  try {
    const p = metaPath(memoryRoot);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<MemoryMeta>;
    if (typeof raw?.schemaVersion !== "number") return null;
    return raw as MemoryMeta;
  } catch {
    return null;
  }
}

export function writeMemoryMeta(memoryRoot: string, meta: MemoryMeta): void {
  mkdirSync(memoryRoot, { recursive: true });
  writeFileSync(metaPath(memoryRoot), JSON.stringify(meta, null, 2), "utf-8");
}

// ─── Vector helpers ──────────────────────────────────────────────────────────

/** Normalize an Arrow/TypedArray/plain vector value into number[]. */
export function toNumberArray(value: unknown): number[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as number[];
  if (ArrayBuffer.isView(value)) return Array.from(value as Float32Array);
  const maybe = value as { toArray?: () => ArrayLike<number> };
  if (typeof maybe.toArray === "function") return Array.from(maybe.toArray());
  return [];
}

/** A vector that is missing, empty, or all zeros carries no embedding (§1.6). */
export function isZeroVector(value: unknown): boolean {
  const arr = toNumberArray(value);
  if (arr.length === 0) return true;
  return arr.every((v) => v === 0);
}

// ─── LanceDB row shapes ──────────────────────────────────────────────────────

type LanceDB = typeof import("@lancedb/lancedb");
type LanceConnection = Awaited<ReturnType<LanceDB["connect"]>>;
type LanceTable = Awaited<ReturnType<LanceConnection["openTable"]>>;

/** Build a v2 fragments seed row (used to establish the table schema). */
export function fragmentSeedRow(dim: number): Record<string, unknown> {
  return {
    id: "__seed__",
    sessionId: "",
    agentId: "",
    backendType: "claude",
    timestamp: 0,
    type: "observation",
    content: "",
    gitContextJson: "{}",
    referencesJson: "[]",
    tagsJson: "[]",
    confidence: 0,
    consolidatedInto: "",
    isConsolidated: false,
    namespace: "",
    repoRoot: "",
    repoRootHash: "",
    lastReinforcedAt: 0,
    accessCount: 0,
    pinned: false,
    // 0 = no per-fragment override (null in the domain model)
    halfLifeHours: 0,
    embeddingStatus: "none",
    vector: Array(dim).fill(0) as number[],
  };
}

/** Build a v2 consolidated-knowledge seed row. */
export function consolidatedSeedRow(dim: number): Record<string, unknown> {
  return {
    id: "__seed__",
    tag: "",
    summary: "",
    sourceFragmentsJson: "[]",
    lastUpdated: 0,
    confidence: 0,
    repoRoot: "",
    namespace: "",
    repoRootHash: "",
    knowledgeType: "",
    synthesisMethod: "",
    supersededBy: "",
    accessCount: 0,
    lastReinforcedAt: 0,
    embeddingStatus: "none",
    vector: Array(dim).fill(0) as number[],
  };
}

async function createSeededTable(
  db: LanceConnection,
  name: string,
  seed: Record<string, unknown>,
): Promise<LanceTable> {
  const table = await db.createTable(name, [seed]);
  await table.delete('id = "__seed__"');
  return table;
}

async function readAllRows(table: LanceTable, limit = 100000): Promise<Record<string, unknown>[]> {
  const rows = await table.query().limit(limit).toArray();
  return rows as unknown as Record<string, unknown>[];
}

async function addInChunks(table: LanceTable, rows: Record<string, unknown>[], chunk = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await table.add(rows.slice(i, i + chunk));
  }
}

// ─── v1 → v2 row transforms ──────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Backfill rule (§3.5.1): repoRoot present → repo:<hash>; else session:<sessionId>. */
export function backfillFragmentNamespace(repoRoot: string, sessionId: string): string {
  if (repoRoot) return repoNamespace(repoRoot);
  return sessionNamespace(sessionId);
}

/** Consolidated rows: repoRoot present → repo:<hash>; repoRoot === "" → global. */
export function backfillKnowledgeNamespace(repoRoot: string): string {
  return repoRoot ? repoNamespace(repoRoot) : "global";
}

function migrateFragmentRow(
  row: Record<string, unknown>,
  targetDim: number,
  providerDim: number | null,
): Record<string, unknown> {
  let repoRoot = "";
  try {
    const git = JSON.parse(str(row.gitContextJson) || "{}") as { repoRoot?: string };
    repoRoot = typeof git.repoRoot === "string" ? git.repoRoot : "";
  } catch {
    repoRoot = "";
  }
  const sessionId = str(row.sessionId);
  const vec = toNumberArray(row.vector);
  const zero = isZeroVector(vec);

  // Vector carries over only when it is non-zero AND already matches the
  // active dimension; otherwise it must be re-embedded (status "pending").
  const keepVector = !zero && vec.length === targetDim && providerDim !== null && providerDim === targetDim;
  return {
    id: str(row.id),
    sessionId,
    agentId: str(row.agentId),
    backendType: str(row.backendType) || "claude",
    timestamp: num(row.timestamp),
    type: str(row.type) || "observation",
    content: str(row.content),
    gitContextJson: str(row.gitContextJson) || "{}",
    referencesJson: str(row.referencesJson) || "[]",
    tagsJson: str(row.tagsJson) || "[]",
    confidence: num(row.confidence),
    consolidatedInto: str(row.consolidatedInto),
    isConsolidated: row.isConsolidated === true,
    namespace: backfillFragmentNamespace(repoRoot, sessionId),
    repoRoot,
    repoRootHash: repoRoot ? hashRepoRoot(repoRoot) : "",
    lastReinforcedAt: num(row.timestamp),
    accessCount: 0,
    pinned: false,
    halfLifeHours: 0,
    embeddingStatus: keepVector ? "ok" : "pending",
    vector: keepVector ? vec : (Array(targetDim).fill(0) as number[]),
  };
}

function migrateConsolidatedRow(row: Record<string, unknown>, targetDim: number): Record<string, unknown> {
  const repoRoot = str(row.repoRoot);
  return {
    id: str(row.id),
    tag: str(row.tag),
    summary: str(row.summary),
    sourceFragmentsJson: str(row.sourceFragmentsJson) || "[]",
    lastUpdated: num(row.lastUpdated),
    confidence: num(row.confidence),
    repoRoot,
    namespace: backfillKnowledgeNamespace(repoRoot),
    repoRootHash: repoRoot ? hashRepoRoot(repoRoot) : "",
    knowledgeType: "",
    // v1 synthesize() was concatenation
    synthesisMethod: "concat",
    supersededBy: "",
    accessCount: 0,
    lastReinforcedAt: num(row.lastUpdated),
    // v1 had no vector column on consolidated rows — needs embedding
    embeddingStatus: "pending",
    vector: Array(targetDim).fill(0) as number[],
  };
}

// ─── Migration entry point ───────────────────────────────────────────────────

export interface EnsureSchemaOptions {
  db: LanceConnection;
  memoryRoot: string;
  /** Current embedding provider name from settings ("openai" | "ollama" | "none"). */
  provider: string;
  /** Current provider dim, or null when provider is "none". */
  providerDim: number | null;
}

export interface EnsuredSchema {
  meta: MemoryMeta;
  fragments: LanceTable;
  consolidated: LanceTable;
}

/**
 * Ensure the on-disk store is at schema v2 and consistent with the currently
 * configured embedding provider. Handles, in order:
 *  1. fresh install (no meta, no tables)
 *  2. v1 → v2 copy migration with namespace backfill + zero-vector detection
 *  3. provider/dimension changes on an existing v2 store
 */
export async function ensureSchemaV2(opts: EnsureSchemaOptions): Promise<EnsuredSchema> {
  const { db, memoryRoot, provider, providerDim } = opts;
  let meta = readMemoryMeta(memoryRoot);
  const tableNames = await db.tableNames();

  if (!meta || meta.schemaVersion < MEMORY_SCHEMA_VERSION) {
    meta = await migrateToV2(db, memoryRoot, tableNames, provider, providerDim);
  }

  meta = await reconcileProviderChange(db, memoryRoot, meta, provider, providerDim);

  const fragments = await db.openTable(meta.activeFragmentsTable);
  const consolidated = await db.openTable(meta.activeConsolidatedTable);
  return { meta, fragments, consolidated };
}

async function migrateToV2(
  db: LanceConnection,
  memoryRoot: string,
  tableNames: string[],
  provider: string,
  providerDim: number | null,
): Promise<MemoryMeta> {
  const hasV1Fragments = tableNames.includes("fragments");
  const hasV1Consolidated = tableNames.includes("consolidated");

  // Interrupted-migration safety: v2 tables without meta.json are partial — drop and redo.
  for (const name of tableNames) {
    if (name.startsWith("fragments_v2") || name.startsWith("consolidated_v2")) {
      await db.dropTable(name);
    }
  }

  // Determine the active vector dimension: prefer the configured provider's
  // dim; with no provider, inherit the v1 dim (keeps migrated vectors intact)
  // or fall back to the placeholder width.
  let v1Dim: number | null = null;
  let v1FragmentRows: Record<string, unknown>[] = [];
  if (hasV1Fragments) {
    const v1 = await db.openTable("fragments");
    v1FragmentRows = await readAllRows(v1);
    const withVec = v1FragmentRows.find((r) => toNumberArray(r.vector).length > 0);
    v1Dim = withVec ? toNumberArray(withVec.vector).length : null;
  }
  const dim = providerDim ?? v1Dim ?? NO_PROVIDER_DIM;

  const fragments = await createSeededTable(db, "fragments_v2", fragmentSeedRow(dim));
  const consolidated = await createSeededTable(db, "consolidated_v2", consolidatedSeedRow(dim));

  if (v1FragmentRows.length > 0) {
    await addInChunks(fragments, v1FragmentRows.map((r) => migrateFragmentRow(r, dim, providerDim)));
  }
  if (hasV1Consolidated) {
    const v1c = await db.openTable("consolidated");
    const rows = await readAllRows(v1c);
    if (rows.length > 0) {
      await addInChunks(consolidated, rows.map((r) => migrateConsolidatedRow(r, dim)));
    }
  }

  const backups: string[] = [];
  if (hasV1Fragments) backups.push("fragments");
  if (hasV1Consolidated) backups.push("consolidated");

  // meta.json written last — an interrupted copy re-runs from scratch.
  const meta: MemoryMeta = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    embeddingProvider: provider,
    dim,
    activeFragmentsTable: "fragments_v2",
    activeConsolidatedTable: "consolidated_v2",
    v1BackupTables: backups.length > 0 ? backups : undefined,
    migratedFromV1: backups.length > 0 || undefined,
    updatedAt: Date.now(),
  };
  writeMemoryMeta(memoryRoot, meta);
  return meta;
}

/**
 * Handle provider/dimension changes on an existing v2 store (§3.5.2):
 *  - provider → "none": keep tables; record provider; new rows get status "none".
 *  - same dim, different provider: embeddings are model-specific — mark all
 *    "ok" rows "pending" in place for re-embedding.
 *  - different dim: create fragments_v2_<dim>/consolidated_v2_<dim> as the
 *    active tables, copy rows with zero vectors + status "pending".
 */
async function reconcileProviderChange(
  db: LanceConnection,
  memoryRoot: string,
  meta: MemoryMeta,
  provider: string,
  providerDim: number | null,
): Promise<MemoryMeta> {
  if (provider === meta.embeddingProvider) return meta;

  if (providerDim === null) {
    // Real provider → none: nothing to re-embed; just record it.
    const next = { ...meta, embeddingProvider: provider, updatedAt: Date.now() };
    writeMemoryMeta(memoryRoot, next);
    return next;
  }

  if (providerDim === meta.dim) {
    // Same width, different model — existing vectors are not comparable.
    for (const name of [meta.activeFragmentsTable, meta.activeConsolidatedTable]) {
      const table = await db.openTable(name);
      await table.update({ where: "embeddingStatus = 'ok'", values: { embeddingStatus: "pending" } });
    }
    const next = { ...meta, embeddingProvider: provider, updatedAt: Date.now() };
    writeMemoryMeta(memoryRoot, next);
    return next;
  }

  // Dimension change: versioned new active tables, rows queued for re-embed.
  const newFragName = `fragments_v2_${providerDim}`;
  const newConsName = `consolidated_v2_${providerDim}`;
  const existing = await db.tableNames();
  // Re-created from the current active tables (source of truth) if left over
  // from a previous switch.
  if (existing.includes(newFragName)) await db.dropTable(newFragName);
  if (existing.includes(newConsName)) await db.dropTable(newConsName);

  const newFragments = await createSeededTable(db, newFragName, fragmentSeedRow(providerDim));
  const newConsolidated = await createSeededTable(db, newConsName, consolidatedSeedRow(providerDim));

  const oldFragments = await db.openTable(meta.activeFragmentsTable);
  const fragRows = await readAllRows(oldFragments);
  await addInChunks(newFragments, fragRows.map((r) => ({
    ...r,
    vector: Array(providerDim).fill(0) as number[],
    embeddingStatus: "pending",
  })));

  const oldConsolidated = await db.openTable(meta.activeConsolidatedTable);
  const consRows = await readAllRows(oldConsolidated);
  await addInChunks(newConsolidated, consRows.map((r) => ({
    ...r,
    vector: Array(providerDim).fill(0) as number[],
    embeddingStatus: "pending",
  })));

  const next: MemoryMeta = {
    ...meta,
    embeddingProvider: provider,
    dim: providerDim,
    activeFragmentsTable: newFragName,
    activeConsolidatedTable: newConsName,
    updatedAt: Date.now(),
  };
  writeMemoryMeta(memoryRoot, next);
  return next;
}
