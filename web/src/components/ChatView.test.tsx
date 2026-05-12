// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { ChatView } from "./ChatView.js";

vi.mock("./MessageFeed.js", () => ({
  MessageFeed: () => <div data-testid="message-feed" />,
}));

vi.mock("./Composer.js", () => ({
  Composer: () => <div data-testid="composer" />,
}));

vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => <div data-testid="permission-banner" />,
}));

vi.mock("./SessionPulse.js", () => ({
  SessionPulse: () => <div data-testid="session-pulse" />,
}));

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn(),
  },
}));

describe("ChatView connection banners", () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it("shows completed instead of reconnecting for disconnected exited subagents", () => {
    // MCP-spawned subagents intentionally exit after returning their result.
    // A browser socket close after that should not make the transcript look broken.
    useStore.setState((state) => ({
      connectionStatus: new Map(state.connectionStatus).set("child-1", "disconnected"),
      cliConnected: new Map(state.cliConnected).set("child-1", false),
      sdkSessions: [{
        sessionId: "child-1",
        cwd: "/repo",
        state: "exited",
        createdAt: Date.now(),
        parentSessionId: "parent-1",
        orchestrationRole: "subagent",
      }],
    }));

    render(<ChatView sessionId="child-1" />);

    expect(screen.getByText("subagent completed")).toBeInTheDocument();
    expect(screen.queryByText("reconnecting...")).not.toBeInTheDocument();
    expect(screen.queryByText("agent disconnected")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "reconnect" })).not.toBeInTheDocument();
  });

  it("keeps reconnecting visible for normal disconnected sessions", () => {
    useStore.setState((state) => ({
      connectionStatus: new Map(state.connectionStatus).set("normal-1", "disconnected"),
      cliConnected: new Map(state.cliConnected).set("normal-1", false),
      sdkSessions: [{
        sessionId: "normal-1",
        cwd: "/repo",
        state: "exited",
        createdAt: Date.now(),
      }],
    }));

    render(<ChatView sessionId="normal-1" />);

    expect(screen.getByText("reconnecting...")).toBeInTheDocument();
    expect(screen.queryByText("subagent completed")).not.toBeInTheDocument();
  });

  it("uses sticky terminal state after a late name refresh", () => {
    // The child session can be renamed after it exits. That name refresh should
    // not make ChatView recalculate the transcript as a reconnectable session.
    useStore.setState((state) => ({
      connectionStatus: new Map(state.connectionStatus).set("child-2", "connected"),
      cliConnected: new Map(state.cliConnected).set("child-2", false),
      completedSubagentSessions: new Map(state.completedSubagentSessions).set("child-2", "completed"),
      sdkSessions: [{
        sessionId: "child-2",
        cwd: "/repo",
        state: "exited",
        createdAt: Date.now(),
      }],
    }));

    const { rerender } = render(<ChatView sessionId="child-2" />);
    useStore.getState().setSessionName("child-2", "Generated Subagent Name");
    rerender(<ChatView sessionId="child-2" />);

    expect(screen.getByText("subagent completed")).toBeInTheDocument();
    expect(screen.queryByText("agent disconnected")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "reconnect" })).not.toBeInTheDocument();
  });
});
