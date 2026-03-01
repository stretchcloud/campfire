import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dmux-manager before importing
vi.mock("./dmux-manager.js", () => ({
  dmuxManager: {
    getStatus: vi.fn(),
    focusPane: vi.fn(),
    sendToPane: vi.fn(),
  },
}));

// Mock path-resolver for dmux-pane-streamer
vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn(() => "/usr/bin/tmux"),
}));

// Mock child_process and fs for dmux-pane-streamer
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/dmux-pane-logs-test"),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(() => ""),
}));

import { DmuxWatcher, type DmuxWatchClient } from "./dmux-watcher.js";
import { dmuxManager } from "./dmux-manager.js";

const mockGetStatus = dmuxManager.getStatus as ReturnType<typeof vi.fn>;
const mockFocusPane = dmuxManager.focusPane as ReturnType<typeof vi.fn>;
const mockSendToPane = dmuxManager.sendToPane as ReturnType<typeof vi.fn>;

function createMockClient(cwd: string): DmuxWatchClient {
  return {
    cwd,
    send: vi.fn(),
  };
}

const RUNNING_STATUS = {
  running: true,
  sessionName: "dmux-test",
  projectRoot: "/test",
  panes: [
    {
      id: "p1", slug: "cc-1", paneId: "%1", tmuxTarget: "dmux-test:0.0",
      agent: "claude", agentStatus: "working" as const, branchName: "main",
      worktreePath: "", projectRoot: "/test", isActive: true,
    },
  ],
  totalPanes: 1,
};

const IDLE_STATUS = {
  running: false,
  sessionName: null,
  projectRoot: null,
  panes: [],
  totalPanes: 0,
};

describe("DmuxWatcher", () => {
  let watcher: DmuxWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    watcher = new DmuxWatcher();
  });

  afterEach(() => {
    watcher.destroy();
    vi.useRealTimers();
  });

  describe("addClient", () => {
    it("sends immediate status snapshot to the new client", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");

      watcher.addClient(client);

      expect(client.send).toHaveBeenCalledOnce();
      const sent = JSON.parse((client.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.type).toBe("dmux_status");
      expect(sent.status.running).toBe(true);
    });

    it("groups clients by cwd when polling", () => {
      // Two clients watching the same cwd, one watching a different cwd
      mockGetStatus.mockReturnValue(RUNNING_STATUS);

      const client1 = createMockClient("/test");
      const client2 = createMockClient("/test");
      const client3 = createMockClient("/other");

      watcher.addClient(client1);
      watcher.addClient(client2);
      watcher.addClient(client3);

      // Clear initial send calls
      (client1.send as ReturnType<typeof vi.fn>).mockClear();
      (client2.send as ReturnType<typeof vi.fn>).mockClear();
      (client3.send as ReturnType<typeof vi.fn>).mockClear();

      // Trigger a poll with changed status
      mockGetStatus.mockReturnValue({ ...RUNNING_STATUS, totalPanes: 2 });
      vi.advanceTimersByTime(2500);

      // getStatus should be called twice (once per unique cwd)
      expect(mockGetStatus).toHaveBeenCalledWith("/test");
      expect(mockGetStatus).toHaveBeenCalledWith("/other");
    });
  });

  describe("removeClient", () => {
    it("stops polling when all clients are removed", () => {
      mockGetStatus.mockReturnValue(IDLE_STATUS);
      const client = createMockClient("/test");

      watcher.addClient(client);
      watcher.removeClient(client);

      // Advance time — should not call getStatus again
      mockGetStatus.mockClear();
      vi.advanceTimersByTime(5000);
      expect(mockGetStatus).not.toHaveBeenCalled();
    });

    it("keeps cwd status cache when other clients still watch the same cwd", () => {
      mockGetStatus.mockReturnValue(IDLE_STATUS);
      const client1 = createMockClient("/test");
      const client2 = createMockClient("/test");

      watcher.addClient(client1);
      watcher.addClient(client2);
      watcher.removeClient(client1);

      const lastStatus = (watcher as unknown as { lastStatus: Map<string, string> }).lastStatus;
      expect(lastStatus.has("/test")).toBe(true);
    });
  });

  describe("poll - only broadcasts on change", () => {
    it("does not broadcast if status hasn't changed", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");

      watcher.addClient(client);
      // Clear initial snapshot
      (client.send as ReturnType<typeof vi.fn>).mockClear();

      // Poll with same status
      vi.advanceTimersByTime(2500);
      expect(client.send).not.toHaveBeenCalled();
    });

    it("broadcasts when status changes", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");

      watcher.addClient(client);
      (client.send as ReturnType<typeof vi.fn>).mockClear();

      // Change status
      const updated = { ...RUNNING_STATUS, totalPanes: 3 };
      mockGetStatus.mockReturnValue(updated);
      vi.advanceTimersByTime(2500);

      expect(client.send).toHaveBeenCalledOnce();
      const sent = JSON.parse((client.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(sent.status.totalPanes).toBe(3);
    });
  });

  describe("handleMessage", () => {
    it("handles subscribe message and updates cwd", () => {
      mockGetStatus.mockReturnValue(IDLE_STATUS);
      const client = createMockClient("/old");
      watcher.addClient(client);
      (client.send as ReturnType<typeof vi.fn>).mockClear();

      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      watcher.handleMessage(client, { type: "subscribe", cwd: "/test" });

      expect(client.cwd).toBe("/test");
      expect(client.send).toHaveBeenCalledOnce();
    });

    it("removes old cwd cache entry when client subscribes to a new cwd", () => {
      mockGetStatus.mockReturnValue(IDLE_STATUS);
      const client = createMockClient("/old");
      watcher.addClient(client);

      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      watcher.handleMessage(client, { type: "subscribe", cwd: "/new" });

      const lastStatus = (watcher as unknown as { lastStatus: Map<string, string> }).lastStatus;
      expect(lastStatus.has("/old")).toBe(false);
      expect(lastStatus.has("/new")).toBe(true);
    });

    it("handles focus_pane message", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");
      watcher.addClient(client);

      watcher.handleMessage(client, { type: "focus_pane", tmuxTarget: "dmux-test:0.0" });
      expect(mockFocusPane).toHaveBeenCalledWith("dmux-test:0.0");
    });

    it("handles send_keys message", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");
      watcher.addClient(client);

      watcher.handleMessage(client, { type: "send_keys", tmuxTarget: "dmux-test:0.0", keys: "n", enter: true });
      expect(mockSendToPane).toHaveBeenCalledWith("dmux-test:0.0", "n", true);
    });

    it("handles stream_pane message", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");
      watcher.addClient(client);
      const startSpy = vi.spyOn(watcher.paneStreamer, "startStream");

      watcher.handleMessage(client, { type: "stream_pane", tmuxTarget: "dmux-test:0.0" });
      expect(startSpy).toHaveBeenCalledWith("dmux-test:0.0", client);
    });

    it("handles stop_stream_pane message", () => {
      mockGetStatus.mockReturnValue(RUNNING_STATUS);
      const client = createMockClient("/test");
      watcher.addClient(client);
      const stopSpy = vi.spyOn(watcher.paneStreamer, "stopStream");

      watcher.handleMessage(client, { type: "stop_stream_pane", tmuxTarget: "dmux-test:0.0" });
      expect(stopSpy).toHaveBeenCalledWith("dmux-test:0.0", client);
    });
  });
});
