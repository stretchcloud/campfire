import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process and fs before importing the module
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => []),
}));

vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn((name: string) => {
    if (name === "tmux") return "/usr/bin/tmux";
    if (name === "claude") return "/usr/local/bin/claude";
    if (name === "codex") return "/usr/local/bin/codex";
    return null;
  }),
}));

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dmuxManager } from "./dmux-manager.js";
import { resolveBinary } from "./path-resolver.js";

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockResolveBinary = resolveBinary as unknown as ReturnType<typeof vi.fn>;

describe("DmuxManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBinary.mockImplementation((name: string) => {
      if (name === "tmux") return "/usr/bin/tmux";
      if (name === "claude") return "/usr/local/bin/claude";
      if (name === "codex") return "/usr/local/bin/codex";
      return null;
    });
  });

  describe("getStatus", () => {
    it("returns running=false when no .dmux/dmux.config.json exists", () => {
      // readFileSync throws when config doesn't exist
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(false);
      expect(status.sessionName).toBeNull();
      expect(status.panes).toEqual([]);
      expect(status.totalPanes).toBe(0);
    });

    it("returns running=false when config exists but tmux session is gone", () => {
      // Config file exists with a session name
      mockReadFileSync.mockReturnValue(JSON.stringify({
        session_name: "dmux-abc",
        project_root: "/home/user/project",
        panes: [
          { id: "p1", slug: "cc-1", agent: "claude", pane_id: "%1", tmux_target: "dmux-abc:0.0" },
        ],
      }));

      // tmux has-session fails (session doesn't exist)
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) {
          throw new Error("session not found");
        }
        return "";
      });

      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(false);
      expect(status.sessionName).toBe("dmux-abc");
      expect(status.panes).toEqual([]);
    });

    it("returns running=false when tmux binary is unavailable", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        session_name: "dmux-abc",
        panes: [{ id: "p1", pane_id: "%1", tmux_target: "dmux-abc:0.0" }],
      }));
      mockResolveBinary.mockImplementation((name: string) => (name === "tmux" ? null : "/bin/ok"));

      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(false);
      expect(status.sessionName).toBe("dmux-abc");
      expect(status.panes).toEqual([]);
    });

    it("merges config + live tmux panes when session is running", () => {
      // Config with two panes
      mockReadFileSync.mockReturnValue(JSON.stringify({
        session_name: "dmux-abc",
        project_root: "/home/user/project",
        panes: [
          { id: "p1", slug: "cc-1", agent: "claude", pane_id: "%1", tmux_target: "dmux-abc:0.0", branch: "dmux/feat", worktree: "/tmp/wt1", status: "working" },
          { id: "p2", slug: "cx-1", agent: "codex", pane_id: "%2", tmux_target: "dmux-abc:0.1", branch: "dmux/fix", worktree: "/tmp/wt2", status: "idle" },
        ],
      }));

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) return "";
        if (typeof cmd === "string" && cmd.includes("list-panes")) {
          return "%1|dmux-abc:0.0|1\n%2|dmux-abc:0.1|0\n";
        }
        return "";
      });

      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(true);
      expect(status.sessionName).toBe("dmux-abc");
      expect(status.totalPanes).toBe(2);
      expect(status.panes[0]).toMatchObject({
        id: "p1",
        slug: "cc-1",
        agent: "claude",
        agentStatus: "working",
        branchName: "dmux/feat",
        isActive: true,
      });
      expect(status.panes[1]).toMatchObject({
        id: "p2",
        slug: "cx-1",
        agent: "codex",
        agentStatus: "idle",
        isActive: false,
      });
    });

    it("excludes config panes not found in live tmux output", () => {
      // Config has two panes but tmux only has one
      mockReadFileSync.mockReturnValue(JSON.stringify({
        session_name: "dmux-abc",
        project_root: "/home/user/project",
        panes: [
          { id: "p1", slug: "cc-1", agent: "claude", pane_id: "%1", tmux_target: "dmux-abc:0.0" },
          { id: "p2", slug: "cx-1", agent: "codex", pane_id: "%2", tmux_target: "dmux-abc:0.1" },
        ],
      }));

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) return "";
        if (typeof cmd === "string" && cmd.includes("list-panes")) {
          return "%1|dmux-abc:0.0|0\n";
        }
        return "";
      });

      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(true);
      expect(status.totalPanes).toBe(1);
      expect(status.panes[0].id).toBe("p1");
    });
  });

  describe("getAvailableAgents", () => {
    it("returns agents with availability based on resolved binaries", () => {
      const agents = dmuxManager.getAvailableAgents();
      const claude = agents.find((a) => a.id === "claude");
      const codex = agents.find((a) => a.id === "codex");
      const goose = agents.find((a) => a.id === "goose");

      // claude and codex are mocked as available, goose is not
      expect(claude?.available).toBe(true);
      expect(codex?.available).toBe(true);
      expect(goose?.available).toBe(false);
    });

    it("returns all known agents", () => {
      const agents = dmuxManager.getAvailableAgents();
      expect(agents.length).toBeGreaterThanOrEqual(5);
      expect(agents.map((a) => a.id)).toContain("claude");
      expect(agents.map((a) => a.id)).toContain("codex");
      expect(agents.map((a) => a.id)).toContain("goose");
    });
  });

  describe("focusPane", () => {
    it("runs correct tmux commands", () => {
      mockExecSync.mockReturnValue("");
      const result = dmuxManager.focusPane("dmux-abc:0.1");
      expect(result).toBe(true);

      // Should call select-window and select-pane
      expect(mockExecSync).toHaveBeenCalledTimes(2);
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls[0]).toContain("select-window");
      expect(calls[1]).toContain("select-pane");
    });

    it("returns false when tmux command fails", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("pane not found");
      });
      const result = dmuxManager.focusPane("bad:target");
      expect(result).toBe(false);
    });

    it("escapes single quotes in pane target", () => {
      mockExecSync.mockReturnValue("");
      dmuxManager.focusPane("dmux-'abc':0.1");

      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain("'\\''");
    });
  });

  describe("sendToPane", () => {
    it("runs correct tmux send-keys command", () => {
      mockExecSync.mockReturnValue("");
      const result = dmuxManager.sendToPane("dmux-abc:0.0", "n", true);
      expect(result).toBe(true);

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain("send-keys");
      expect(cmd).toContain("Enter");
    });

    it("omits Enter when enter=false", () => {
      mockExecSync.mockReturnValue("");
      dmuxManager.sendToPane("dmux-abc:0.0", "q", false);

      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain("send-keys");
      expect(cmd).not.toContain("Enter");
    });

    it("returns false on tmux error", () => {
      mockExecSync.mockImplementation(() => { throw new Error("error"); });
      expect(dmuxManager.sendToPane("bad:target", "x")).toBe(false);
    });

    it("escapes single quotes in keys", () => {
      mockExecSync.mockReturnValue("");
      dmuxManager.sendToPane("dmux-abc:0.0", "it's fine");

      const cmd = mockExecSync.mock.calls[0][0] as string;
      expect(cmd).toContain("'\\''");
    });
  });

  describe("buildLaunchCommand", () => {
    it('returns "dmux"', () => {
      const cmd = dmuxManager.buildLaunchCommand({ cwd: "/home/user/project" });
      expect(cmd).toBe("dmux");
    });
  });

  describe("graceful error handling", () => {
    it("handles corrupted config JSON", () => {
      mockReadFileSync.mockReturnValue("not valid json{{{");
      const status = dmuxManager.getStatus("/home/user/project");
      expect(status.running).toBe(false);
    });

    it("handles tmux list-panes failure gracefully", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({
        session_name: "dmux-abc",
        project_root: "/tmp",
        panes: [{ id: "p1", pane_id: "%1", tmux_target: "dmux-abc:0.0" }],
      }));

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("has-session")) return "";
        if (typeof cmd === "string" && cmd.includes("list-panes")) throw new Error("tmux error");
        return "";
      });

      const status = dmuxManager.getStatus("/tmp");
      expect(status.running).toBe(true);
      expect(status.panes).toEqual([]);
    });
  });
});
