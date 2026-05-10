// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "../types.js";

type MockState = {
  currentSessionId: string | null;
  sessionTasks: Map<string, TaskItem[]>;
  sessionNames: Map<string, string>;
  sdkSessions: Array<{ sessionId: string; name?: string }>;
};

let mockState: MockState;

vi.mock("../store.js", () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

import { KanbanPage } from "./KanbanPage.js";

beforeEach(() => {
  mockState = {
    currentSessionId: null,
    sessionTasks: new Map(),
    sessionNames: new Map(),
    sdkSessions: [],
  };
});

describe("KanbanPage", () => {
  it("renders the empty board when no session is selected", () => {
    // Regression coverage: the store selector must not return a fresh Map during render,
    // which can trigger React's maximum update depth guard on the standalone route.
    render(<KanbanPage />);

    expect(screen.getByText("Task Board")).toBeInTheDocument();
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("shows current session tasks grouped by status", () => {
    mockState = {
      ...mockState,
      currentSessionId: "session-1",
      sessionNames: new Map([["session-1", "Demo Session"]]),
      sessionTasks: new Map([
        [
          "session-1",
          [
            { id: "a", subject: "Plan work", description: "Plan work", status: "pending" },
            { id: "b", subject: "Ship work", description: "Ship work", status: "in_progress" },
            { id: "c", subject: "Review work", description: "Review work", status: "completed" },
          ],
        ],
      ]),
    };

    render(<KanbanPage />);

    expect(screen.getByText("Tasks from session: Demo Session")).toBeInTheDocument();
    expect(screen.getByText("Plan work")).toBeInTheDocument();
    expect(screen.getByText("Ship work")).toBeInTheDocument();
    expect(screen.getByText("Review work")).toBeInTheDocument();
  });
});
