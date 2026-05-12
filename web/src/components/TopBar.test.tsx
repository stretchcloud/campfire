// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

interface MockStoreState {
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  completedSubagentSessions: Map<string, "completed" | "failed" | "timeout">;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string; parent_session_id?: string; orchestration_role?: "lead" | "subagent" | "race_entry" }>;
  sdkSessions: Array<{
    sessionId: string;
    cwd?: string;
    name?: string;
    state?: "starting" | "connected" | "running" | "exited";
    parentSessionId?: string;
    orchestrationRole?: "lead" | "subagent" | "race_entry";
  }>;
  changedFiles: Map<string, Set<string>>;
  sessionNames: Map<string, string>;
  myRole: Map<string, string>;
  sessionViewers: Map<string, unknown[]>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    cliConnected: new Map([["s1", true]]),
    sessionStatus: new Map([["s1", "idle"]]),
    completedSubagentSessions: new Map(),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    changedFiles: new Map(),
    sessionNames: new Map(),
    myRole: new Map(),
    sessionViewers: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { TopBar } from "./TopBar.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("TopBar", () => {
  it("shows diff badge count only for files within cwd", () => {
    resetStore({
      changedFiles: new Map([
        [
          "s1",
          new Set(["/repo/src/a.ts", "/repo/src/b.ts", "/Users/stan/.claude/plans/plan.md"]),
        ],
      ]),
    });

    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("hides diff badge when all changed files are out of scope", () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/Users/stan/.claude/plans/plan.md"])]]),
    });

    render(<TopBar />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("shows completed instead of reconnect for exited subagent sessions", () => {
    // MCP-spawned subagents intentionally stop after returning their result.
    resetStore({
      cliConnected: new Map([["s1", false]]),
      sessions: new Map([["s1", { cwd: "/repo", parent_session_id: "parent-1", orchestration_role: "subagent" }]]),
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", state: "exited", parentSessionId: "parent-1", orchestrationRole: "subagent" }],
    });

    render(<TopBar />);

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.queryByText("reconnect")).not.toBeInTheDocument();
  });

  it("uses sticky terminal state when subagent SDK metadata is incomplete", () => {
    // A late name/session-list refresh can temporarily omit child metadata;
    // the terminal child-session state should still suppress reconnect.
    resetStore({
      cliConnected: new Map([["s1", false]]),
      completedSubagentSessions: new Map([["s1", "completed"]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", state: "exited" }],
    });

    render(<TopBar />);

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.queryByText("reconnect")).not.toBeInTheDocument();
  });

  it("keeps reconnect available for normal disconnected sessions", () => {
    resetStore({
      cliConnected: new Map([["s1", false]]),
      sdkSessions: [{ sessionId: "s1", cwd: "/repo", state: "exited" }],
    });

    render(<TopBar />);

    expect(screen.getByText("reconnect")).toBeInTheDocument();
  });
});
