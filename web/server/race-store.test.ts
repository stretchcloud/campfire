import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;

describe("race-store", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.HOME = mkdtempSync(join(tmpdir(), "campfire-races-"));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("persists, lists, reads, and deletes race records", async () => {
    // The race store is file-backed like the rest of Campfire's session-adjacent state.
    const store = await import("./race-store.js");
    const race = {
      raceId: "race-1",
      prompt: "Implement auth",
      repoRoot: "/repo",
      baseBranch: "main",
      status: "running" as const,
      createdAt: Date.now(),
      entries: [],
    };

    store.saveRace(race);

    expect(store.getRace("race-1")?.prompt).toBe("Implement auth");
    expect(store.listRaces()).toHaveLength(1);
    expect(store.deleteRace("race-1")).toBe(true);
    expect(store.getRace("race-1")).toBeNull();
  });

  it("round-trips the cascade flag and the skipped entry status", async () => {
    // Cost cascade mode adds a `cascade` flag on the race and a terminal
    // "skipped" status for entries that never ran because a cheaper backend
    // earlier in the cascade already succeeded. Both must survive the
    // save/load round-trip so the UI can distinguish a skipped entry from
    // one that is still pending after the race finishes.
    const store = await import("./race-store.js");
    const race = {
      raceId: "race-cascade",
      prompt: "Fix flaky test",
      repoRoot: "/repo",
      baseBranch: "main",
      status: "completed" as const,
      createdAt: Date.now(),
      cascade: true,
      entries: [
        {
          id: "entry-1",
          sessionId: "session-1",
          backendType: "claude" as const,
          worktreePath: "/wt/one",
          branch: "race-claude-1",
          status: "completed" as const,
          startedAt: Date.now(),
        },
        {
          id: "entry-2",
          sessionId: "session-2",
          backendType: "codex" as const,
          worktreePath: "/wt/two",
          branch: "race-codex-1",
          status: "skipped" as const,
          startedAt: Date.now(),
        },
      ],
    };

    store.saveRace(race);

    const loaded = store.getRace("race-cascade");
    expect(loaded?.cascade).toBe(true);
    expect(loaded?.entries.map((entry) => entry.status)).toEqual(["completed", "skipped"]);
  });
});
