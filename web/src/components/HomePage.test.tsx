// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
// Registers jest-dom matchers (toBeInTheDocument, etc.) with vitest's expect.
// Without this import the assertions throw "Invalid Chai property".
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage.js";
import { useStore } from "../store.js";
import { getDefaultModel } from "../utils/backends.js";

const apiMock = vi.hoisted(() => ({
  getSlashCommands: vi.fn(),
  getHome: vi.fn(),
  listEnvs: vi.fn(),
  getBackends: vi.fn(),
  getRepoInfo: vi.fn(),
  createSession: vi.fn(),
}));

const wsMock = vi.hoisted(() => ({
  connectSession: vi.fn(),
  waitForConnection: vi.fn(),
  sendToSession: vi.fn(),
  disconnectSession: vi.fn(),
}));

vi.mock("../api.js", () => ({ api: apiMock }));
vi.mock("../ws.js", () => wsMock);

function setupBrowserApis() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function setupApiDefaults() {
  apiMock.getSlashCommands.mockResolvedValue({ commands: [] });
  apiMock.getHome.mockResolvedValue({ home: "/home/user", cwd: "/repo" });
  apiMock.listEnvs.mockResolvedValue([]);
  apiMock.getBackends.mockResolvedValue([
    { id: "claude", name: "Claude Code", available: true },
    { id: "codex", name: "Codex", available: true },
  ]);
  apiMock.getRepoInfo.mockRejectedValue(new Error("not a git repo"));
  apiMock.createSession.mockResolvedValue({
    sessionId: "s1",
    state: "starting",
    cwd: "/repo",
  });
  wsMock.waitForConnection.mockResolvedValue(undefined);
}

beforeEach(() => {
  setupBrowserApis();
  localStorage.clear();
  useStore.getState().reset();
  vi.clearAllMocks();
  setupApiDefaults();
});

async function sendNewSessionPrompt(prompt: string) {
  render(<HomePage />);
  fireEvent.change(screen.getByLabelText("Task description"), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByLabelText("Send message"));
  await waitFor(() => expect(apiMock.createSession).toHaveBeenCalled());
  return apiMock.createSession.mock.calls[0][0] as Record<string, unknown>;
}

describe("HomePage Codex model selection", () => {
  it("shows Codex default instead of a model selector", async () => {
    localStorage.setItem("cc-backend", "codex");
    render(<HomePage />);

    fireEvent.click(screen.getByText("Options"));

    // Codex owns model selection through its own config/login defaults, so the
    // launch form must not present stale Campfire-maintained GPT model choices.
    expect(screen.getByText("Codex default")).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("omits model when creating a Codex session", async () => {
    localStorage.setItem("cc-backend", "codex");

    const payload = await sendNewSessionPrompt("use codex config");

    expect(payload.backend).toBe("codex");
    expect(payload).not.toHaveProperty("model");
  });

  it("keeps sending the selected model when creating a Claude session", async () => {
    localStorage.setItem("cc-backend", "claude");

    const payload = await sendNewSessionPrompt("use claude model");

    expect(payload.backend).toBe("claude");
    expect(payload.model).toBe(getDefaultModel("claude"));
  });
});
