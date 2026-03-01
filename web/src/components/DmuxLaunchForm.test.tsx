// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DmuxLaunchForm } from "./DmuxLaunchForm.js";

vi.mock("../api.js", () => ({
  api: {
    getDmuxAgents: vi.fn(),
    launchDmux: vi.fn(),
  },
}));

import { api } from "../api.js";

const mockGetDmuxAgents = api.getDmuxAgents as ReturnType<typeof vi.fn>;
const mockLaunchDmux = api.launchDmux as ReturnType<typeof vi.fn>;

describe("DmuxLaunchForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches and displays available agents", async () => {
    mockGetDmuxAgents.mockResolvedValue([
      { id: "claude", slug: "cc", name: "Claude Code", available: true },
      { id: "codex", slug: "cx", name: "Codex", available: true },
      { id: "goose", slug: "gs", name: "Goose", available: false },
    ]);

    render(
      <DmuxLaunchForm
        cwd="/home/user/project"
        onLaunch={vi.fn()}
        onChangeCwd={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
      expect(screen.getByText("Codex")).toBeInTheDocument();
      expect(screen.getByText("Goose")).toBeInTheDocument();
    });
  });

  it("disables unavailable agents", async () => {
    mockGetDmuxAgents.mockResolvedValue([
      { id: "claude", slug: "cc", name: "Claude Code", available: true },
      { id: "goose", slug: "gs", name: "Goose", available: false },
    ]);

    render(
      <DmuxLaunchForm
        cwd="/home/user/project"
        onLaunch={vi.fn()}
        onChangeCwd={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Goose")).toBeInTheDocument();
    });

    const gooseBtn = screen.getByText("Goose");
    expect(gooseBtn).toBeDisabled();
    expect(gooseBtn).toHaveAttribute("title", "Goose is not installed");
  });

  it("shows cwd with change button", async () => {
    mockGetDmuxAgents.mockResolvedValue([]);

    const onChangeCwd = vi.fn();
    render(
      <DmuxLaunchForm
        cwd="/home/user/project"
        onLaunch={vi.fn()}
        onChangeCwd={onChangeCwd}
      />,
    );

    expect(screen.getByText("/home/user/project")).toBeInTheDocument();

    const changeBtn = screen.getByText("Change");
    changeBtn.click();
    expect(onChangeCwd).toHaveBeenCalled();
  });

  it("calls onLaunch with command from API", async () => {
    mockGetDmuxAgents.mockResolvedValue([
      { id: "claude", slug: "cc", name: "Claude Code", available: true },
    ]);
    mockLaunchDmux.mockResolvedValue({ command: "dmux" });

    const onLaunch = vi.fn();
    render(
      <DmuxLaunchForm
        cwd="/home/user/project"
        onLaunch={onLaunch}
        onChangeCwd={vi.fn()}
      />,
    );

    // Wait for agents to load
    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });

    // Click launch
    screen.getByText("Launch dmux").click();

    await waitFor(() => {
      expect(mockLaunchDmux).toHaveBeenCalledWith({
        cwd: "/home/user/project",
        agents: ["claude"],
        prompt: undefined,
        branchPrefix: "dmux/",
      });
      expect(onLaunch).toHaveBeenCalledWith("dmux");
    });
  });

  it("disables launch button when no agents selected", async () => {
    // Return agents but none are available (so none pre-selected)
    mockGetDmuxAgents.mockResolvedValue([
      { id: "goose", slug: "gs", name: "Goose", available: false },
    ]);

    render(
      <DmuxLaunchForm
        cwd="/home/user/project"
        onLaunch={vi.fn()}
        onChangeCwd={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Launch dmux")).toBeDisabled();
    });
  });
});
