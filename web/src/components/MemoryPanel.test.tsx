// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MemoryFragment } from "../types.js";

// MemoryPanel only reads currentSessionId from the store
vi.mock("../store.js", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentSessionId: "s1" }),
}));

// Mock the REST client (also keeps analytics/posthog out of the test)
vi.mock("../api.js", () => ({
  api: {
    getSessionMemory: vi.fn(),
    queryMemory: vi.fn(),
    consolidateMemory: vi.fn(),
    getMemoryOverview: vi.fn(),
    pinMemory: vi.fn(),
  },
}));

import { api } from "../api.js";
import { MemoryPanel } from "./MemoryPanel.js";

const mockedApi = api as unknown as {
  getSessionMemory: ReturnType<typeof vi.fn>;
  queryMemory: ReturnType<typeof vi.fn>;
  consolidateMemory: ReturnType<typeof vi.fn>;
  getMemoryOverview: ReturnType<typeof vi.fn>;
  pinMemory: ReturnType<typeof vi.fn>;
};

function makeFragment(overrides: Partial<MemoryFragment & { pinned?: boolean }> = {}): MemoryFragment & { pinned?: boolean } {
  return {
    id: "frag-1",
    sessionId: "s1",
    agentId: "agent-1",
    backendType: "claude",
    timestamp: 1700000000000,
    type: "decision",
    content: "Use token-bucket rate limiting",
    gitContext: { branch: "main", files: [], repoRoot: "/repo" },
    references: [],
    confidence: 0.8,
    tags: ["rate-limiting"],
    isConsolidated: false,
    ...overrides,
  };
}

const OVERVIEW = {
  namespaces: [
    { namespace: "repo:a1b2c3", count: 12, avgWeight: 0.62, pinnedCount: 2 },
    { namespace: "global", count: 5, avgWeight: 0.9, pinnedCount: 0 },
  ],
  knowledge: [
    { id: "know-1", tag: "auth", summary: "Auth uses JWT", confidence: 0.9, namespace: "repo:a1b2c3", synthesisMethod: "concat" as const },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.getSessionMemory.mockResolvedValue({ fragments: [makeFragment()], consolidated: [] });
  mockedApi.getMemoryOverview.mockResolvedValue(OVERVIEW);
  mockedApi.pinMemory.mockResolvedValue({ ok: true });
});

describe("MemoryPanel - namespace overview", () => {
  it("renders per-namespace counts, pinned counts, and avg-weight bars from the overview endpoint", async () => {
    // Validates: GET /sessions/:id/memory/overview drives the Namespaces
    // section — namespace name, item count, pinned count, and the decayed
    // average weight rendered as a percentage bar.
    render(<MemoryPanel />);

    await waitFor(() => expect(screen.getByText("repo:a1b2c3")).toBeTruthy());
    expect(mockedApi.getMemoryOverview).toHaveBeenCalledWith("s1");

    expect(screen.getByText("12 items · 2 pinned")).toBeTruthy();
    expect(screen.getByText("5 items")).toBeTruthy();
    expect(screen.getByText("62% avg weight")).toBeTruthy();
    expect(screen.getByText("90% avg weight")).toBeTruthy();
    // The bar width matches the rounded avg weight
    expect(screen.getByTestId("ns-weight-repo:a1b2c3").style.width).toBe("62%");
  });

  it("still renders fragments when the overview endpoint fails", async () => {
    // Validates: overview is loaded independently — a failing/missing v2
    // endpoint must not break the existing fragments list.
    mockedApi.getMemoryOverview.mockRejectedValue(new Error("not found"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<MemoryPanel />);

    await waitFor(() => expect(screen.getByText("Use token-bucket rate limiting")).toBeTruthy());
    expect(screen.queryByText(/avg weight/)).toBeNull();
    consoleSpy.mockRestore();
  });
});

describe("MemoryPanel - pin/unpin toggle", () => {
  it("optimistically pins a fragment and calls POST /memory/pin", async () => {
    // Validates: clicking the pin button flips the UI immediately (before the
    // API resolves) and sends { id, pinned: true } to the pin endpoint.
    let resolvePin: (v: { ok: boolean }) => void = () => {};
    mockedApi.pinMemory.mockReturnValue(new Promise((resolve) => { resolvePin = resolve; }));

    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText("Use token-bucket rate limiting")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Pin memory"));

    // Optimistic: button reflects pinned state before the request resolves
    expect(screen.getByLabelText("Unpin memory")).toBeTruthy();
    expect(mockedApi.pinMemory).toHaveBeenCalledWith("frag-1", true);

    resolvePin({ ok: true });
    await waitFor(() => expect(screen.getByLabelText("Unpin memory")).toBeTruthy());
  });

  it("reverts the optimistic pin when the API call fails", async () => {
    // Validates: on error the toggle rolls back so the UI never lies about
    // persisted pin state.
    mockedApi.pinMemory.mockRejectedValue(new Error("boom"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText("Use token-bucket rate limiting")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Pin memory"));
    await waitFor(() => expect(screen.getByLabelText("Pin memory")).toBeTruthy());
    expect(screen.queryByLabelText("Unpin memory")).toBeNull();
    consoleSpy.mockRestore();
  });

  it("unpins an already-pinned fragment", async () => {
    // Validates: fragments arriving with pinned: true (v2 server) start in the
    // pinned state and clicking sends pinned: false.
    mockedApi.getSessionMemory.mockResolvedValue({
      fragments: [makeFragment({ pinned: true })],
      consolidated: [],
    });

    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByLabelText("Unpin memory")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Unpin memory"));
    expect(mockedApi.pinMemory).toHaveBeenCalledWith("frag-1", false);
    expect(screen.getByLabelText("Pin memory")).toBeTruthy();
  });
});

describe("MemoryPanel - consolidated synthesis badge", () => {
  it("badges consolidated knowledge synthesized via concat fallback", async () => {
    // Validates: when the overview reports synthesisMethod "concat" for a
    // consolidated row, the Consolidated tab shows the concat badge (design
    // doc §3.4 — degraded no-LLM synthesis must be visible).
    mockedApi.getSessionMemory.mockResolvedValue({
      fragments: [],
      consolidated: [
        { id: "know-1", tag: "auth", summary: "Auth uses JWT", sourceFragments: ["f1"], lastUpdated: 1700000000000, confidence: 0.9, repoRoot: "/repo" },
      ],
    });

    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText("Consolidated (1)")).toBeTruthy());

    fireEvent.click(screen.getByText("Consolidated (1)"));
    await waitFor(() => expect(screen.getByText("Auth uses JWT")).toBeTruthy());
    expect(screen.getByText("concat")).toBeTruthy();
  });
});
