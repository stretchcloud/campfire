// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSwitcher } from "./ModelSwitcher.js";
import { useStore } from "../store.js";

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(),
}));

beforeEach(() => {
  useStore.getState().reset();
});

describe("ModelSwitcher", () => {
  it("does not render for Codex sessions", () => {
    useStore.getState().setSdkSessions([
      {
        sessionId: "codex-session",
        state: "connected",
        cwd: "/repo",
        createdAt: Date.now(),
        backendType: "codex",
        model: "",
      },
    ]);

    render(<ModelSwitcher sessionId="codex-session" />);

    // Codex runtime model switching is unsupported by the adapter; rendering a
    // switcher would imply Campfire can override the Codex-configured model.
    expect(screen.queryByLabelText("Switch model")).toBeNull();
  });

  it("renders for Claude sessions with a known model", () => {
    useStore.getState().setSdkSessions([
      {
        sessionId: "claude-session",
        state: "connected",
        cwd: "/repo",
        createdAt: Date.now(),
        backendType: "claude",
        model: "claude-opus-4-6",
      },
    ]);

    render(<ModelSwitcher sessionId="claude-session" />);

    expect(screen.getByLabelText("Switch model")).toBeInTheDocument();
  });
});
