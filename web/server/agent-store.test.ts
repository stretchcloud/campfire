import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Agent store tests.
 *
 * Tests CRUD operations for agent profiles and execution history.
 * Uses a temp directory to avoid polluting the real ~/.campfire/agents/ path.
 * Since agent-store.ts uses a hardcoded path, we test the slugify and
 * validation logic via the public API behavior.
 */

// We test the store module's internal logic by importing and calling it.
// The store writes to ~/.campfire/agents/ which may not exist in CI,
// so these tests focus on the validation logic that throws before I/O.
import * as agentStore from "./agent-store.js";

describe("agent-store", () => {
  describe("createAgent validation", () => {
    it("should reject empty name", () => {
      expect(() =>
        agentStore.createAgent({
          name: "",
          description: "test",
          backendType: "claude",
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/tmp",
          prompt: "do something",
          enabled: true,
        }),
      ).toThrow("Agent name is required");
    });

    it("should reject empty prompt", () => {
      expect(() =>
        agentStore.createAgent({
          name: "test-agent",
          description: "test",
          backendType: "claude",
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/tmp",
          prompt: "",
          enabled: true,
        }),
      ).toThrow("Agent prompt is required");
    });

    it("should reject empty working directory", () => {
      expect(() =>
        agentStore.createAgent({
          name: "test-agent",
          description: "test",
          backendType: "claude",
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "",
          prompt: "do something",
          enabled: true,
        }),
      ).toThrow("Agent working directory is required");
    });

    it("should reject name with only special characters", () => {
      expect(() =>
        agentStore.createAgent({
          name: "!!!",
          description: "test",
          backendType: "claude",
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/tmp",
          prompt: "do something",
          enabled: true,
        }),
      ).toThrow("Agent name must contain alphanumeric characters");
    });
  });

  describe("listAgents", () => {
    it("should return an array (empty or with existing agents)", () => {
      // This test verifies the function doesn't crash and returns an array
      const agents = agentStore.listAgents();
      expect(Array.isArray(agents)).toBe(true);
    });
  });

  describe("getAgent", () => {
    it("should return null for non-existent agent", () => {
      const agent = agentStore.getAgent("does-not-exist-" + Date.now());
      expect(agent).toBeNull();
    });
  });

  describe("deleteAgent", () => {
    it("should return false for non-existent agent", () => {
      const deleted = agentStore.deleteAgent("does-not-exist-" + Date.now());
      expect(deleted).toBe(false);
    });
  });

  describe("listExecutions", () => {
    it("should return empty array for non-existent agent", () => {
      const executions = agentStore.listExecutions("does-not-exist-" + Date.now());
      expect(executions).toEqual([]);
    });
  });
});
