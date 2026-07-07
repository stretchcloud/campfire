// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import type { MemoryEnrichmentItem } from "../types.js";
import { RecalledContextChip } from "./RecalledContextChip.js";

const ITEMS: MemoryEnrichmentItem[] = [
  {
    id: "mem-1",
    kind: "knowledge",
    namespace: "repo:a1b2c3",
    tag: "auth",
    summary: "Auth middleware validates JWT bearer tokens",
    weight: 0.9,
  },
  {
    id: "mem-2",
    kind: "fragment",
    namespace: "global",
    summary: "Prefer bun over npm for all scripts",
    weight: 0.42,
  },
];

describe("RecalledContextChip - collapsed state", () => {
  it("renders a one-line summary with the recalled count", () => {
    // Validates: collapsed chip shows "Recalled N memories" without exposing
    // the item summaries (expanded content is not mounted while collapsed).
    render(<RecalledContextChip items={ITEMS} />);

    expect(screen.getByText("Recalled 2 memories")).toBeTruthy();
    expect(screen.queryByText("Auth middleware validates JWT bearer tokens")).toBeNull();
    expect(screen.queryByText(/may be stale/)).toBeNull();
  });

  it("uses singular 'memory' for a single item", () => {
    render(<RecalledContextChip items={ITEMS.slice(0, 1)} />);
    expect(screen.getByText("Recalled 1 memory")).toBeTruthy();
  });

  it("shows a truncated badge in the collapsed header when items were omitted", () => {
    // Validates: the truncated flag is visible without expanding so users know
    // the recall was cut off by the context budget.
    render(<RecalledContextChip items={ITEMS} truncated />);
    expect(screen.getByText("truncated")).toBeTruthy();
  });

  it("renders nothing when there are no items", () => {
    const { container } = render(<RecalledContextChip items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("RecalledContextChip - expand/collapse", () => {
  it("expands on click to reveal summaries, namespace badges, tags, and the staleness hint", () => {
    // Validates: clicking the header toggles the expanded item list including
    // namespace class badge (prefix before ":"), tag, weight percent, and the
    // "may be stale" hint required by the design doc (§3.6.4).
    render(<RecalledContextChip items={ITEMS} />);

    fireEvent.click(screen.getByText("Recalled 2 memories").closest("button")!);

    expect(screen.getByText("Auth middleware validates JWT bearer tokens")).toBeTruthy();
    expect(screen.getByText("Prefer bun over npm for all scripts")).toBeTruthy();
    // Namespace badges show the class prefix; full namespace is in the title attr
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("repo").getAttribute("title")).toBe("repo:a1b2c3");
    expect(screen.getByText("global")).toBeTruthy();
    // Tag renders with a hash prefix
    expect(screen.getByText("#auth")).toBeTruthy();
    // Weight rendered as percent alongside the bar
    expect(screen.getByText("90%")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    // Staleness hint
    expect(screen.getByText(/may be stale/)).toBeTruthy();
  });

  it("collapses again on second click", () => {
    render(<RecalledContextChip items={ITEMS} />);
    const header = screen.getByText("Recalled 2 memories").closest("button")!;

    fireEvent.click(header);
    expect(screen.getByText("Prefer bun over npm for all scripts")).toBeTruthy();

    fireEvent.click(header);
    expect(screen.queryByText("Prefer bun over npm for all scripts")).toBeNull();
  });

  it("respects defaultOpen for Playground mocks", () => {
    render(<RecalledContextChip items={ITEMS} defaultOpen />);
    expect(screen.getByText("Auth middleware validates JWT bearer tokens")).toBeTruthy();
  });

  it("shows the omitted-items note when expanded with truncated set", () => {
    render(<RecalledContextChip items={ITEMS} truncated defaultOpen />);
    expect(screen.getByText(/some items omitted/)).toBeTruthy();
  });

  it("renders kind icons distinguishing knowledge from fragments", () => {
    // Validates: each item row carries a kind icon (aria-label knowledge/fragment).
    render(<RecalledContextChip items={ITEMS} defaultOpen />);
    expect(screen.getByLabelText("knowledge")).toBeTruthy();
    expect(screen.getByLabelText("fragment")).toBeTruthy();
  });

  it("clamps the weight bar width to 0-100%", () => {
    // Validates: out-of-range weights (defensive against server bugs) don't
    // overflow the bar.
    render(
      <RecalledContextChip
        items={[
          { id: "m-hi", kind: "fragment", namespace: "global", summary: "over", weight: 1.7 },
          { id: "m-lo", kind: "fragment", namespace: "global", summary: "under", weight: -0.3 },
        ]}
        defaultOpen
      />,
    );
    const fills = screen.getAllByTestId("weight-bar-fill");
    expect(fills[0].style.width).toBe("100%");
    expect(fills[1].style.width).toBe("0%");
  });
});
