import { describe, expect, it, vi } from "vitest";

// Cascade success detection shells out to `git diff --name-only` inside each
// entry worktree; mocking execFileSync lets tests decide which worktree looks
// like a non-empty patch without touching a real repository.
const execFileSyncMock = vi.hoisted(() => vi.fn((..._args: unknown[]): string => ""));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => ({ repoRoot: "/repo", repoName: "repo", currentBranch: "main", defaultBranch: "main", isWorktree: false })),
  ensureWorktree: vi.fn((_repoRoot: string, branch: string) => ({
    worktreePath: `/wt/${branch}`,
    branch,
    actualBranch: branch,
    isNew: true,
  })),
  removeWorktree: vi.fn(() => ({ removed: true })),
}));

vi.mock("./race-store.js", () => {
  const races = new Map<string, any>();
  return {
    getRace: vi.fn((id: string) => races.get(id) ?? null),
    saveRace: vi.fn((race: any) => races.set(race.raceId, structuredClone(race))),
  };
});

vi.mock("./env-manager.js", () => ({
  getEnv: vi.fn(() => null),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({})),
}));

// Shared harness for cascade tests: launcher/bridge fakes that resolve
// instantly. `resultFor` decides what each session produces once prompted —
// return null to simulate a session that never yields a result (hangs).
function makeCascadeHarness(resultFor: (sessionId: string) => { is_error: boolean } | null = () => ({ is_error: false })) {
  const histories = new Map<string, unknown[]>();
  const launcher = {
    launch: vi.fn((opts: { backendType: string }) => ({
      sessionId: `session-${opts.backendType}`,
      detectedEnvironment: undefined,
    })),
    kill: vi.fn(async () => true),
  };
  const wsBridge = {
    markSessionOrchestration: vi.fn(),
    isCliConnected: vi.fn(() => true),
    getSession: vi.fn((sessionId: string) => ({
      messageHistory: histories.get(sessionId) ?? [],
      state: { total_cost_usd: 0 },
    })),
    injectUserMessage: vi.fn((sessionId: string) => {
      const outcome = resultFor(sessionId);
      if (!outcome) return; // hang: waitForResult keeps polling until cancel/timeout
      histories.set(sessionId, [{
        type: "result",
        data: {
          type: "result",
          subtype: outcome.is_error ? "error" : "success",
          is_error: outcome.is_error,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          uuid: "r",
          session_id: sessionId,
        },
      }]);
    }),
  };
  return { launcher, wsBridge };
}

// Makes exactly one backend's worktree report a changed file from
// `git diff --name-only`; every other worktree looks like an empty patch.
function gitReportsChangesFor(backend: string | null): void {
  execFileSyncMock.mockImplementation((...callArgs: unknown[]) => {
    const [, args, opts] = callArgs as [string, string[], { cwd?: string }];
    const cwd = String(opts?.cwd ?? "");
    if (backend && cwd.includes(`race-${backend}-`) && args.includes("--name-only") && !args.includes("--cached")) {
      return "src/fix.ts";
    }
    return "";
  });
}

describe("RaceController", () => {
  it("creates one isolated worktree and session per selected backend", async () => {
    // This covers the race orchestration fan-out without starting real agent processes.
    const { RaceController } = await import("./race-controller.js");
    const gitUtils = await import("./git-utils.js");
    const launcher = {
      launch: vi.fn((opts: any) => ({
        sessionId: `session-${opts.backendType}`,
        detectedEnvironment: undefined,
      })),
    };
    const histories = new Map<string, any[]>();
    const wsBridge = {
      markSessionOrchestration: vi.fn(),
      isCliConnected: vi.fn(() => true),
      getSession: vi.fn((sessionId: string) => ({
        messageHistory: histories.get(sessionId) ?? [],
        state: { total_cost_usd: 0 },
      })),
      injectUserMessage: vi.fn((sessionId: string) => {
        histories.set(sessionId, [{
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "r",
            session_id: sessionId,
          },
        }]);
      }),
    };

    const controller = new RaceController(launcher as any, wsBridge as any);
    const race = controller.startRace({
      prompt: "Build login",
      backends: ["claude", "codex"],
      repoRoot: "/repo",
      baseBranch: "main",
    });

    expect(race.status).toBe("running");
    expect(gitUtils.ensureWorktree).toHaveBeenCalledTimes(2);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
      backendType: "claude",
      cwd: expect.stringContaining("/wt/race-claude-"),
      orchestrationRole: "race_entry",
    }));
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
      backendType: "codex",
      cwd: expect.stringContaining("/wt/race-codex-"),
      orchestrationRole: "race_entry",
    }));
  });

  it("injects the selected environment profile into race entry sessions", async () => {
    // Race entries are created outside the normal session creation route, so
    // this verifies env profiles still reach each launched backend process.
    const { RaceController } = await import("./race-controller.js");
    const envManager = await import("./env-manager.js");
    vi.mocked(envManager.getEnv).mockImplementation((slug: string) => slug === "azure-openai"
      ? {
        name: "Azure OpenAI",
        slug: "azure-openai",
        variables: {
          AZURE_OPENAI_API_KEY: "azure-secret",
          AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        },
        createdAt: 1,
        updatedAt: 1,
      }
      : null);

    const launcher = {
      launch: vi.fn((opts: any) => ({
        sessionId: `session-${opts.backendType}`,
        detectedEnvironment: undefined,
      })),
    };
    const histories = new Map<string, any[]>();
    const wsBridge = {
      markSessionOrchestration: vi.fn(),
      isCliConnected: vi.fn(() => true),
      getSession: vi.fn((sessionId: string) => ({
        messageHistory: histories.get(sessionId) ?? [],
        state: { total_cost_usd: 0 },
      })),
      injectUserMessage: vi.fn((sessionId: string) => {
        histories.set(sessionId, [{
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "r",
            session_id: sessionId,
          },
        }]);
      }),
    };

    const controller = new RaceController(launcher as any, wsBridge as any);
    controller.startRace({
      prompt: "Use Azure OpenAI",
      backends: ["claude", "codex"],
      repoRoot: "/repo",
      baseBranch: "main",
      envSlug: "azure-openai",
    });

    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
      backendType: "codex",
      env: expect.objectContaining({
        AZURE_OPENAI_API_KEY: "azure-secret",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      }),
    }));
  });

  it("cascade stops after the first successful entry and marks the rest skipped", async () => {
    // Cost cascade: entries run sequentially in listed order and the race
    // stops at the first entry that completes with a non-empty patch. This
    // validates that (1) only the first backend ever receives the prompt —
    // the entire point of the cheap-model-first cascade, (2) the remaining
    // entries end in the terminal "skipped" state with their idle sessions
    // killed, and (3) the race finishes "completed" with the cascade flag set.
    const { RaceController } = await import("./race-controller.js");
    const store = await import("./race-store.js");
    gitReportsChangesFor("claude");
    const { launcher, wsBridge } = makeCascadeHarness();

    const controller = new RaceController(launcher as any, wsBridge as any);
    const race = controller.startRace({
      prompt: "Build login",
      backends: ["claude", "codex", "goose"],
      repoRoot: "/repo",
      baseBranch: "main",
      cascade: true,
    });
    expect(race.cascade).toBe(true);

    await vi.waitFor(() => {
      expect(store.getRace(race.raceId)?.status).not.toBe("running");
    });

    const final = store.getRace(race.raceId)!;
    expect(final.status).toBe("completed");
    expect(final.entries.map((entry: any) => entry.status)).toEqual(["completed", "skipped", "skipped"]);
    // The prompt was only ever sent to the cheapest backend.
    expect(wsBridge.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("session-claude", "Build login");
    // Skipped entries had their never-prompted sessions torn down.
    expect(launcher.kill).toHaveBeenCalledWith("session-codex");
    expect(launcher.kill).toHaveBeenCalledWith("session-goose");
  });

  it("cascade escalates past failed and empty-patch entries", async () => {
    // Escalation heuristic: a failed entry AND a completed entry with zero
    // changed files (the MetaHarness "empty patch") must both hand off to the
    // next backend. claude fails outright, codex completes but changes
    // nothing, and goose produces a real change — so all three receive the
    // prompt in listed order, and the race still ends "completed" (not
    // "failed") because the cascade found a winner despite earlier failures.
    const { RaceController } = await import("./race-controller.js");
    const store = await import("./race-store.js");
    gitReportsChangesFor("goose");
    const { launcher, wsBridge } = makeCascadeHarness((sessionId) => ({ is_error: sessionId === "session-claude" }));

    const controller = new RaceController(launcher as any, wsBridge as any);
    const race = controller.startRace({
      prompt: "Fix the bug",
      backends: ["claude", "codex", "goose"],
      repoRoot: "/repo",
      baseBranch: "main",
      cascade: true,
    });

    await vi.waitFor(() => {
      expect(store.getRace(race.raceId)?.status).not.toBe("running");
    });

    const final = store.getRace(race.raceId)!;
    expect(final.status).toBe("completed");
    expect(final.entries.map((entry: any) => entry.status)).toEqual(["failed", "completed", "completed"]);
    // Every backend was prompted, strictly in the order the user listed them.
    expect(vi.mocked(wsBridge.injectUserMessage).mock.calls.map((call) => call[0]))
      .toEqual(["session-claude", "session-codex", "session-goose"]);
    // codex is the empty patch (completed, zero files); goose won the cascade.
    expect(final.entries[1].metrics?.filesChanged).toBe(0);
    expect(final.entries[2].filesChanged).toEqual(["src/fix.ts"]);
    // Nothing came after the winner, so nothing was skipped or killed.
    expect(launcher.kill).not.toHaveBeenCalled();
  });

  it("cancelRace mid-cascade stops escalation to the remaining backends", async () => {
    // Cancels while the first entry is still waiting for a result. The
    // sequential loop must observe the cancellation and never prompt the
    // second backend, and the race must stay "cancelled" — the completion
    // logic must not overwrite it after the in-flight entry unwinds.
    const { RaceController } = await import("./race-controller.js");
    const store = await import("./race-store.js");
    gitReportsChangesFor(null);
    // resultFor returns null: the claude session hangs and never resolves.
    const { launcher, wsBridge } = makeCascadeHarness(() => null);

    const controller = new RaceController(launcher as any, wsBridge as any);
    const race = controller.startRace({
      prompt: "Long task",
      backends: ["claude", "codex"],
      repoRoot: "/repo",
      baseBranch: "main",
      cascade: true,
    });

    // Wait until the first entry is actually running (prompt injected).
    await vi.waitFor(() => {
      expect(wsBridge.injectUserMessage).toHaveBeenCalledTimes(1);
    });

    const cancelled = await controller.cancelRace(race.raceId);
    expect(cancelled?.status).toBe("cancelled");
    // cancelRace tears down every entry session, including the pending one.
    expect(launcher.kill).toHaveBeenCalledWith("session-claude");
    expect(launcher.kill).toHaveBeenCalledWith("session-codex");

    // Give the 1s result-poll loop a chance to wake up, observe the
    // cancellation, and unwind. A buggy cascade would escalate to codex here.
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(wsBridge.injectUserMessage).toHaveBeenCalledTimes(1); // codex never prompted
    const final = store.getRace(race.raceId)!;
    expect(final.status).toBe("cancelled");
    // The never-started entry was finalized by cancelRace, not left pending
    // or marked skipped (skipped is reserved for successful cascades).
    expect(final.entries[1].status).toBe("failed");
    // The in-flight entry unwound to a terminal error state.
    expect(["failed", "timeout"]).toContain(final.entries[0].status);
  });
});
