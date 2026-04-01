import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Mock homedir so the registry writes to a temp directory ─────────────────

let tempDir: string;

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => { dir = d; },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

let AdapterRegistry: typeof import("./adapter-registry.js").AdapterRegistry;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "adapter-registry-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  const mod = await import("./adapter-registry.js");
  AdapterRegistry = mod.AdapterRegistry;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function adaptersDir(): string {
  return join(tempDir, ".campfire", "adapters");
}

/**
 * Create a mock adapter directory with a package.json containing
 * the given campfireAdapter metadata.
 */
function createMockAdapter(
  name: string,
  campfireAdapter: Record<string, unknown>,
  pkgOverrides: Record<string, unknown> = {},
): string {
  const dir = join(adaptersDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `campfire-adapter-${name}`,
      version: "1.0.0",
      campfireAdapter,
      ...pkgOverrides,
    }),
    "utf-8",
  );
  return dir;
}

/**
 * Write a metadata.json alongside the package.json to persist
 * installedAt and npmPackage info.
 */
function writeMockMetadataJson(
  name: string,
  meta: { installedAt?: number; npmPackage?: string } = {},
): void {
  const dir = join(adaptersDir(), name);
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify({
      installedAt: meta.installedAt ?? Date.now(),
      npmPackage: meta.npmPackage ?? `campfire-adapter-${name}`,
    }),
    "utf-8",
  );
}

// =============================================================================
// scan()
// =============================================================================
describe("scan", () => {
  it("discovers adapters with valid campfireAdapter metadata", () => {
    // Place a mock adapter in the adapters directory
    createMockAdapter("test-agent", {
      name: "test-agent",
      displayName: "Test Agent",
      version: "1.2.3",
      models: [{ value: "gpt-4", label: "GPT-4" }],
      modes: [{ value: "auto", label: "Auto" }],
      protocol: "stdio",
    });
    writeMockMetadataJson("test-agent", { npmPackage: "@test/agent" });

    const registry = new AdapterRegistry();
    const list = registry.listInstalled();

    expect(list).toHaveLength(1);
    expect(list[0].metadata.name).toBe("test-agent");
    expect(list[0].metadata.displayName).toBe("Test Agent");
    expect(list[0].metadata.version).toBe("1.2.3");
    expect(list[0].metadata.protocol).toBe("stdio");
    expect(list[0].npmPackage).toBe("@test/agent");
  });

  it("skips directories without a package.json", () => {
    const dir = join(adaptersDir(), "empty-dir");
    mkdirSync(dir, { recursive: true });

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(0);
  });

  it("skips directories with invalid package.json JSON", () => {
    const dir = join(adaptersDir(), "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "NOT VALID JSON{{{", "utf-8");

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(0);
  });

  it("skips packages without campfireAdapter field", () => {
    const dir = join(adaptersDir(), "plain-pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "plain-pkg", version: "1.0.0" }),
      "utf-8",
    );

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(0);
  });

  it("discovers multiple adapters across subdirectories", () => {
    createMockAdapter("agent-a", { name: "agent-a", displayName: "Agent A" });
    createMockAdapter("agent-b", { name: "agent-b", displayName: "Agent B" });
    createMockAdapter("agent-c", { name: "agent-c", displayName: "Agent C" });

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(3);
  });

  it("skips regular files (not directories) in the adapters dir", () => {
    mkdirSync(adaptersDir(), { recursive: true });
    writeFileSync(join(adaptersDir(), "stray-file.txt"), "hello", "utf-8");

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(0);
  });

  it("re-scan clears previously discovered adapters that are gone", () => {
    createMockAdapter("transient", { name: "transient", displayName: "Transient" });

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(1);

    // Remove the adapter directory
    rmSync(join(adaptersDir(), "transient"), { recursive: true, force: true });

    // Re-scan should find nothing
    registry.scan();
    expect(registry.listInstalled()).toHaveLength(0);
  });
});

// =============================================================================
// validate()
// =============================================================================
describe("validate", () => {
  it("returns metadata for a valid adapter", () => {
    const dir = createMockAdapter("valid", {
      name: "valid",
      displayName: "Valid Adapter",
      version: "2.0.0",
      models: [{ value: "m1", label: "Model 1" }],
      modes: [{ value: "fast", label: "Fast" }],
      protocol: "websocket",
      description: "A valid adapter",
      author: "Test Author",
      homepage: "https://example.com",
      binaryName: "valid-cli",
    });

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("valid");
    expect(meta!.displayName).toBe("Valid Adapter");
    expect(meta!.version).toBe("2.0.0");
    expect(meta!.protocol).toBe("websocket");
    expect(meta!.models).toEqual([{ value: "m1", label: "Model 1" }]);
    expect(meta!.modes).toEqual([{ value: "fast", label: "Fast" }]);
    expect(meta!.description).toBe("A valid adapter");
    expect(meta!.author).toBe("Test Author");
    expect(meta!.homepage).toBe("https://example.com");
    expect(meta!.binaryName).toBe("valid-cli");
  });

  it("returns null when package.json is missing", () => {
    const dir = join(adaptersDir(), "no-pkg");
    mkdirSync(dir, { recursive: true });

    const registry = new AdapterRegistry();
    expect(registry.validate(dir)).toBeNull();
  });

  it("returns null when campfireAdapter field is missing", () => {
    const dir = join(adaptersDir(), "no-field");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "no-field", version: "1.0.0" }),
      "utf-8",
    );

    const registry = new AdapterRegistry();
    expect(registry.validate(dir)).toBeNull();
  });

  it("returns null when campfireAdapter.name is missing", () => {
    const dir = createMockAdapter("no-name", {
      displayName: "No Name",
    });

    const registry = new AdapterRegistry();
    expect(registry.validate(dir)).toBeNull();
  });

  it("returns null when campfireAdapter.displayName is missing", () => {
    const dir = createMockAdapter("no-display", {
      name: "no-display",
    });

    const registry = new AdapterRegistry();
    expect(registry.validate(dir)).toBeNull();
  });

  it("returns null when campfireAdapter.name is empty string", () => {
    const dir = createMockAdapter("empty-name", {
      name: "",
      displayName: "Empty Name",
    });

    const registry = new AdapterRegistry();
    expect(registry.validate(dir)).toBeNull();
  });

  it("defaults models to [Default] when not provided", () => {
    const dir = createMockAdapter("no-models", {
      name: "no-models",
      displayName: "No Models",
    });

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.models).toEqual([{ value: "default", label: "Default" }]);
  });

  it("defaults modes to [Default] when not provided", () => {
    const dir = createMockAdapter("no-modes", {
      name: "no-modes",
      displayName: "No Modes",
    });

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.modes).toEqual([{ value: "default", label: "Default" }]);
  });

  it("defaults protocol to stdio when not provided", () => {
    const dir = createMockAdapter("no-proto", {
      name: "no-proto",
      displayName: "No Protocol",
    });

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.protocol).toBe("stdio");
  });

  it("falls back to package.json version when campfireAdapter.version is missing", () => {
    const dir = createMockAdapter(
      "fallback-version",
      { name: "fallback-version", displayName: "Fallback Version" },
      { version: "3.5.1" },
    );

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.version).toBe("3.5.1");
  });

  it("defaults version to 0.0.0 when neither source has it", () => {
    const dir = join(adaptersDir(), "no-version");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "no-version-pkg",
        campfireAdapter: { name: "no-version", displayName: "No Version" },
      }),
      "utf-8",
    );

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.version).toBe("0.0.0");
  });

  it("defaults models to [Default] when empty array is provided", () => {
    const dir = createMockAdapter("empty-models", {
      name: "empty-models",
      displayName: "Empty Models",
      models: [],
    });

    const registry = new AdapterRegistry();
    const meta = registry.validate(dir);

    expect(meta).not.toBeNull();
    expect(meta!.models).toEqual([{ value: "default", label: "Default" }]);
  });
});

// =============================================================================
// uninstall()
// =============================================================================
describe("uninstall", () => {
  it("removes an installed adapter and its directory", () => {
    createMockAdapter("removable", {
      name: "removable",
      displayName: "Removable",
    });

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(1);

    const result = registry.uninstall("removable");
    expect(result).toBe(true);
    expect(registry.getAdapter("removable")).toBeNull();
    expect(existsSync(join(adaptersDir(), "removable"))).toBe(false);
  });

  it("returns false when adapter does not exist", () => {
    const registry = new AdapterRegistry();
    expect(registry.uninstall("nonexistent")).toBe(false);
  });

  it("removes from installed map even when directory is already gone", () => {
    createMockAdapter("ghost", { name: "ghost", displayName: "Ghost" });

    const registry = new AdapterRegistry();
    expect(registry.getAdapter("ghost")).not.toBeNull();

    // Manually remove the directory
    rmSync(join(adaptersDir(), "ghost"), { recursive: true, force: true });

    // uninstall should still clean up the map, but return false (dir not found)
    const result = registry.uninstall("ghost");
    expect(result).toBe(false);
    expect(registry.getAdapter("ghost")).toBeNull();
  });

  it("does not affect other installed adapters", () => {
    createMockAdapter("keep", { name: "keep", displayName: "Keep" });
    createMockAdapter("remove", { name: "remove", displayName: "Remove" });

    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toHaveLength(2);

    registry.uninstall("remove");

    expect(registry.listInstalled()).toHaveLength(1);
    expect(registry.getAdapter("keep")).not.toBeNull();
    expect(registry.getAdapter("remove")).toBeNull();
  });
});

// =============================================================================
// listInstalled() and getAdapter()
// =============================================================================
describe("listInstalled and getAdapter", () => {
  it("returns empty list when no adapters are installed", () => {
    const registry = new AdapterRegistry();
    expect(registry.listInstalled()).toEqual([]);
  });

  it("returns all installed adapters after scan", () => {
    createMockAdapter("alpha", { name: "alpha", displayName: "Alpha Agent" });
    createMockAdapter("beta", { name: "beta", displayName: "Beta Agent" });

    const registry = new AdapterRegistry();
    const list = registry.listInstalled();

    expect(list).toHaveLength(2);
    const names = list.map((a) => a.metadata.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("getAdapter returns the correct adapter by name", () => {
    createMockAdapter("target", {
      name: "target",
      displayName: "Target Agent",
      version: "4.0.0",
    });

    const registry = new AdapterRegistry();
    const adapter = registry.getAdapter("target");

    expect(adapter).not.toBeNull();
    expect(adapter!.metadata.name).toBe("target");
    expect(adapter!.metadata.displayName).toBe("Target Agent");
    expect(adapter!.metadata.version).toBe("4.0.0");
  });

  it("getAdapter returns null for unknown name", () => {
    const registry = new AdapterRegistry();
    expect(registry.getAdapter("unknown")).toBeNull();
  });
});

// =============================================================================
// getBackendConfigs()
// =============================================================================
describe("getBackendConfigs", () => {
  it("returns empty array when no adapters are installed", () => {
    const registry = new AdapterRegistry();
    expect(registry.getBackendConfigs()).toEqual([]);
  });

  it("returns config objects with correct id, name, and available fields", () => {
    createMockAdapter("my-agent", {
      name: "my-agent",
      displayName: "My Custom Agent",
    });
    createMockAdapter("other-agent", {
      name: "other-agent",
      displayName: "Other Agent",
    });

    const registry = new AdapterRegistry();
    const configs = registry.getBackendConfigs();

    expect(configs).toHaveLength(2);

    // Sort for deterministic assertions
    configs.sort((a, b) => a.id.localeCompare(b.id));

    expect(configs[0]).toEqual({
      id: "my-agent",
      name: "My Custom Agent",
      available: true,
    });
    expect(configs[1]).toEqual({
      id: "other-agent",
      name: "Other Agent",
      available: true,
    });
  });

  it("marks all installed adapters as available", () => {
    createMockAdapter("avail", { name: "avail", displayName: "Available" });

    const registry = new AdapterRegistry();
    const configs = registry.getBackendConfigs();

    expect(configs).toHaveLength(1);
    expect(configs[0].available).toBe(true);
  });
});

// =============================================================================
// install() — input validation only (no actual npm install)
// =============================================================================
describe("install input validation", () => {
  it("rejects empty package name", async () => {
    const registry = new AdapterRegistry();
    await expect(registry.install("")).rejects.toThrow("Invalid npm package name");
  });

  it("rejects package names with shell metacharacters", async () => {
    const registry = new AdapterRegistry();
    await expect(registry.install("pkg; rm -rf /")).rejects.toThrow("Invalid npm package name");
    await expect(registry.install("pkg && echo pwned")).rejects.toThrow("Invalid npm package name");
    await expect(registry.install("$(whoami)")).rejects.toThrow("Invalid npm package name");
    await expect(registry.install("pkg`id`")).rejects.toThrow("Invalid npm package name");
  });

  it("accepts valid scoped package names", async () => {
    // This will fail at the bun add step (package doesn't exist), but should
    // NOT fail at the sanitization step. We catch the install error.
    const registry = new AdapterRegistry();
    try {
      await registry.install("@campfire/test-adapter");
    } catch (e: unknown) {
      // Should fail during bun add, not during sanitization
      expect((e as Error).message).not.toContain("Invalid npm package name");
    }
  });

  it("accepts valid package names with version suffix", async () => {
    const registry = new AdapterRegistry();
    try {
      await registry.install("some-adapter@1.2.3");
    } catch (e: unknown) {
      expect((e as Error).message).not.toContain("Invalid npm package name");
    }
  });
});
