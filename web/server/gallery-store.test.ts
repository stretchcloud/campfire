import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the gallery dir before importing. Use a temp dir.
const testDir = join(tmpdir(), `gallery-test-${Date.now()}`);
const galleryDir = join(testDir, ".campfire", "gallery");

// Mock homedir so gallery-store writes to our temp dir
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => testDir };
});

// Import after mocking
const { listEntries, getEntry, createEntry, updateEntry, deleteEntry } = await import(
  "./gallery-store.js"
);
const { recordVote, getVoteCount, getVoterHash, removeEntryVotes, hasVoted } = await import(
  "./gallery-votes.js"
);

describe("gallery-store", () => {
  beforeEach(() => {
    mkdirSync(galleryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("createEntry", () => {
    it("creates a gallery entry with denormalized session data", () => {
      const entry = createEntry(
        { sessionId: "sess-1", name: "Auth Refactor", description: "JWT migration", tags: ["auth", "refactor"] },
        { backendType: "claude", model: "claude-sonnet-4-5", totalCostUsd: 0.25, numTurns: 8, totalLinesAdded: 120, totalLinesRemoved: 40, durationMs: 300000 },
      );

      expect(entry.id).toBe("auth-refactor");
      expect(entry.sessionId).toBe("sess-1");
      expect(entry.name).toBe("Auth Refactor");
      expect(entry.description).toBe("JWT migration");
      expect(entry.tags).toEqual(["auth", "refactor"]);
      expect(entry.featured).toBe(false);
      expect(entry.votes).toBe(0);
      expect(entry.backendType).toBe("claude");
      expect(entry.model).toBe("claude-sonnet-4-5");
      expect(entry.totalCostUsd).toBe(0.25);
      expect(entry.numTurns).toBe(8);
      // File should exist on disk
      expect(existsSync(join(galleryDir, "auth-refactor.json"))).toBe(true);
    });

    it("throws on duplicate slug", () => {
      createEntry(
        { sessionId: "s1", name: "My Entry", description: "" },
        { backendType: "claude" },
      );
      expect(() =>
        createEntry({ sessionId: "s2", name: "My Entry", description: "" }, { backendType: "codex" }),
      ).toThrow("already exists");
    });

    it("throws on empty name", () => {
      expect(() =>
        createEntry({ sessionId: "s1", name: "", description: "" }, {}),
      ).toThrow("name is required");
    });

    it("throws on empty sessionId", () => {
      expect(() =>
        createEntry({ sessionId: "", name: "Test", description: "" }, {}),
      ).toThrow("Session ID is required");
    });
  });

  describe("listEntries", () => {
    it("returns all entries sorted by votes descending by default", () => {
      createEntry({ sessionId: "s1", name: "Low Votes", description: "" }, { backendType: "claude" });
      createEntry({ sessionId: "s2", name: "High Votes", description: "" }, { backendType: "codex" });
      updateEntry("high-votes", { votes: 10 });
      updateEntry("low-votes", { votes: 2 });

      const entries = listEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe("high-votes");
      expect(entries[1].id).toBe("low-votes");
    });

    it("filters by backend", () => {
      createEntry({ sessionId: "s1", name: "Claude Session", description: "" }, { backendType: "claude" });
      createEntry({ sessionId: "s2", name: "Codex Session", description: "" }, { backendType: "codex" });

      const filtered = listEntries({ backend: "claude" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("claude-session");
    });

    it("filters by cost range", () => {
      createEntry({ sessionId: "s1", name: "Cheap", description: "" }, { totalCostUsd: 0.01 });
      createEntry({ sessionId: "s2", name: "Expensive", description: "" }, { totalCostUsd: 5.00 });

      const filtered = listEntries({ minCost: 1.0 });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("expensive");
    });

    it("filters by tags", () => {
      createEntry({ sessionId: "s1", name: "Tagged", description: "", tags: ["auth", "jwt"] }, {});
      createEntry({ sessionId: "s2", name: "Untagged", description: "" }, {});

      const filtered = listEntries({ tags: ["auth"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("tagged");
    });

    it("filters featured only", () => {
      createEntry({ sessionId: "s1", name: "Featured", description: "" }, {});
      createEntry({ sessionId: "s2", name: "Regular", description: "" }, {});
      updateEntry("featured", { featured: true });

      const filtered = listEntries({ featuredOnly: true });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("featured");
    });

    it("sorts by cost ascending", () => {
      createEntry({ sessionId: "s1", name: "Cheap", description: "" }, { totalCostUsd: 0.01 });
      createEntry({ sessionId: "s2", name: "Expensive", description: "" }, { totalCostUsd: 5.00 });

      const sorted = listEntries({ sortBy: "cost", sortOrder: "asc" });
      expect(sorted[0].id).toBe("cheap");
      expect(sorted[1].id).toBe("expensive");
    });

    it("skips votes.json in listing", () => {
      createEntry({ sessionId: "s1", name: "Entry One", description: "" }, {});
      // Write a votes.json file to the gallery dir
      writeFileSync(join(galleryDir, "votes.json"), "{}", "utf-8");

      const entries = listEntries();
      expect(entries).toHaveLength(1);
    });
  });

  describe("getEntry", () => {
    it("returns entry by id", () => {
      createEntry({ sessionId: "s1", name: "Test Entry", description: "desc" }, {});
      const entry = getEntry("test-entry");
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe("Test Entry");
    });

    it("returns null for missing entry", () => {
      expect(getEntry("nonexistent")).toBeNull();
    });
  });

  describe("updateEntry", () => {
    it("updates name, description, and tags", () => {
      createEntry({ sessionId: "s1", name: "Original", description: "old" }, {});
      const updated = updateEntry("original", { description: "new desc", tags: ["updated"] });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe("new desc");
      expect(updated!.tags).toEqual(["updated"]);
    });

    it("renames slug when name changes", () => {
      createEntry({ sessionId: "s1", name: "Old Name", description: "" }, {});
      updateEntry("old-name", { name: "New Name" });
      expect(getEntry("old-name")).toBeNull();
      expect(getEntry("new-name")).not.toBeNull();
    });

    it("returns null for missing entry", () => {
      expect(updateEntry("nonexistent", { description: "x" })).toBeNull();
    });
  });

  describe("deleteEntry", () => {
    it("deletes entry file", () => {
      createEntry({ sessionId: "s1", name: "To Delete", description: "" }, {});
      expect(deleteEntry("to-delete")).toBe(true);
      expect(getEntry("to-delete")).toBeNull();
    });

    it("returns false for missing entry", () => {
      expect(deleteEntry("nonexistent")).toBe(false);
    });
  });
});

describe("gallery-votes", () => {
  beforeEach(() => {
    mkdirSync(galleryDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("records an upvote and returns count", () => {
    const total = recordVote("entry-1", "voter-a", 1);
    expect(total).toBe(1);
  });

  it("records multiple votes from different voters", () => {
    recordVote("entry-1", "voter-a", 1);
    const total = recordVote("entry-1", "voter-b", 1);
    expect(total).toBe(2);
  });

  it("toggles off when same voter votes same direction", () => {
    recordVote("entry-1", "voter-a", 1);
    const total = recordVote("entry-1", "voter-a", 1);
    expect(total).toBe(0);
  });

  it("flips vote when voter changes direction", () => {
    recordVote("entry-1", "voter-a", 1);
    const total = recordVote("entry-1", "voter-a", -1);
    expect(total).toBe(-1);
  });

  it("tracks downvotes correctly", () => {
    recordVote("entry-1", "voter-a", -1);
    recordVote("entry-1", "voter-b", -1);
    const total = recordVote("entry-1", "voter-c", 1);
    expect(total).toBe(-1);
  });

  it("getVoterHash produces consistent hashes", () => {
    const hash1 = getVoterHash("192.168.1.1");
    const hash2 = getVoterHash("192.168.1.1");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  it("getVoterHash produces different hashes for different IPs", () => {
    const hash1 = getVoterHash("192.168.1.1");
    const hash2 = getVoterHash("10.0.0.1");
    expect(hash1).not.toBe(hash2);
  });

  it("hasVoted returns vote direction or null", () => {
    expect(hasVoted("entry-1", "voter-a")).toBeNull();
    recordVote("entry-1", "voter-a", 1);
    expect(hasVoted("entry-1", "voter-a")).toBe(1);
  });

  it("removeEntryVotes clears all votes for an entry", () => {
    recordVote("entry-1", "voter-a", 1);
    recordVote("entry-1", "voter-b", 1);
    removeEntryVotes("entry-1");
    expect(getVoteCount("entry-1")).toBe(0);
  });
});
