// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DmuxStatusPanel } from "./DmuxStatusPanel.js";

// Mock the dmux-ws module instead of api for the WebSocket-based status panel
let capturedStatusCb: ((status: unknown) => void) | null = null;

vi.mock("../dmux-ws.js", () => ({
  connectDmux: vi.fn((cwd: string, statusCb: (status: unknown) => void) => {
    capturedStatusCb = statusCb;
  }),
  disconnectDmux: vi.fn(),
  sendDmuxFocusPane: vi.fn(),
  sendDmuxMessage: vi.fn(),
}));

import { sendDmuxFocusPane } from "../dmux-ws.js";

const mockSendDmuxFocusPane = sendDmuxFocusPane as ReturnType<typeof vi.fn>;

describe("DmuxStatusPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedStatusCb = null;
  });

  afterEach(() => {
    capturedStatusCb = null;
  });

  it("shows waiting message when dmux is not running", async () => {
    render(<DmuxStatusPanel cwd="/home/user/project" />);

    // Before any status arrives, should show waiting
    expect(screen.getByText("Waiting for dmux session...")).toBeInTheDocument();
  });

  it("renders pane cards with correct info when status is pushed", async () => {
    render(<DmuxStatusPanel cwd="/home/user/project" />);

    // Simulate WS status push
    capturedStatusCb?.({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/home/user/project",
      panes: [
        {
          id: "p1",
          slug: "cc-1",
          paneId: "%1",
          tmuxTarget: "dmux-abc:0.0",
          agent: "claude",
          agentStatus: "working",
          branchName: "dmux/feat",
          worktreePath: "/tmp/wt1",
          projectRoot: "/home/user/project",
          isActive: true,
        },
        {
          id: "p2",
          slug: "cx-1",
          paneId: "%2",
          tmuxTarget: "dmux-abc:0.1",
          agent: "codex",
          agentStatus: "idle",
          branchName: "dmux/fix",
          worktreePath: "/tmp/wt2",
          projectRoot: "/home/user/project",
          isActive: false,
        },
      ],
      totalPanes: 2,
    });

    await waitFor(() => {
      expect(screen.getByText("claude")).toBeInTheDocument();
      expect(screen.getByText("codex")).toBeInTheDocument();
    });

    // Check slugs are displayed
    expect(screen.getByText("cc-1")).toBeInTheDocument();
    expect(screen.getByText("cx-1")).toBeInTheDocument();

    // Check branch names
    expect(screen.getByText("dmux/feat")).toBeInTheDocument();
    expect(screen.getByText("dmux/fix")).toBeInTheDocument();

    // Check pane count
    expect(screen.getByText("2 panes")).toBeInTheDocument();
  });

  it("calls sendDmuxFocusPane on pane click", async () => {
    const onPaneFocus = vi.fn();
    render(<DmuxStatusPanel cwd="/home/user/project" onPaneFocus={onPaneFocus} />);

    capturedStatusCb?.({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/home/user/project",
      panes: [
        {
          id: "p1",
          slug: "cc-1",
          paneId: "%1",
          tmuxTarget: "dmux-abc:0.0",
          agent: "claude",
          agentStatus: "working",
          branchName: "main",
          worktreePath: "",
          projectRoot: "/home/user/project",
          isActive: false,
        },
      ],
      totalPanes: 1,
    });

    await waitFor(() => {
      expect(screen.getByText("claude")).toBeInTheDocument();
    });

    // Click the pane card
    screen.getByText("claude").closest("button")?.click();

    await waitFor(() => {
      expect(mockSendDmuxFocusPane).toHaveBeenCalledWith("dmux-abc:0.0");
      expect(onPaneFocus).toHaveBeenCalledWith("dmux-abc:0.0");
    });
  });

  it("displays correct status dot colors", async () => {
    render(<DmuxStatusPanel cwd="/tmp" />);

    capturedStatusCb?.({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/tmp",
      panes: [
        { id: "1", slug: "cc-1", paneId: "%1", tmuxTarget: "dmux-abc:0.0", agent: "claude", agentStatus: "working", branchName: "", worktreePath: "", projectRoot: "/tmp", isActive: false },
        { id: "2", slug: "cx-1", paneId: "%2", tmuxTarget: "dmux-abc:0.1", agent: "codex", agentStatus: "waiting", branchName: "", worktreePath: "", projectRoot: "/tmp", isActive: false },
        { id: "3", slug: "gs-1", paneId: "%3", tmuxTarget: "dmux-abc:0.2", agent: "goose", agentStatus: "analyzing", branchName: "", worktreePath: "", projectRoot: "/tmp", isActive: false },
        { id: "4", slug: "ai-1", paneId: "%4", tmuxTarget: "dmux-abc:0.3", agent: "aider", agentStatus: "idle", branchName: "", worktreePath: "", projectRoot: "/tmp", isActive: false },
      ],
      totalPanes: 4,
    });

    await waitFor(() => {
      // Verify all four agents render
      expect(screen.getByText("claude")).toBeInTheDocument();
      expect(screen.getByText("codex")).toBeInTheDocument();
      expect(screen.getByText("goose")).toBeInTheDocument();
      expect(screen.getByText("aider")).toBeInTheDocument();
    });

    // Check the status dots have the right title attributes
    const dots = document.querySelectorAll("[title]");
    const titles = Array.from(dots).map((d) => d.getAttribute("title"));
    expect(titles).toContain("Working");
    expect(titles).toContain("Waiting");
    expect(titles).toContain("Analyzing");
    expect(titles).toContain("Idle");
  });

  it("shows singular 'pane' for single pane count", async () => {
    render(<DmuxStatusPanel cwd="/tmp" />);

    capturedStatusCb?.({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/tmp",
      panes: [
        { id: "1", slug: "cc-1", paneId: "%1", tmuxTarget: "dmux-abc:0.0", agent: "claude", agentStatus: "idle", branchName: "", worktreePath: "", projectRoot: "/tmp", isActive: false },
      ],
      totalPanes: 1,
    });

    await waitFor(() => {
      expect(screen.getByText("1 pane")).toBeInTheDocument();
    });
  });
});
