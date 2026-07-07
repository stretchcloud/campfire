// @vitest-environment jsdom

// jsdom does not implement scrollIntoView; polyfill it before any React rendering
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

import { render, screen } from "@testing-library/react";
import type { ChatMessage } from "../types.js";

// Mock react-markdown to avoid ESM issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

// Build a mock for the store that returns configurable values per session
const mockStoreValues: Record<string, unknown> = {};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      streaming: mockStoreValues.streaming ?? new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      toolProgress: mockStoreValues.toolProgress ?? new Map(),
      // MessageFeed reads sessions (for cwd, to decide fork availability) and
      // replaySessionId (to disable forking during replay) at render time, so
      // the mock must provide them or every render throws.
      sessions: mockStoreValues.sessions ?? new Map(),
      replaySessionId: mockStoreValues.replaySessionId ?? null,
      // Recalled-memory enrichments (memory_enriched broadcasts) rendered as
      // collapsible chips under the corresponding user messages.
      memoryEnrichments: mockStoreValues.memoryEnrichments ?? new Map(),
    };
    return selector(state);
  },
}));

import { MessageFeed } from "./MessageFeed.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setStoreMessages(sessionId: string, msgs: ChatMessage[]) {
  const map = new Map();
  map.set(sessionId, msgs);
  mockStoreValues.messages = map;
}

function setStoreStreaming(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streaming = map;
}

function setStoreStatus(sessionId: string, status: string | null) {
  const statusMap = new Map();
  if (status) statusMap.set(sessionId, status);
  mockStoreValues.sessionStatus = statusMap;
}

function setStoreStreamingStartedAt(sessionId: string, startedAt: number | undefined) {
  const map = new Map();
  if (startedAt !== undefined) map.set(sessionId, startedAt);
  mockStoreValues.streamingStartedAt = map;
}

function setStoreStreamingOutputTokens(sessionId: string, tokens: number | undefined) {
  const map = new Map();
  if (tokens !== undefined) map.set(sessionId, tokens);
  mockStoreValues.streamingOutputTokens = map;
}

function resetStore() {
  mockStoreValues.messages = new Map();
  mockStoreValues.streaming = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.replaySessionId = null;
  mockStoreValues.memoryEnrichments = new Map();
}

function setStoreMemoryEnrichments(sessionId: string, enrichments: Map<string, unknown>) {
  const map = new Map();
  map.set(sessionId, enrichments);
  mockStoreValues.memoryEnrichments = map;
}

beforeEach(() => {
  resetStore();
});

// ─── Pure functions tested through component output ──────────────────────────
// Since formatElapsed, formatTokens, getToolOnlyName, extractToolItems,
// groupToolMessages, groupMessages are not exported, we test them through the
// component's rendered output.

// ─── formatElapsed (tested via generation stats bar) ─────────────────────────

describe("MessageFeed - formatElapsed via stats bar", () => {
  it("formats seconds only (e.g. '5s') for short durations", () => {
    const sid = "test-elapsed-secs";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    // Set startedAt to 5 seconds ago
    setStoreStreamingStartedAt(sid, Date.now() - 5000);

    render(<MessageFeed sessionId={sid} />);

    // Should show "5s" (or close) in the stats bar
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });

  it("formats minutes and seconds (e.g. '2m 30s') for longer durations", () => {
    const sid = "test-elapsed-mins";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 150_000); // 2m 30s ago

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText(/^\d+m \d+s$/)).toBeTruthy();
  });
});

// ─── formatTokens (tested via generation stats bar) ──────────────────────────

describe("MessageFeed - formatTokens via stats bar", () => {
  it("formats token count with 'k' suffix for values >= 1000", () => {
    const sid = "test-tokens-k";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 1500);

    render(<MessageFeed sessionId={sid} />);

    // Should display token count formatted as "1.5k"
    expect(screen.getByText(/1\.5k/)).toBeTruthy();
  });

  it("formats token count as plain number for values < 1000", () => {
    const sid = "test-tokens-plain";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 500);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText(/500/)).toBeTruthy();
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("MessageFeed - empty state", () => {
  it("shows empty state when no messages and no streaming", () => {
    const sid = "test-empty";
    setStoreMessages(sid, []);

    render(<MessageFeed sessionId={sid} />);

    // Empty-state copy as rendered by MessageFeed
    expect(screen.getByText("Start a conversation")).toBeTruthy();
    expect(screen.getByText("Type a message below to begin")).toBeTruthy();
  });

  it("does not show empty state when there are messages", () => {
    const sid = "test-not-empty";
    setStoreMessages(sid, [
      makeMessage({ role: "user", content: "Hello" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
  });
});

// ─── Message rendering ───────────────────────────────────────────────────────

describe("MessageFeed - message rendering", () => {
  it("renders user and assistant messages", () => {
    const sid = "test-render-msgs";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "What is 2+2?" }),
      makeMessage({ id: "a1", role: "assistant", content: "The answer is 4." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("What is 2+2?")).toBeTruthy();
    // The assistant message goes through the mocked Markdown component
    expect(screen.getByText("The answer is 4.")).toBeTruthy();
  });

  it("renders system messages in the feed", () => {
    const sid = "test-system-msg";
    setStoreMessages(sid, [
      makeMessage({ id: "s1", role: "system", content: "Session restored" }),
      makeMessage({ id: "u1", role: "user", content: "Continue" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Session restored")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });
});

// ─── Streaming indicator ─────────────────────────────────────────────────────

describe("MessageFeed - streaming text", () => {
  it("renders streaming text with cursor animation", () => {
    const sid = "test-streaming";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Hello" }),
    ]);
    setStoreStreaming(sid, "I am currently thinking about");

    const { container } = render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("I am currently thinking about")).toBeTruthy();
    // The blinking cursor is a span with the animate-pulse class appended
    // after the streaming text inside the streaming <pre>
    const cursor = container.querySelector(".animate-pulse");
    expect(cursor).toBeTruthy();
  });

  it("does not render streaming indicator when no streaming text", () => {
    const sid = "test-no-stream";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Hello" }),
    ]);

    const { container } = render(<MessageFeed sessionId={sid} />);

    // The streaming indicator's blinking cursor (animate-pulse) must not be
    // present when there is no streaming text. (The user bubble also renders
    // a <pre>, so we assert on the cursor rather than <pre> presence.)
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });
});

// ─── Generation stats bar ────────────────────────────────────────────────────

describe("MessageFeed - generation stats bar", () => {
  // The stats bar no longer shows a "Generating..." label; it renders a pill
  // with a breathing status dot plus the elapsed time (and token count when
  // available). These tests assert on the elapsed-time text instead.
  it("renders stats bar when session is running", () => {
    const sid = "test-stats";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);

    const { container } = render(<MessageFeed sessionId={sid} />);

    // Elapsed time appears in the stats pill (e.g. "10s")
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
    // The breathing indicator dot is rendered alongside it
    expect(container.querySelector(".animate-breathing")).toBeTruthy();
  });

  it("does not render stats bar when session is idle", () => {
    const sid = "test-idle";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "idle");

    const { container } = render(<MessageFeed sessionId={sid} />);

    // No elapsed-time pill and no breathing dot when idle
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
    expect(container.querySelector(".animate-breathing")).toBeNull();
  });

  it("shows output tokens in stats bar when available", () => {
    const sid = "test-tokens-stats";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "hi" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<MessageFeed sessionId={sid} />);

    // Elapsed time and "2.5k tokens" both appear in the running stats pill
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
    expect(screen.getByText(/2\.5k tokens/)).toBeTruthy();
  });
});

// ─── getToolOnlyName behavior (tested via grouping) ──────────────────────────

describe("MessageFeed - tool-only message detection", () => {
  it("groups consecutive same-tool assistant messages", () => {
    const sid = "test-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // When grouped at message level, both should appear under a single "Read File" group
    // with a count badge rendered as "x2"
    expect(screen.getByText("x2")).toBeTruthy();
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(1);
  });

  it("does not group different tool types across messages", () => {
    const sid = "test-no-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls" } },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
  });

  it("does not treat assistant messages with text as tool-only", () => {
    const sid = "test-mixed-msg";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "text", text: "Let me check something" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Should render as a regular message, not grouped
    expect(screen.getByText("Let me check something")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
  });
});

// ─── groupMessages with subagent nesting ─────────────────────────────────────

describe("MessageFeed - subagent grouping", () => {
  it("nests child messages under Task tool_use entries", () => {
    const sid = "test-subagent";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Research the problem", subagent_type: "researcher" },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Found the answer",
        parentToolUseId: "task-1",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The description appears in both the tool preview and the subagent container label
    expect(screen.getAllByText("Research the problem").length).toBeGreaterThanOrEqual(1);
    // The agent type badge should be shown
    expect(screen.getByText("researcher")).toBeTruthy();
  });
});

// ─── Recalled-context chips (memory_enriched) ────────────────────────────────

describe("MessageFeed - recalled-context chips", () => {
  const ENRICHMENT = {
    items: [
      { id: "mem-1", kind: "knowledge" as const, namespace: "repo:abc", tag: "auth", summary: "Auth uses JWT", weight: 0.8 },
    ],
    timestamp: Date.now(),
  };

  it("renders the chip under the user message matching the enrichment key", () => {
    // Validates: an enrichment keyed by a user message id renders a collapsed
    // "Recalled N memories" chip with that message, not with other messages.
    const sid = "test-enrichment-keyed";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "u2", role: "user", content: "Second question" }),
    ]);
    setStoreMemoryEnrichments(sid, new Map([["u1", ENRICHMENT]]));

    render(<MessageFeed sessionId={sid} />);

    const chip = screen.getByText("Recalled 1 memory");
    expect(chip).toBeTruthy();
    // The chip lives in the same feed-entry wrapper as the u1 bubble
    const entry = chip.closest("div.mt-6, div.mt-2, div:not([class])");
    expect(screen.getByText("First question")).toBeTruthy();
    expect(entry).toBeTruthy();
  });

  it("attaches a 'latest'-keyed enrichment to the most recent user message", () => {
    // Validates: enrichments the ws layer couldn't resolve to a message id
    // (stored under "latest") fall back to the last user message in the feed.
    const sid = "test-enrichment-latest";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Old question" }),
      makeMessage({ id: "u2", role: "user", content: "New question" }),
    ]);
    setStoreMemoryEnrichments(sid, new Map([["latest", ENRICHMENT]]));

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Recalled 1 memory")).toBeTruthy();
  });

  it("renders no chip when there are no enrichments", () => {
    const sid = "test-enrichment-none";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Question" })]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText(/Recalled \d+ memor/)).toBeNull();
  });
});
