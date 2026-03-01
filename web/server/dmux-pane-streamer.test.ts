import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn(() => "/usr/bin/tmux"),
}));

const mockTailStdout = { on: vi.fn() };
const mockTailProcess = {
  stdout: mockTailStdout,
  on: vi.fn(),
  kill: vi.fn(),
};

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  spawn: vi.fn(() => mockTailProcess),
}));

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/dmux-pane-logs-test"),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
}));

import { DmuxPaneStreamer, type PaneStreamSubscriber } from "./dmux-pane-streamer.js";
import { execSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { resolveBinary } from "./path-resolver.js";

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockUnlinkSync = unlinkSync as unknown as ReturnType<typeof vi.fn>;
const mockResolveBinary = resolveBinary as unknown as ReturnType<typeof vi.fn>;

function createMockSubscriber(): PaneStreamSubscriber {
  return { send: vi.fn() };
}

describe("DmuxPaneStreamer", () => {
  let streamer: DmuxPaneStreamer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveBinary.mockReturnValue("/usr/bin/tmux");
    // Reset spawn mock to return fresh process
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    });
    streamer = new DmuxPaneStreamer();
  });

  describe("startStream", () => {
    it("captures initial pane content and starts pipe-pane + tail", () => {
      // Mock capture-pane to return initial content
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("capture-pane")) return "initial content\n";
        return "";
      });

      const sub = createMockSubscriber();
      streamer.startStream("dmux-test:0.0", sub);

      // Should send initial history
      expect(sub.send).toHaveBeenCalledOnce();
      const sent = JSON.parse((sub.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe("dmux_pane_output");
      expect(sent.tmuxTarget).toBe("dmux-test:0.0");
      expect(sent.isHistory).toBe(true);
      expect(sent.data).toContain("initial content");

      // Should have started pipe-pane
      const pipePaneCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("pipe-pane"),
      );
      expect(pipePaneCall).toBeTruthy();

      // Should have spawned tail -f
      expect(mockSpawn).toHaveBeenCalledWith("tail", ["-f", expect.stringContaining("dmux-test")], expect.any(Object));
    });

    it("adds subscriber to existing stream without restarting", () => {
      mockExecSync.mockReturnValue("");
      const sub1 = createMockSubscriber();
      const sub2 = createMockSubscriber();

      streamer.startStream("dmux-test:0.0", sub1);
      // Clear mocks to track second call
      mockExecSync.mockClear();
      mockSpawn.mockClear();

      streamer.startStream("dmux-test:0.0", sub2);

      // Should NOT call pipe-pane or spawn again
      const pipePaneCalls = mockExecSync.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("pipe-pane"),
      );
      expect(pipePaneCalls.length).toBe(0);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("does not start stream when tmux binary is unavailable", () => {
      mockResolveBinary.mockReturnValue(null);
      const sub = createMockSubscriber();

      streamer.startStream("dmux-test:0.0", sub);

      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(streamer.getActiveTargets()).toEqual([]);
    });

    it("cleans up log file if startup fails", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("capture-pane")) {
          throw new Error("capture failed");
        }
        return "";
      });

      const sub = createMockSubscriber();
      streamer.startStream("dmux-test:0.0", sub);

      expect(mockUnlinkSync).toHaveBeenCalled();
      expect(streamer.getActiveTargets()).toEqual([]);
    });

    it("sends only the last 200 lines of history to new subscribers", () => {
      mockExecSync.mockReturnValue("");
      const sub1 = createMockSubscriber();
      const sub2 = createMockSubscriber();

      streamer.startStream("dmux-test:0.0", sub1);
      (sub2.send as ReturnType<typeof vi.fn>).mockClear();

      const history = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
      mockReadFileSync.mockReturnValue(history);
      streamer.startStream("dmux-test:0.0", sub2);

      expect(sub2.send).toHaveBeenCalledOnce();
      const sent = JSON.parse((sub2.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.isHistory).toBe(true);
      expect(sent.data).toContain("line-299");
      expect(sent.data).toContain("line-100");
      expect(sent.data).not.toContain("line-99");
    });
  });

  describe("stopStream", () => {
    it("removes subscriber and tears down when last subscriber leaves", () => {
      mockExecSync.mockReturnValue("");
      const mockProc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      const sub = createMockSubscriber();
      streamer.startStream("dmux-test:0.0", sub);
      mockExecSync.mockClear();

      streamer.stopStream("dmux-test:0.0", sub);

      // Should have stopped pipe-pane (called with just the target, no "cat >>")
      const stopPipeCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("pipe-pane") && !(c[0] as string).includes("cat"),
      );
      expect(stopPipeCall).toBeTruthy();

      // Should have killed tail
      expect(mockProc.kill).toHaveBeenCalled();
    });

    it("does not tear down when other subscribers remain", () => {
      mockExecSync.mockReturnValue("");
      const mockProc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      const sub1 = createMockSubscriber();
      const sub2 = createMockSubscriber();

      streamer.startStream("dmux-test:0.0", sub1);
      streamer.startStream("dmux-test:0.0", sub2);
      mockExecSync.mockClear();

      streamer.stopStream("dmux-test:0.0", sub1);

      // Should NOT tear down — sub2 is still subscribed
      expect(mockProc.kill).not.toHaveBeenCalled();
    });
  });

  describe("removeSubscriber", () => {
    it("removes subscriber from all streams", () => {
      mockExecSync.mockReturnValue("");
      const mockProc1 = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
      const mockProc2 = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
      mockSpawn.mockReturnValueOnce(mockProc1).mockReturnValueOnce(mockProc2);

      const sub = createMockSubscriber();
      streamer.startStream("dmux-test:0.0", sub);
      streamer.startStream("dmux-test:0.1", sub);

      streamer.removeSubscriber(sub);

      // Both streams should be torn down
      expect(mockProc1.kill).toHaveBeenCalled();
      expect(mockProc2.kill).toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("cleans up all streams", () => {
      mockExecSync.mockReturnValue("");
      const mockProc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
      mockSpawn.mockReturnValue(mockProc);

      const sub = createMockSubscriber();
      streamer.startStream("dmux-test:0.0", sub);

      streamer.destroy();

      expect(mockProc.kill).toHaveBeenCalled();
      expect(streamer.getActiveTargets()).toEqual([]);
    });
  });
});
