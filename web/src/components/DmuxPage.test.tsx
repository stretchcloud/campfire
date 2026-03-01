// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DmuxPage } from "./DmuxPage.js";

// Mock the api module
vi.mock("../api.js", () => ({
  api: {
    checkDmuxPrereqs: vi.fn(),
    getDmuxStatus: vi.fn(),
    getDmuxAgents: vi.fn(),
    launchDmux: vi.fn(),
    focusDmuxPane: vi.fn(),
    sendToDmuxPane: vi.fn(),
  },
}));

// Mock FolderPicker
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) => (
    <div data-testid="folder-picker">
      <button onClick={() => onSelect("/home/user/project")}>Select Folder</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Mock TerminalView
vi.mock("./TerminalView.js", () => ({
  TerminalView: ({ cwd, initialCommand, embedded }: { cwd: string; initialCommand?: string; embedded?: boolean }) => (
    <div data-testid="terminal-view" data-cwd={cwd} data-initial-command={initialCommand} data-embedded={String(embedded)}>
      Terminal: {cwd} {initialCommand}
    </div>
  ),
}));

// Mock DmuxStatusPanel
vi.mock("./DmuxStatusPanel.js", () => ({
  DmuxStatusPanel: ({ cwd }: { cwd: string }) => (
    <div data-testid="dmux-status-panel" data-cwd={cwd}>Status Panel</div>
  ),
}));

// Mock DmuxLaunchForm
vi.mock("./DmuxLaunchForm.js", () => ({
  DmuxLaunchForm: ({ cwd, onLaunch, onChangeCwd }: { cwd: string; onLaunch: (cmd: string) => void; onChangeCwd: () => void }) => (
    <div data-testid="dmux-launch-form" data-cwd={cwd}>
      <button onClick={() => onLaunch("dmux")}>Launch dmux</button>
      <button onClick={onChangeCwd}>Change CWD</button>
    </div>
  ),
}));

import { api } from "../api.js";

describe("DmuxPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Phase 1: Prereq checks (preserved) ──────────────────────────

  it("shows loading state while checking prerequisites", () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<DmuxPage />);
    expect(screen.getByText("Checking prerequisites...")).toBeInTheDocument();
  });

  it("shows error state when prereq check fails", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    render(<DmuxPage />);
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("shows missing prerequisites when dmux is not installed", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: false, path: null },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    render(<DmuxPage />);
    await waitFor(() => {
      expect(screen.getByText("Missing Prerequisites")).toBeInTheDocument();
    });
    expect(screen.getByText("npm install -g dmux")).toBeInTheDocument();
  });

  it("shows missing prerequisites when tmux is not installed", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: false, path: null },
    });
    render(<DmuxPage />);
    await waitFor(() => {
      expect(screen.getByText("Missing Prerequisites")).toBeInTheDocument();
    });
  });

  // ─── Phase 2: Launch form ─────────────────────────────────────────

  it("shows folder picker prompt when all prerequisites are met", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    render(<DmuxPage />);
    await waitFor(() => {
      expect(screen.getByText("Choose a project folder")).toBeInTheDocument();
    });
    expect(screen.getByText("Choose Folder")).toBeInTheDocument();
  });

  it("shows launch form after folder selection", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    // No running session
    (api.getDmuxStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: false, sessionName: null, projectRoot: null, panes: [], totalPanes: 0,
    });

    render(<DmuxPage />);

    await waitFor(() => {
      expect(screen.getByText("Choose Folder")).toBeInTheDocument();
    });

    // Open folder picker
    screen.getByText("Choose Folder").click();
    await waitFor(() => {
      expect(screen.getByTestId("folder-picker")).toBeInTheDocument();
    });

    // Select folder
    screen.getByText("Select Folder").click();

    // Launch form should appear
    await waitFor(() => {
      const form = screen.getByTestId("dmux-launch-form");
      expect(form).toBeInTheDocument();
      expect(form.getAttribute("data-cwd")).toBe("/home/user/project");
    });
  });

  // ─── Phase 2: Dashboard ───────────────────────────────────────────

  it("shows dashboard with status panel and terminal after launch", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    (api.getDmuxStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: false, sessionName: null, projectRoot: null, panes: [], totalPanes: 0,
    });

    render(<DmuxPage />);

    // Select folder
    await waitFor(() => screen.getByText("Choose Folder").click());
    await waitFor(() => screen.getByText("Select Folder").click());

    // Wait for launch form
    await waitFor(() => {
      expect(screen.getByTestId("dmux-launch-form")).toBeInTheDocument();
    });

    // Click launch
    screen.getByText("Launch dmux").click();

    // Dashboard should appear with status panel and terminal
    await waitFor(() => {
      expect(screen.getByTestId("dmux-status-panel")).toBeInTheDocument();
      expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
    });

    // Terminal should have dmux as initialCommand
    const terminal = screen.getByTestId("terminal-view");
    expect(terminal.getAttribute("data-initial-command")).toBe("dmux");
  });

  it("detects running session and shows dashboard directly", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    // Session is already running
    (api.getDmuxStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/home/user/project",
      panes: [],
      totalPanes: 0,
    });

    render(<DmuxPage />);

    // Select folder
    await waitFor(() => screen.getByText("Choose Folder").click());
    await waitFor(() => screen.getByText("Select Folder").click());

    // Should jump to dashboard since session is already running
    await waitFor(() => {
      expect(screen.getByTestId("dmux-status-panel")).toBeInTheDocument();
      expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
    });
  });

  it("dashboard shows stop and hide panel buttons", async () => {
    (api.checkDmuxPrereqs as ReturnType<typeof vi.fn>).mockResolvedValue({
      dmux: { available: true, path: "/usr/local/bin/dmux" },
      tmux: { available: true, path: "/usr/bin/tmux" },
    });
    (api.getDmuxStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: true,
      sessionName: "dmux-abc",
      projectRoot: "/home/user/project",
      panes: [],
      totalPanes: 0,
    });

    render(<DmuxPage />);

    await waitFor(() => screen.getByText("Choose Folder").click());
    await waitFor(() => screen.getByText("Select Folder").click());

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
      expect(screen.getByText("Hide Panel")).toBeInTheDocument();
    });
  });
});
