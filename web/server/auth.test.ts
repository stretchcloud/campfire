/**
 * Tests for auth.ts — password hashing, legacy-hash migration, and session tokens.
 *
 * Validates:
 * - setPassword() stores a salted scrypt hash (never an unsalted digest)
 * - login() accepts the correct password and rejects wrong ones
 * - legacy unsalted SHA-256 hashes (pre-migration auth.json) still authenticate
 *   and are transparently upgraded to scrypt on first successful login
 * - CAMPFIRE_PASSWORD env var takes priority over the saved config
 * - session tokens verify while fresh and expire after 7 days
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHomedir = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.value };
});

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "auth-test-"));
  mockHomedir.value = tempHome;
  delete process.env.CAMPFIRE_PASSWORD;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CAMPFIRE_PASSWORD;
  vi.useRealTimers();
  rmSync(tempHome, { recursive: true, force: true });
});

function authFilePath(): string {
  return join(tempHome, ".campfire", "auth.json");
}

function readAuthConfig(): { passwordHash: string; sessions: { token: string; createdAt: number }[]; enabled: boolean } {
  return JSON.parse(readFileSync(authFilePath(), "utf-8"));
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function loadAuth() {
  return import("./auth.js");
}

describe("password hashing", () => {
  it("stores a salted scrypt hash, not an unsalted digest", async () => {
    const auth = await loadAuth();
    auth.setPassword("hunter2-hunter2");

    const config = readAuthConfig();
    // Format: scrypt:<saltHex>:<hashHex> — a legacy hash would be a bare 64-char hex string.
    expect(config.passwordHash).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(config.passwordHash).not.toBe(sha256("hunter2-hunter2"));
    expect(config.enabled).toBe(true);
  });

  it("produces a different hash for the same password each time (random salt)", async () => {
    const auth = await loadAuth();
    auth.setPassword("same-password-1234");
    const first = readAuthConfig().passwordHash;
    auth.setPassword("same-password-1234");
    const second = readAuthConfig().passwordHash;
    expect(first).not.toBe(second);
  });

  it("accepts the correct password and rejects a wrong one", async () => {
    const auth = await loadAuth();
    auth.setPassword("correct-horse-battery");

    expect(auth.login("wrong-password")).toBeNull();
    const token = auth.login("correct-horse-battery");
    expect(token).toBeTruthy();
    expect(auth.verifyToken(token as string)).toBe(true);
  });
});

describe("legacy SHA-256 hash migration", () => {
  it("authenticates against a legacy unsalted hash and upgrades it to scrypt", async () => {
    // Simulate a pre-migration auth.json written by the old sha256-only code.
    mkdirSync(join(tempHome, ".campfire"), { recursive: true });
    writeFileSync(authFilePath(), JSON.stringify({
      passwordHash: sha256("legacy-password-99"),
      sessions: [],
      enabled: true,
    }));

    const auth = await loadAuth();
    const token = auth.login("legacy-password-99");
    expect(token).toBeTruthy();

    // The stored hash must now be the salted scrypt format.
    const migrated = readAuthConfig().passwordHash;
    expect(migrated).toMatch(/^scrypt:/);

    // And the password still works after migration.
    expect(auth.login("legacy-password-99")).toBeTruthy();
    expect(auth.login("wrong")).toBeNull();
  });

  it("does not upgrade the hash on a failed login attempt", async () => {
    mkdirSync(join(tempHome, ".campfire"), { recursive: true });
    const legacyHash = sha256("legacy-password-99");
    writeFileSync(authFilePath(), JSON.stringify({
      passwordHash: legacyHash,
      sessions: [],
      enabled: true,
    }));

    const auth = await loadAuth();
    expect(auth.login("not-the-password")).toBeNull();
    expect(readAuthConfig().passwordHash).toBe(legacyHash);
  });
});

describe("CAMPFIRE_PASSWORD env var", () => {
  it("takes priority over the saved config", async () => {
    process.env.CAMPFIRE_PASSWORD = "env-secret";
    const auth = await loadAuth();

    expect(auth.isAuthEnabled()).toBe(true);
    expect(auth.login("env-secret")).toBeTruthy();
    expect(auth.login("anything-else")).toBeNull();
  });
});

describe("session tokens", () => {
  it("rejects tokens older than the 7-day max age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));

    const auth = await loadAuth();
    auth.setPassword("expiring-token-pw");
    const token = auth.login("expiring-token-pw") as string;
    expect(auth.verifyToken(token)).toBe(true);

    // Just under 7 days: still valid.
    vi.setSystemTime(new Date("2026-07-07T23:00:00Z"));
    expect(auth.verifyToken(token)).toBe(true);

    // Past 7 days: expired.
    vi.setSystemTime(new Date("2026-07-08T01:00:00Z"));
    expect(auth.verifyToken(token)).toBe(false);
  });

  it("invalidates a token on logout", async () => {
    const auth = await loadAuth();
    auth.setPassword("logout-test-pw");
    const token = auth.login("logout-test-pw") as string;
    expect(auth.verifyToken(token)).toBe(true);
    auth.logout(token);
    expect(auth.verifyToken(token)).toBe(false);
  });
});
