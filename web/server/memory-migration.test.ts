/**
 * Tests for the pure helpers in memory-migration.ts: namespace model (§3.1),
 * meta.json versioning (§3.5), zero-vector detection (§1.6), and namespace
 * backfill rules. The end-to-end migration flows (v1 → v2 copy, dimension
 * change, re-embed queue) are covered in semantic-memory.test.ts where the
 * whole store is exercised against real LanceDB tables.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hashRepoRoot,
  repoNamespace,
  sessionNamespace,
  agentNamespace,
  namespaceClass,
  isNamespaceString,
  isZeroVector,
  toNumberArray,
  backfillFragmentNamespace,
  backfillKnowledgeNamespace,
  readMemoryMeta,
  writeMemoryMeta,
  metaPath,
  MEMORY_SCHEMA_VERSION,
  type MemoryMeta,
} from "./memory-migration.js";

describe("namespace model (§3.1)", () => {
  it("hashRepoRoot is a stable 16-char hex prefix of SHA-256", () => {
    // Stability matters: the hash is stored in rows and used in where() strings
    const h1 = hashRepoRoot("/home/user/project");
    const h2 = hashRepoRoot("/home/user/project");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(hashRepoRoot("/other")).not.toBe(h1);
  });

  it("builds namespace strings for each class", () => {
    expect(repoNamespace("/repo")).toBe(`repo:${hashRepoRoot("/repo")}`);
    expect(sessionNamespace("abc-123")).toBe("session:abc-123");
    expect(agentNamespace("codex")).toBe("agent:codex");
  });

  it("classifies namespaces into decay-policy classes", () => {
    expect(namespaceClass("global")).toBe("global");
    expect(namespaceClass(repoNamespace("/x"))).toBe("repo");
    expect(namespaceClass("session:s1")).toBe("session");
    expect(namespaceClass("agent:claude")).toBe("agent");
    // Unknown prefixes fall back to the most conservative (slowest-decay) class
    expect(namespaceClass("weird")).toBe("global");
  });

  it("distinguishes namespace strings from bare session ids", () => {
    expect(isNamespaceString("global")).toBe(true);
    expect(isNamespaceString("session:s1")).toBe(true);
    expect(isNamespaceString("repo:abcd")).toBe(true);
    // A bare UUID-ish session id is not a namespace
    expect(isNamespaceString("f2b8d9a0-1")).toBe(false);
  });
});

describe("namespace backfill rules (§3.5.1)", () => {
  it("fragments: repoRoot present → repo:<hash>, else session:<sessionId>", () => {
    expect(backfillFragmentNamespace("/repo", "s1")).toBe(repoNamespace("/repo"));
    expect(backfillFragmentNamespace("", "s1")).toBe("session:s1");
  });

  it("consolidated rows: repoRoot === '' → global", () => {
    expect(backfillKnowledgeNamespace("/repo")).toBe(repoNamespace("/repo"));
    expect(backfillKnowledgeNamespace("")).toBe("global");
  });
});

describe("zero-vector detection (§1.6)", () => {
  it("treats missing, empty, and all-zero vectors as zero", () => {
    expect(isZeroVector(undefined)).toBe(true);
    expect(isZeroVector([])).toBe(true);
    expect(isZeroVector([0, 0, 0])).toBe(true);
    expect(isZeroVector(new Float32Array([0, 0]))).toBe(true);
  });

  it("recognizes real vectors, including typed arrays", () => {
    expect(isZeroVector([0, 0.1, 0])).toBe(false);
    expect(isZeroVector(new Float32Array([1, 0]))).toBe(false);
  });

  it("toNumberArray normalizes plain arrays and TypedArrays", () => {
    expect(toNumberArray([1, 2])).toEqual([1, 2]);
    expect(toNumberArray(new Float32Array([1, 2]))).toEqual([1, 2]);
    expect(toNumberArray(null)).toEqual([]);
  });
});

describe("meta.json versioning (§3.5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-meta-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when meta.json is absent (= schema v1)", () => {
    expect(readMemoryMeta(dir)).toBeNull();
  });

  it("round-trips meta through write/read", () => {
    const meta: MemoryMeta = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      embeddingProvider: "openai",
      dim: 1536,
      activeFragmentsTable: "fragments_v2",
      activeConsolidatedTable: "consolidated_v2",
      updatedAt: 42,
    };
    writeMemoryMeta(dir, meta);
    expect(existsSync(metaPath(dir))).toBe(true);
    expect(readMemoryMeta(dir)).toEqual(meta);
    // File is human-readable JSON (debugging aid)
    expect(JSON.parse(readFileSync(metaPath(dir), "utf-8")).schemaVersion).toBe(2);
  });

  it("treats corrupt or shape-less meta files as v1 (null)", () => {
    writeMemoryMeta(dir, { garbage: true } as unknown as MemoryMeta);
    expect(readMemoryMeta(dir)).toBeNull();
  });
});
