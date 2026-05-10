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
});
