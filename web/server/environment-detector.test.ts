import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectEnvironment } from "./environment-detector.js";

describe("detectEnvironment", () => {
  it("detects framework, service, and missing database env from bounded project files", () => {
    // Validates the main session-start scanner path without crawling arbitrary source trees.
    const cwd = mkdtempSync(join(tmpdir(), "campfire-env-"));
    mkdirSync(join(cwd, "prisma"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      dependencies: {
        next: "latest",
        stripe: "latest",
        "@prisma/client": "latest",
      },
    }));
    writeFileSync(join(cwd, "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" }\n");
    writeFileSync(join(cwd, ".env"), "STRIPE_SECRET_KEY=sk_test\n");

    const detected = detectEnvironment(cwd);
    const ids = detected.rules.map((rule) => rule.id);

    expect(ids).toContain("vercel");
    expect(ids).toContain("stripe");
    expect(ids).toContain("prisma");
    expect(detected.rules.find((rule) => rule.id === "prisma")?.envMissing).toEqual(["DATABASE_URL"]);
    expect(detected.rules.find((rule) => rule.id === "stripe")?.envPresent).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("detects Docker, Fly.io, GitHub Actions, and database env markers", () => {
    // Covers non-package detection rules and nested workflow directory handling.
    const cwd = mkdtempSync(join(tmpdir(), "campfire-env-"));
    mkdirSync(join(cwd, ".github", "workflows"), { recursive: true });
    writeFileSync(join(cwd, "Dockerfile"), "FROM node:22\n");
    writeFileSync(join(cwd, "fly.toml"), "app = \"demo\"\n");
    writeFileSync(join(cwd, ".env.local"), "DATABASE_URL=postgres://local\n");

    const ids = detectEnvironment(cwd).rules.map((rule) => rule.id);

    expect(ids).toContain("docker");
    expect(ids).toContain("flyio");
    expect(ids).toContain("github-actions");
    expect(ids).toContain("database");
  });
});
