// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import { UpdateOverlay } from "./UpdateOverlay.js";

vi.mock("../api.js", () => ({
  getAuthToken: () => "test-token",
}));

describe("UpdateOverlay", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(<UpdateOverlay active={false} />);

    expect(container.innerHTML).toBe("");
  });

  it("shows the automatic refresh status when active", () => {
    render(<UpdateOverlay active />);

    expect(screen.getByTestId("update-overlay")).toBeInTheDocument();
    expect(screen.getByText("Installing update...")).toBeInTheDocument();
    expect(screen.getByText("This page will refresh automatically")).toBeInTheDocument();
  });
});
