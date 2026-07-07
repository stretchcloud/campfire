// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";

describe("Playground", () => {
  // The Playground renders every mock section in one pass (~4-7s in jsdom
  // depending on machine load), which flirts with the default 5s timeout.
  // Give the full-page render explicit headroom.
  it("renders the real chat stack section with integrated chat components", { timeout: 20000 }, () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Streaming text from MessageFeed mock state should also be rendered.
    expect(
      within(realChat).getByText("I'm updating tests and then I'll run the full suite."),
    ).toBeTruthy();
  });

  // Validates: the recalled-context chip (memory_enriched UI) has Playground
  // mocks in collapsed, expanded, and truncated variants, per the CLAUDE.md
  // rule that all message-flow components appear in the Playground.
  it("renders the recalled memory context section with chip variants", { timeout: 20000 }, () => {
    render(<Playground />);

    expect(screen.getByText("Recalled Memory Context")).toBeTruthy();
    // Collapsed + expanded + truncated(2 items) + single-item variants
    expect(screen.getAllByText("Recalled 4 memories").length).toBe(2);
    expect(screen.getByText("Recalled 2 memories")).toBeTruthy();
    expect(screen.getByText("Recalled 1 memory")).toBeTruthy();
    // The truncated variant surfaces its badge in the header
    expect(screen.getByText("truncated")).toBeTruthy();
    // Expanded variants show summaries and the staleness hint
    expect(
      screen.getAllByText(/API routes use the Hono middleware stack/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/may be stale/).length).toBeGreaterThanOrEqual(1);
  });
});
