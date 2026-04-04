import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "../store.js";
import type { SdkSessionInfo, BackgroundAgentItem } from "../types.js";

/**
 * SessionPulse unit tests.
 *
 * Validates the Zustand store interactions that drive the SessionPulse component:
 * - Per-session background agent tracking (add, update lifecycle)
 * - Cross-session activity filtering (non-current, running sessions)
 * - Permission badge counts across sessions
 * - Cleanup on session removal
 */

// Polyfill localStorage for Node environment (store.ts uses it for persistence)
if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    writable: true,
    configurable: true,
  });
}

function makeSdkSession(overrides: Partial<SdkSessionInfo> & { sessionId: string }): SdkSessionInfo {
  return {
    cwd: "/tmp/test",
    state: "connected",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<BackgroundAgentItem> & { toolUseId: string }): BackgroundAgentItem {
  return {
    name: "Test agent",
    description: "A test agent",
    agentType: "general-purpose",
    status: "running",
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("SessionPulse store integration", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  // ─── Background Agent Tracking ──────────────────────────────────────────

  describe("background agent tracking", () => {
    it("should add a background agent to a session", () => {
      const store = useStore.getState();
      const agent = makeAgent({ toolUseId: "tu-1", name: "Explore codebase" });

      store.addBackgroundAgent("session-1", agent);

      const agents = useStore.getState().sessionBackgroundAgents.get("session-1");
      expect(agents).toHaveLength(1);
      expect(agents![0].toolUseId).toBe("tu-1");
      expect(agents![0].name).toBe("Explore codebase");
      expect(agents![0].status).toBe("running");
    });

    it("should track multiple agents per session", () => {
      const store = useStore.getState();
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-1", name: "Agent A", agentType: "Explore" }));
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-2", name: "Agent B", agentType: "general-purpose" }));

      const agents = useStore.getState().sessionBackgroundAgents.get("session-1");
      expect(agents).toHaveLength(2);
      expect(agents!.map((a) => a.name)).toEqual(["Agent A", "Agent B"]);
    });

    it("should update agent status to completed with summary", () => {
      const store = useStore.getState();
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-1" }));

      store.updateBackgroundAgent("session-1", "tu-1", {
        status: "completed",
        completedAt: Date.now(),
        summary: "Found 3 matching files",
      });

      const agents = useStore.getState().sessionBackgroundAgents.get("session-1");
      expect(agents![0].status).toBe("completed");
      expect(agents![0].summary).toBe("Found 3 matching files");
      expect(agents![0].completedAt).toBeDefined();
    });

    it("should update agent status to failed", () => {
      const store = useStore.getState();
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-1" }));

      store.updateBackgroundAgent("session-1", "tu-1", {
        status: "failed",
        completedAt: Date.now(),
      });

      const agents = useStore.getState().sessionBackgroundAgents.get("session-1");
      expect(agents![0].status).toBe("failed");
    });

    it("should isolate agents between sessions", () => {
      const store = useStore.getState();
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-1", name: "Agent for S1" }));
      store.addBackgroundAgent("session-2", makeAgent({ toolUseId: "tu-2", name: "Agent for S2" }));

      const s1Agents = useStore.getState().sessionBackgroundAgents.get("session-1");
      const s2Agents = useStore.getState().sessionBackgroundAgents.get("session-2");
      expect(s1Agents).toHaveLength(1);
      expect(s2Agents).toHaveLength(1);
      expect(s1Agents![0].name).toBe("Agent for S1");
      expect(s2Agents![0].name).toBe("Agent for S2");
    });
  });

  // ─── Cross-Session Activity ─────────────────────────────────────────────

  describe("cross-session activity", () => {
    it("should track session status for multiple sessions", () => {
      const store = useStore.getState();
      store.setSessionStatus("session-1", "running");
      store.setSessionStatus("session-2", "idle");
      store.setSessionStatus("session-3", "compacting");

      const state = useStore.getState();
      expect(state.sessionStatus.get("session-1")).toBe("running");
      expect(state.sessionStatus.get("session-2")).toBe("idle");
      expect(state.sessionStatus.get("session-3")).toBe("compacting");
    });

    it("should filter archived sessions from SDK sessions list", () => {
      const sessions: SdkSessionInfo[] = [
        makeSdkSession({ sessionId: "active-1" }),
        makeSdkSession({ sessionId: "archived-1", archived: true }),
        makeSdkSession({ sessionId: "active-2" }),
      ];

      useStore.getState().setSdkSessions(sessions);
      const state = useStore.getState();

      const nonArchived = state.sdkSessions.filter((s) => !s.archived);
      expect(nonArchived).toHaveLength(2);
      expect(nonArchived.map((s) => s.sessionId)).toEqual(["active-1", "active-2"]);
    });

    it("should exclude the current session from background activity list", () => {
      const sessions: SdkSessionInfo[] = [
        makeSdkSession({ sessionId: "current" }),
        makeSdkSession({ sessionId: "background-1" }),
        makeSdkSession({ sessionId: "background-2" }),
      ];

      const store = useStore.getState();
      store.setSdkSessions(sessions);
      store.setCurrentSession("current");

      const state = useStore.getState();
      const background = state.sdkSessions.filter(
        (s) => !s.archived && s.sessionId !== state.currentSessionId
      );
      expect(background).toHaveLength(2);
      expect(background.map((s) => s.sessionId)).toEqual(["background-1", "background-2"]);
    });

    it("should track pending permissions per session for badge count", () => {
      const store = useStore.getState();

      store.addPermission("session-1", {
        request_id: "perm-1", tool_use_id: "tu-1", tool_name: "Bash",
        input: { command: "ls" }, timestamp: Date.now(),
      });
      store.addPermission("session-1", {
        request_id: "perm-2", tool_use_id: "tu-2", tool_name: "Write",
        input: { file_path: "/tmp/test.ts", content: "" }, timestamp: Date.now(),
      });
      store.addPermission("session-2", {
        request_id: "perm-3", tool_use_id: "tu-3", tool_name: "Edit",
        input: { file_path: "/tmp/a.ts" }, timestamp: Date.now(),
      });

      const state = useStore.getState();
      expect(state.pendingPermissions.get("session-1")?.size).toBe(2);
      expect(state.pendingPermissions.get("session-2")?.size).toBe(1);

      // Total pending (what SessionPulse shows in the pill badge)
      let totalPerms = 0;
      for (const perms of state.pendingPermissions.values()) {
        totalPerms += perms.size;
      }
      expect(totalPerms).toBe(3);
    });

    it("should only surface sessions that are running, compacting, or have pending permissions", () => {
      const sessions: SdkSessionInfo[] = [
        makeSdkSession({ sessionId: "running-1" }),
        makeSdkSession({ sessionId: "idle-1" }),
        makeSdkSession({ sessionId: "idle-with-perms" }),
        makeSdkSession({ sessionId: "compacting-1" }),
      ];

      const store = useStore.getState();
      store.setSdkSessions(sessions);
      store.setCurrentSession("some-other-session");
      store.setSessionStatus("running-1", "running");
      store.setSessionStatus("idle-1", "idle");
      store.setSessionStatus("idle-with-perms", "idle");
      store.setSessionStatus("compacting-1", "compacting");
      store.addPermission("idle-with-perms", {
        request_id: "perm-1", tool_use_id: "tu-1", tool_name: "Bash",
        input: { command: "test" }, timestamp: Date.now(),
      });

      const state = useStore.getState();

      // Replicate SessionPulse's filter logic
      const activities = state.sdkSessions
        .filter((s) => !s.archived && s.sessionId !== state.currentSessionId)
        .map((s) => {
          const status = state.sessionStatus.get(s.sessionId);
          const perms = state.pendingPermissions.get(s.sessionId);
          return {
            sessionId: s.sessionId,
            status: status || "disconnected",
            pendingPerms: perms ? perms.size : 0,
          };
        })
        .filter((a) => a.status === "running" || a.status === "compacting" || a.pendingPerms > 0);

      expect(activities).toHaveLength(3);
      expect(activities.map((a) => a.sessionId)).toEqual([
        "running-1",
        "idle-with-perms",
        "compacting-1",
      ]);
    });
  });

  // ─── Cleanup ────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("should clean up all session data including background agents on removal", () => {
      const store = useStore.getState();
      store.setSdkSessions([makeSdkSession({ sessionId: "to-remove" })]);
      store.setSessionStatus("to-remove", "running");
      store.setSessionName("to-remove", "Test Session");
      store.addBackgroundAgent("to-remove", makeAgent({ toolUseId: "tu-1" }));
      store.addPermission("to-remove", {
        request_id: "perm-1", tool_use_id: "tu-1", tool_name: "Bash",
        input: { command: "ls" }, timestamp: Date.now(),
      });

      store.removeSession("to-remove");

      const state = useStore.getState();
      expect(state.sessionStatus.has("to-remove")).toBe(false);
      expect(state.pendingPermissions.has("to-remove")).toBe(false);
      expect(state.sessionBackgroundAgents.has("to-remove")).toBe(false);
    });

    it("should clear background agents on reset", () => {
      const store = useStore.getState();
      store.addBackgroundAgent("session-1", makeAgent({ toolUseId: "tu-1" }));

      store.reset();

      const state = useStore.getState();
      expect(state.sessionBackgroundAgents.size).toBe(0);
    });
  });
});
