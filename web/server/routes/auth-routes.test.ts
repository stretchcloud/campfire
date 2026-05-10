import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHomedir = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.value };
});

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "auth-routes-test-"));
  mockHomedir.value = tempHome;
  delete process.env.CAMPFIRE_PASSWORD;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CAMPFIRE_PASSWORD;
  rmSync(tempHome, { recursive: true, force: true });
});

async function createAuthApp(): Promise<Hono> {
  const { registerAuthRoutes } = await import("./auth-routes.js");
  const app = new Hono();
  registerAuthRoutes(app, {} as any);
  return app;
}

describe("auth routes", () => {
  it("sets up password authentication when auth is disabled", async () => {
    // This is the endpoint used by Settings > Security to enable password auth.
    const app = await createAuthApp();

    const res = await app.request("/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "valid-password" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      enabled: true,
      hasPassword: true,
      activeSessions: 0,
    });
  });

  it("rejects short setup passwords", async () => {
    // The UI disables short passwords, but the server must enforce the boundary.
    const app = await createAuthApp();

    const res = await app.request("/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "abc" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Password must be at least 4 characters",
    });
  });
});
