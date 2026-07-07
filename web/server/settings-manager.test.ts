import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSettings,
  updateSettings,
  _resetForTest,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_MEMORY_SETTINGS,
  normalizeMemorySettings,
} from "./settings-manager.js";

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "settings-manager-test-"));
  settingsPath = join(tempDir, "settings.json");
  _resetForTest(settingsPath);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("settings-manager", () => {
  it("returns defaults when file is missing", () => {
    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      moltbookApiKey: "",
      linearApiKey: "",
      // Provider tokens default to empty strings
      claudeOAuthToken: "",
      openaiApiKey: "",
      anthropicApiKey: "",
      embeddingProvider: "none",
      embeddingApiKey: "",
      embeddingModel: "",
      embeddingBaseUrl: "http://localhost:11434",
      // Semantic memory v2 adds a `memory` section with decay/recall defaults
      memory: DEFAULT_MEMORY_SETTINGS,
      // Onboarding wizard has not been completed by default
      onboardingCompleted: false,
      updatedAt: 0,
    });
  });

  it("updates and persists settings", () => {
    const updated = updateSettings({ openrouterApiKey: "or-key" });
    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(updated.updatedAt).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.openrouterApiKey).toBe("or-key");
    expect(saved.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("loads existing settings from disk", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: "existing",
        openrouterModel: "openai/gpt-4o-mini",
        updatedAt: 123,
      }),
      "utf-8",
    );

    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "existing",
      openrouterModel: "openai/gpt-4o-mini",
      moltbookApiKey: "",
      linearApiKey: "",
      // Fields absent from the on-disk file are normalized to their defaults
      claudeOAuthToken: "",
      openaiApiKey: "",
      anthropicApiKey: "",
      embeddingProvider: "none",
      embeddingApiKey: "",
      embeddingModel: "",
      embeddingBaseUrl: "http://localhost:11434",
      // Semantic memory v2: absent `memory` section normalizes to defaults
      memory: DEFAULT_MEMORY_SETTINGS,
      onboardingCompleted: false,
      updatedAt: 123,
    });
  });

  it("falls back to defaults for invalid JSON", () => {
    writeFileSync(settingsPath, "not-json", "utf-8");
    _resetForTest(settingsPath);

    expect(getSettings().openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("updates only model while preserving existing key", () => {
    updateSettings({ openrouterApiKey: "or-key" });
    const updated = updateSettings({ openrouterModel: "openai/gpt-4o-mini" });

    expect(updated.openrouterApiKey).toBe("or-key");
    expect(updated.openrouterModel).toBe("openai/gpt-4o-mini");
  });

  it("uses default model when empty model is provided", () => {
    const updated = updateSettings({ openrouterModel: "" });
    expect(updated.openrouterModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("normalizes malformed file shape to defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        openrouterApiKey: 123,
        openrouterModel: null,
        updatedAt: "x",
      }),
      "utf-8",
    );
    _resetForTest(settingsPath);

    expect(getSettings()).toEqual({
      openrouterApiKey: "",
      openrouterModel: DEFAULT_OPENROUTER_MODEL,
      moltbookApiKey: "",
      linearApiKey: "",
      // Malformed values are normalized to defaults for all fields
      claudeOAuthToken: "",
      openaiApiKey: "",
      anthropicApiKey: "",
      embeddingProvider: "none",
      embeddingApiKey: "",
      embeddingModel: "",
      embeddingBaseUrl: "http://localhost:11434",
      // Semantic memory v2: malformed values also normalize to defaults
      memory: DEFAULT_MEMORY_SETTINGS,
      onboardingCompleted: false,
      updatedAt: 0,
    });
  });
});

// ─── Semantic memory v2 settings (design doc §3.1/§3.2) ──────────────────────

describe("settings-manager memory section", () => {
  it("exposes the documented decay/recall defaults", () => {
    // Validates §3.1 defaults: 90d/30d/7d/60d half-lives (hours) with
    // ×1.5/1.5/1.2/1.2 reinforcement, and recall depths 4/6/2/3.
    // (memory is typed optional for pre-v2 mock compat but always populated)
    const memory = getSettings().memory!;
    expect(memory.decay.global).toEqual({ halfLifeHours: 2160, reinforceMultiplier: 1.5 });
    expect(memory.decay.repo).toEqual({ halfLifeHours: 720, reinforceMultiplier: 1.5 });
    expect(memory.decay.session).toEqual({ halfLifeHours: 168, reinforceMultiplier: 1.2 });
    expect(memory.decay.agent).toEqual({ halfLifeHours: 1440, reinforceMultiplier: 1.2 });
    expect(memory.recallDepth).toEqual({ session: 4, repo: 6, agent: 2, global: 3 });
  });

  it("deep-merges a partial memory patch over current values and persists it", () => {
    // A patch touching only decay.repo.halfLifeHours must not clobber the
    // sibling multiplier, the other namespace classes, or recallDepth.
    const updated = updateSettings({ memory: { decay: { repo: { halfLifeHours: 100 } } } });
    expect(updated.memory!.decay.repo).toEqual({ halfLifeHours: 100, reinforceMultiplier: 1.5 });
    expect(updated.memory!.decay.global).toEqual(DEFAULT_MEMORY_SETTINGS.decay.global);
    expect(updated.memory!.recallDepth).toEqual(DEFAULT_MEMORY_SETTINGS.recallDepth);

    const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(saved.memory.decay.repo.halfLifeHours).toBe(100);
  });

  it("preserves an explicit null half-life (never decays)", () => {
    // §3.2: halfLifeHours = null means no decay (used for pinned/curated memories)
    const updated = updateSettings({ memory: { decay: { global: { halfLifeHours: null } } } });
    expect(updated.memory!.decay.global.halfLifeHours).toBeNull();
  });

  it("normalizes invalid memory values back to defaults", () => {
    // Negative half-lives, sub-1 multipliers, and negative depths are rejected
    const updated = updateSettings({
      memory: {
        decay: { repo: { halfLifeHours: -5, reinforceMultiplier: 0.5 } },
        recallDepth: { repo: -1, session: 2.9 },
      },
    });
    expect(updated.memory!.decay.repo).toEqual(DEFAULT_MEMORY_SETTINGS.decay.repo);
    expect(updated.memory!.recallDepth.repo).toBe(DEFAULT_MEMORY_SETTINGS.recallDepth.repo);
    // Fractional depths are floored
    expect(updated.memory!.recallDepth.session).toBe(2);
  });

  it("loads a partial memory section from disk merged with defaults", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ memory: { recallDepth: { repo: 9 } } }),
      "utf-8",
    );
    _resetForTest(settingsPath);
    const memory = getSettings().memory!;
    expect(memory.recallDepth.repo).toBe(9);
    expect(memory.recallDepth.global).toBe(3);
    expect(memory.decay).toEqual(DEFAULT_MEMORY_SETTINGS.decay);
  });

  it("normalizeMemorySettings handles garbage input", () => {
    // Non-object / array / nested-garbage inputs all yield the full default shape
    expect(normalizeMemorySettings(null)).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(normalizeMemorySettings("nope")).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(normalizeMemorySettings({ decay: "x", recallDepth: 7 })).toEqual(DEFAULT_MEMORY_SETTINGS);
  });
});
