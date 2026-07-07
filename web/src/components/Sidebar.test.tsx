// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState, SdkSessionInfo } from "../types.js";

// ─── Mock setup ──────────────────────────────────────────────────────────────

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();

vi.mock("../ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
  connectAllSessions: (...args: unknown[]) => mockConnectAllSessions(...args),
  disconnectSession: (...args: unknown[]) => mockDisconnectSession(...args),
}));

const mockApi = {
  listSessions: vi.fn().mockResolvedValue([]),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  renameSession: vi.fn().mockResolvedValue({ ok: true, name: "" }),
  listFolders: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn().mockResolvedValue({}),
  deleteFolder: vi.fn().mockResolvedValue({}),
  addSessionToFolder: vi.fn().mockResolvedValue({}),
  removeSessionFromFolder: vi.fn().mockResolvedValue({}),
};

vi.mock("../api.js", () => ({
  api: {
    listSessions: (...args: unknown[]) => mockApi.listSessions(...args),
    deleteSession: (...args: unknown[]) => mockApi.deleteSession(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
    unarchiveSession: (...args: unknown[]) => mockApi.unarchiveSession(...args),
    renameSession: (...args: unknown[]) => mockApi.renameSession(...args),
    listFolders: (...args: unknown[]) => mockApi.listFolders(...args),
    createFolder: (...args: unknown[]) => mockApi.createFolder(...args),
    deleteFolder: (...args: unknown[]) => mockApi.deleteFolder(...args),
    addSessionToFolder: (...args: unknown[]) => mockApi.addSessionToFolder(...args),
    removeSessionFromFolder: (...args: unknown[]) => mockApi.removeSessionFromFolder(...args),
  },
}));

// ─── Store mock helpers ──────────────────────────────────────────────────────

// We need to mock the store. The Sidebar uses `useStore((s) => s.xxx)` selector pattern.
// We'll provide a real-ish mock that supports selector calls.

interface MockStoreState {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  completedSubagentSessions: Map<string, "completed" | "failed" | "timeout">;
  sessionNames: Map<string, string>;
  recentlyRenamed: Set<string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  collapsedProjects: Set<string>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  toggleProjectCollapse: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  clearRecentlyRenamed: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
  closeTerminal: ReturnType<typeof vi.fn>;
}

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-5-20250929",
    cwd: "/home/user/projects/myapp",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
      total_duration_api_ms: 0,
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: "/home/user/projects/myapp",
    createdAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    sessions: new Map(),
    sdkSessions: [],
    currentSessionId: null,
    cliConnected: new Map(),
    sessionStatus: new Map(),
    completedSubagentSessions: new Map(),
    sessionNames: new Map(),
    recentlyRenamed: new Set(),
    pendingPermissions: new Map(),
    collapsedProjects: new Set(),
    setCurrentSession: vi.fn(),
    toggleProjectCollapse: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    closeTerminal: vi.fn(),
    ...overrides,
  };
}

// Mock the store module
vi.mock("../store.js", () => {
  // We create a function that acts like the zustand hook with selectors
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => {
    return selector(mockState);
  };
  // Also support useStore.getState() which Sidebar uses directly
  useStoreFn.getState = () => mockState;

  return { useStore: useStoreFn };
});

// ─── Import component after mocks ───────────────────────────────────────────

import { Sidebar } from "./Sidebar.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks wipes calls but keeps mockResolvedValue implementations.
  mockState = createMockState();
  window.location.hash = "";
  // The Sidebar persists collapsed nav sections and folders to localStorage;
  // clear it so each test starts from the component defaults.
  localStorage.clear();
});

/**
 * Nav sections ("Tools", "Data", "Config") are collapsed by default.
 * Expands one by clicking its section header.
 */
function expandNavSection(title: string) {
  fireEvent.click(screen.getByText(title));
}

describe("Sidebar", () => {
  it("renders 'New Session' button", () => {
    // Validates: the header has a session-creation button. Its visible label
    // is the compact "New", with the full name in the title attribute.
    render(<Sidebar />);
    const newButton = screen.getByTitle("New Session");
    expect(newButton).toBeInTheDocument();
    expect(newButton).toHaveTextContent("New");
  });

  it("renders 'No sessions yet.' when no sessions exist", () => {
    // Validates: empty state copy. The message spans multiple text nodes
    // ("No sessions yet.<br/>Click New to start.") so we match with a regex.
    render(<Sidebar />);
    expect(screen.getByText(/No sessions yet\./)).toBeInTheDocument();
  });

  it("renders session items for active sessions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1", { model: "claude-sonnet-4-5-20250929" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The session label defaults to model name
    expect(screen.getByText("claude-sonnet-4-5-20250929")).toBeInTheDocument();
  });

  it("session items show model name or session ID", () => {
    // Session with model name
    const session1 = makeSession("s1", { model: "claude-opus-4-6" });
    const sdk1 = makeSdkSession("s1", { model: "claude-opus-4-6" });

    // Session without model (falls back to short ID)
    const session2 = makeSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });
    const sdk2 = makeSdkSession("abcdef12-3456-7890-abcd-ef1234567890", { model: "" });

    mockState = createMockState({
      sessions: new Map([
        ["s1", session1],
        ["abcdef12-3456-7890-abcd-ef1234567890", session2],
      ]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    expect(screen.getByText("claude-opus-4-6")).toBeInTheDocument();
    // Falls back to shortId (first 8 chars)
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("session items appear under a time group header (Today)", () => {
    // Validates: sessions are grouped by creation time (Today / Yesterday /
    // Previous 7 Days / Older) rather than by project directory.
    const session = makeSession("s1", { cwd: "/home/user/projects/myapp" });
    const sdk = makeSdkSession("s1"); // createdAt defaults to Date.now()
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("session items show git branch when available", () => {
    const session = makeSession("s1", { git_branch: "feature/awesome" });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("feature/awesome")).toBeInTheDocument();
  });

  it("session items show worktree badge when is_worktree is true", () => {
    const session = makeSession("s1", { git_branch: "feature/wt", is_worktree: true });
    const sdk = makeSdkSession("s1", { isWorktree: true });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("wt")).toBeInTheDocument();
  });

  it("session items show ahead/behind counts", () => {
    const session = makeSession("s1", {
      git_branch: "main",
      git_ahead: 3,
      git_behind: 2,
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The component renders "3↑" and "2↓" using HTML entities in a stats row
    const sessionButton = screen.getByText("main").closest("button")!;
    expect(sessionButton.textContent).toContain("3");
    expect(sessionButton.textContent).toContain("2");
  });

  it("session items show lines added/removed", () => {
    const session = makeSession("s1", {
      git_branch: "main",
      total_lines_added: 42,
      total_lines_removed: 7,
    });
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("+42")).toBeInTheDocument();
    expect(screen.getByText("-7")).toBeInTheDocument();
  });

  it("active session has highlighted styling (bg-cc-active class)", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    render(<Sidebar />);
    // Find the session button element
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button");
    expect(sessionButton).toHaveClass("bg-cc-active");
  });

  it("clicking a session calls setCurrentSession and connectSession", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: null,
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.click(sessionButton);

    expect(mockState.setCurrentSession).toHaveBeenCalledWith("s1");
    expect(mockConnectSession).toHaveBeenCalledWith("s1");
  });

  it("New Session button calls newSession", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTitle("New Session"));

    expect(mockState.newSession).toHaveBeenCalled();
  });

  it("double-clicking a session enters edit mode", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const sessionButton = screen.getByText("claude-sonnet-4-5-20250929").closest("button")!;
    fireEvent.doubleClick(sessionButton);

    // After double-click, an input should appear for renaming
    const input = screen.getByDisplayValue("claude-sonnet-4-5-20250929");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
  });

  it("archive button exists in the DOM for session items", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Archive button has title "Archive session"
    const archiveButton = screen.getByTitle("Archive session");
    expect(archiveButton).toBeInTheDocument();
  });

  it("archive action button is visible by default on mobile and hover-only on desktop", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    const archiveButton = screen.getByTitle("Archive session");

    expect(archiveButton).toHaveClass("opacity-100");
    expect(archiveButton).toHaveClass("sm:opacity-0");
    expect(archiveButton).toHaveClass("sm:group-hover:opacity-100");
  });

  it("permission badge uses mobile-friendly positioning and hover behavior", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", new Map([["p1", {}]])]]),
    });

    render(<Sidebar />);
    const mobilePermissionBadge = screen.getAllByText("1").find((node) =>
      node.classList.contains("bg-cc-warning") && node.classList.contains("px-1"),
    )!;
    expect(mobilePermissionBadge).toHaveClass("right-8");
    expect(mobilePermissionBadge).toHaveClass("sm:right-2");
    expect(mobilePermissionBadge).toHaveClass("sm:group-hover:opacity-0");
  });

  it("archived sessions section shows count", () => {
    const sdk1 = makeSdkSession("s1", { archived: false });
    const sdk2 = makeSdkSession("s2", { archived: true });
    const sdk3 = makeSdkSession("s3", { archived: true });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2, sdk3],
    });

    render(<Sidebar />);
    // The count is rendered in a pill inside the "Archived" toggle button
    const toggleButton = screen.getByText("Archived").closest("button")!;
    expect(toggleButton.textContent).toContain("2");
  });

  it("toggle archived shows/hides archived sessions", () => {
    const sdk1 = makeSdkSession("s1", { archived: false, model: "active-model" });
    const sdk2 = makeSdkSession("s2", { archived: true, model: "archived-model" });

    mockState = createMockState({
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);

    // Archived sessions should not be visible initially
    expect(screen.queryByText("archived-model")).not.toBeInTheDocument();

    // Click the archived toggle button
    fireEvent.click(screen.getByText("Archived").closest("button")!);

    // Now the archived session should be visible
    expect(screen.getByText("archived-model")).toBeInTheDocument();
  });

  it("does not render settings controls directly in sidebar", () => {
    render(<Sidebar />);
    expect(screen.queryByText("Notification")).not.toBeInTheDocument();
    expect(screen.queryByText("Dark mode")).not.toBeInTheDocument();
  });

  it("navigates to environments page when Environments is clicked", () => {
    // "Environments" lives in the collapsed-by-default "Data" nav section.
    render(<Sidebar />);
    expandNavSection("Data");
    fireEvent.click(screen.getByText("Environments").closest("button")!);
    expect(window.location.hash).toBe("#/environments");
  });

  it("navigates to settings page when Settings is clicked", () => {
    // "Settings" is a persistent footer button below the nav sections.
    render(<Sidebar />);
    fireEvent.click(screen.getByText("Settings").closest("button")!);
    expect(window.location.hash).toBe("#/settings");
  });

  it("navigates to terminal page when Terminal is clicked", () => {
    // "Terminal" lives in the collapsed-by-default "Tools" nav section.
    render(<Sidebar />);
    expandNavSection("Tools");
    fireEvent.click(screen.getByText("Terminal").closest("button")!);
    expect(window.location.hash).toBe("#/terminal");
  });

  it("session name shows animate-name-appear class when recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Auto Generated Title"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Auto Generated Title");
    // Animation class is applied to the session name span itself
    // (closest() also matches the element it is called on).
    expect(nameElement.closest(".animate-name-appear")).toBeTruthy();
  });

  it("session name does NOT have animate-name-appear when not recently renamed", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Regular Name"]]),
      recentlyRenamed: new Set(), // not recently renamed
    });

    render(<Sidebar />);
    const nameElement = screen.getByText("Regular Name");
    expect(nameElement.className).not.toContain("animate-name-appear");
  });

  it("calls clearRecentlyRenamed on animation end", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      sessionNames: new Map([["s1", "Animated Name"]]),
      recentlyRenamed: new Set(["s1"]),
    });

    const { container } = render(<Sidebar />);
    // The animated span has the animate-name-appear class and an onAnimationEnd
    // handler that calls onClearRecentlyRenamed(sessionId).
    const animatedSpan = container.querySelector(".animate-name-appear");
    expect(animatedSpan).toBeTruthy();

    // JSDOM does not define AnimationEvent in all environments, which
    // causes fireEvent.animationEnd to silently fail. We traverse the
    // React fiber tree to invoke the onAnimationEnd handler directly.
    const fiberKey = Object.keys(animatedSpan!).find((k) =>
      k.startsWith("__reactFiber$"),
    );
    expect(fiberKey).toBeDefined();
    let fiber = (animatedSpan as unknown as Record<string, unknown>)[fiberKey!] as Record<string, unknown> | null;
    let called = false;
    while (fiber) {
      const props = fiber.memoizedProps as Record<string, unknown> | undefined;
      if (props?.onAnimationEnd) {
        (props.onAnimationEnd as () => void)();
        called = true;
        break;
      }
      fiber = fiber.return as Record<string, unknown> | null;
    }
    expect(called).toBe(true);
    expect(mockState.clearRecentlyRenamed).toHaveBeenCalledWith("s1");
  });

  it("animation class applies only to the recently renamed session, not others", () => {
    const session1 = makeSession("s1");
    const session2 = makeSession("s2");
    const sdk1 = makeSdkSession("s1");
    const sdk2 = makeSdkSession("s2");
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionNames: new Map([["s1", "Renamed Session"], ["s2", "Other Session"]]),
      recentlyRenamed: new Set(["s1"]), // only s1 was renamed
    });

    render(<Sidebar />);
    const renamedElement = screen.getByText("Renamed Session");
    const otherElement = screen.getByText("Other Session");

    expect(renamedElement.closest(".animate-name-appear")).toBeTruthy();
    expect(otherElement.closest(".animate-name-appear")).toBeFalsy();
  });

  it("permission badge shows count for sessions with pending permissions", () => {
    const session = makeSession("s1");
    const sdk = makeSdkSession("s1");
    const permMap = new Map<string, unknown>([
      ["r1", { request_id: "r1", tool_name: "Bash" }],
      ["r2", { request_id: "r2", tool_name: "Read" }],
    ]);
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      pendingPermissions: new Map([["s1", permMap as Map<string, unknown>]]),
      cliConnected: new Map([["s1", true]]),
    });

    render(<Sidebar />);
    // The permission count badge shows "2"
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("session shows git branch from sdkInfo when bridgeState is unavailable", () => {
    // No bridgeState — only sdkInfo (REST API) data available
    const sdk = makeSdkSession("s1", {
      gitBranch: "feature/from-rest",
      gitAhead: 5,
      gitBehind: 2,
      totalLinesAdded: 100,
      totalLinesRemoved: 20,
    });
    mockState = createMockState({
      sessions: new Map(), // no bridge state
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    expect(screen.getByText("feature/from-rest")).toBeInTheDocument();
    const sessionButton = screen.getByText("feature/from-rest").closest("button")!;
    expect(sessionButton.textContent).toContain("5");
    expect(sessionButton.textContent).toContain("2");
    expect(sessionButton.textContent).toContain("+100");
    expect(sessionButton.textContent).toContain("-20");
  });

  it("session prefers bridgeState git data over sdkInfo", () => {
    const session = makeSession("s1", {
      git_branch: "from-bridge",
      git_ahead: 1,
    });
    const sdk = makeSdkSession("s1", {
      gitBranch: "from-rest",
      gitAhead: 99,
    });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // Bridge data should win over REST API data
    expect(screen.getByText("from-bridge")).toBeInTheDocument();
    expect(screen.queryByText("from-rest")).not.toBeInTheDocument();
  });

  it("codex session shows Codex pill when bridgeState is missing", () => {
    // Only sdkInfo available (no WS session_init received yet)
    const sdk = makeSdkSession("s1", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map(), // no bridge state
      sdkSessions: [sdk],
    });

    render(<Sidebar />);
    // The backend/model badge is rendered lowercase next to the session name
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("session shows correct backend pill based on backendType", () => {
    // Validates: the badge is derived from the model (abbreviated, lowercase),
    // falling back to the backend type when the model is unknown.
    const session1 = makeSession("s1", { backend_type: "claude", model: "claude-sonnet-4-5-20250929" });
    const session2 = makeSession("s2", { backend_type: "codex", model: "gpt-5-codex" });
    const sdk1 = makeSdkSession("s1", { backendType: "claude", model: "claude-sonnet-4-5-20250929" });
    const sdk2 = makeSdkSession("s2", { backendType: "codex", model: "gpt-5-codex" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
    });

    render(<Sidebar />);
    // Both backend/model pills should be present (lowercase abbreviations)
    const claudePills = screen.getAllByText("sonnet");
    const codexPills = screen.getAllByText("codex");
    expect(claudePills.length).toBeGreaterThanOrEqual(1);
    expect(codexPills.length).toBeGreaterThanOrEqual(1);
  });

  it("marks exited subagent sessions as completed in the sidebar", () => {
    // MCP-spawned subagents are one-shot workers. Their transcript should
    // remain visible without looking like a broken reconnecting session.
    const sdk = makeSdkSession("child-1", {
      backendType: "codex",
      model: "gpt-5-codex",
      state: "exited",
      parentSessionId: "parent-1",
      orchestrationRole: "subagent",
    });
    mockState = createMockState({
      sdkSessions: [sdk],
      cliConnected: new Map([["child-1", false]]),
    });

    render(<Sidebar />);

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByTitle("Subagent reached a terminal state and is offline")).toBeInTheDocument();
  });

  it("does not mark normal exited sessions as completed subagents", () => {
    // Normal disconnected sessions should keep their existing reconnect affordance.
    const sdk = makeSdkSession("normal-1", {
      backendType: "codex",
      model: "gpt-5-codex",
      state: "exited",
    });
    mockState = createMockState({
      sdkSessions: [sdk],
      cliConnected: new Map([["normal-1", false]]),
    });

    render(<Sidebar />);

    expect(screen.queryByText("completed")).not.toBeInTheDocument();
  });

  it("uses the shared Campfire logo for codex sessions", () => {
    // The sidebar header brand should stay stable across backend types. Codex
    // sessions still get their backend pill in the session row.
    const session = makeSession("s1", { backend_type: "codex" });
    const sdk = makeSdkSession("s1", { backendType: "codex" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
      currentSessionId: "s1",
    });

    const { container } = render(<Sidebar />);
    const brandLogo = container.querySelector("aside img");
    expect(brandLogo).toHaveAttribute("src", "/logo.svg");
  });

  it("sessions are grouped by creation time", () => {
    // Validates: recent sessions land under "Today" while sessions older
    // than 7 days land under "Older".
    const dayMs = 86400000;
    const sdkToday = makeSdkSession("s1", { model: "today-model" });
    const sdkOld = makeSdkSession("s2", {
      model: "older-model",
      createdAt: Date.now() - 8 * dayMs,
    });
    mockState = createMockState({
      sdkSessions: [sdkToday, sdkOld],
    });

    render(<Sidebar />);
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();
    expect(screen.getByText("today-model")).toBeInTheDocument();
    expect(screen.getByText("older-model")).toBeInTheDocument();
  });

  it("sessions header shows total session count", () => {
    // Validates: the "Sessions" section header displays the number of active
    // (non-archived) sessions.
    const session1 = makeSession("s1", { cwd: "/home/user/myapp" });
    const session2 = makeSession("s2", { cwd: "/home/user/myapp" });
    const sdk1 = makeSdkSession("s1", { cwd: "/home/user/myapp" });
    const sdk2 = makeSdkSession("s2", { cwd: "/home/user/myapp" });
    mockState = createMockState({
      sessions: new Map([["s1", session1], ["s2", session2]]),
      sdkSessions: [sdk1, sdk2],
      sessionStatus: new Map([["s1", "running"], ["s2", "running"]]),
    });

    render(<Sidebar />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("collapsing a folder hides its sessions", async () => {
    // Validates: user-defined folders group sessions and can be collapsed by
    // clicking the folder header. Collapsed folders hide their session rows.
    mockApi.listFolders.mockResolvedValueOnce([
      { id: "f1", name: "Work", sessionIds: ["s1"], createdAt: 1 },
    ]);
    const session = makeSession("s1", { cwd: "/home/user/myapp", model: "hidden-model" });
    const sdk = makeSdkSession("s1", { cwd: "/home/user/myapp", model: "hidden-model" });
    mockState = createMockState({
      sessions: new Map([["s1", session]]),
      sdkSessions: [sdk],
    });

    render(<Sidebar />);

    // Folder header appears once folders load; its session is visible
    const folderHeader = await screen.findByText("Work");
    expect(screen.getByText("hidden-model")).toBeInTheDocument();

    // Collapse the folder — the session inside it should be hidden
    fireEvent.click(folderHeader.closest("button")!);
    expect(screen.queryByText("hidden-model")).not.toBeInTheDocument();
  });
});
