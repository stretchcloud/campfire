import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import { GooseAdapter } from "./goose-adapter.js";
import { ClaudeStdioAdapter } from "./claude-stdio-adapter.js";
import type { AgentAdapter } from "./adapter-types.js";

/**
 * Structural typing tests for the AgentAdapter interface.
 *
 * These tests verify that stdio adapters satisfy the
 * AgentAdapter contract. Since TypeScript uses structural typing and both
 * classes declare `implements AgentAdapter`, a compile-time check is
 * sufficient — but we also verify at runtime that the required methods exist.
 */

const REQUIRED_METHODS: (keyof AgentAdapter)[] = [
  "sendBrowserMessage",
  "onBrowserMessage",
  "onSessionMeta",
  "onDisconnect",
  "onInitError",
  "isConnected",
  "disconnect",
  "getBackendSessionId",
];

describe("AgentAdapter interface", () => {
  it("CodexAdapter has all AgentAdapter methods", () => {
    // Verify structural compatibility at compile time via type assertion
    const _typeCheck: AgentAdapter = {} as CodexAdapter;
    void _typeCheck;

    // Verify at runtime that all required methods exist on the prototype
    for (const method of REQUIRED_METHODS) {
      expect(typeof CodexAdapter.prototype[method]).toBe("function");
    }
  });

  it("GooseAdapter has all AgentAdapter methods", () => {
    // Verify structural compatibility at compile time via type assertion
    const _typeCheck: AgentAdapter = {} as GooseAdapter;
    void _typeCheck;

    // Verify at runtime that all required methods exist on the prototype
    for (const method of REQUIRED_METHODS) {
      expect(typeof GooseAdapter.prototype[method]).toBe("function");
    }
  });

  it("ClaudeStdioAdapter has all AgentAdapter methods", () => {
    const _typeCheck: AgentAdapter = {} as ClaudeStdioAdapter;
    void _typeCheck;

    for (const method of REQUIRED_METHODS) {
      expect(typeof ClaudeStdioAdapter.prototype[method]).toBe("function");
    }
  });

  it("getBackendSessionId is defined on adapter prototypes", () => {
    // Adapters have getBackendSessionId (the unified method)
    // alongside backend-specific ID getters where applicable.
    // We verify the prototype method exists without instantiating
    // since constructors have side effects (reading stdio, etc.).
    expect(typeof CodexAdapter.prototype.getBackendSessionId).toBe("function");
    expect(typeof CodexAdapter.prototype.getThreadId).toBe("function");
    expect(typeof GooseAdapter.prototype.getBackendSessionId).toBe("function");
    expect(typeof GooseAdapter.prototype.getGooseSessionId).toBe("function");
    expect(typeof ClaudeStdioAdapter.prototype.getBackendSessionId).toBe("function");
  });
});
