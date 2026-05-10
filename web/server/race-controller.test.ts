import { describe, expect, it, vi } from "vitest";

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
});
