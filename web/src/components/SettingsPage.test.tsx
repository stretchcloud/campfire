// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// The SettingsPage is organized into tabs (General, Providers, API Keys,
// Security, Notifications, Appearance, Updates). Tests navigate to the tab
// that owns each setting before interacting with it.

interface MockStoreState {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  updateInfo: {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    isServiceMode: boolean;
    updateInProgress: boolean;
    lastChecked: number;
  } | null;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  setUpdateInfo: ReturnType<typeof vi.fn>;
  setUpdateOverlayActive: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    updateInfo: null,
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    setUpdateInfo: vi.fn(),
    setUpdateOverlayActive: vi.fn(),
    ...overrides,
  };
}

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  forceCheckForUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
  getAuthStatus: vi.fn(),
  setupAuth: vi.fn(),
  login: vi.fn(),
  disableAuth: vi.fn(),
  setAuthToken: vi.fn(),
};

const mockTelemetry = {
  getTelemetryPreferenceEnabled: vi.fn(),
  setTelemetryPreferenceEnabled: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    forceCheckForUpdate: (...args: unknown[]) => mockApi.forceCheckForUpdate(...args),
    triggerUpdate: (...args: unknown[]) => mockApi.triggerUpdate(...args),
    getAuthStatus: (...args: unknown[]) => mockApi.getAuthStatus(...args),
    setupAuth: (...args: unknown[]) => mockApi.setupAuth(...args),
    login: (...args: unknown[]) => mockApi.login(...args),
    disableAuth: (...args: unknown[]) => mockApi.disableAuth(...args),
  },
  setAuthToken: (...args: unknown[]) => mockApi.setAuthToken(...args),
  // Mirrors the real constant exported by api.ts — the Memory tab seeds its
  // draft from it when loaded settings carry no `memory` section.
  DEFAULT_MEMORY_SETTINGS: {
    decay: {
      global: { halfLifeHours: 2160, reinforceMultiplier: 1.5 },
      repo: { halfLifeHours: 720, reinforceMultiplier: 1.5 },
      session: { halfLifeHours: 168, reinforceMultiplier: 1.2 },
      agent: { halfLifeHours: 1440, reinforceMultiplier: 1.2 },
    },
    recallDepth: { session: 4, repo: 6, agent: 2, global: 3 },
  },
}));

vi.mock("../analytics.js", () => ({
  getTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.getTelemetryPreferenceEnabled(...args),
  setTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.setTelemetryPreferenceEnabled(...args),
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/settings";
  mockApi.getSettings.mockResolvedValue({
    openrouterApiKeyConfigured: true,
    openrouterModel: "openrouter/free",
    moltbookApiKeyConfigured: false,
  });
  mockApi.updateSettings.mockResolvedValue({
    openrouterApiKeyConfigured: true,
    openrouterModel: "openrouter/free",
    moltbookApiKeyConfigured: false,
  });
  mockApi.forceCheckForUpdate.mockResolvedValue({
    currentVersion: "0.22.1",
    latestVersion: null,
    updateAvailable: false,
    isServiceMode: false,
    updateInProgress: false,
    lastChecked: Date.now(),
  });
  mockApi.triggerUpdate.mockResolvedValue({
    ok: true,
    message: "Update started. Server will restart shortly.",
  });
  mockApi.getAuthStatus.mockResolvedValue({
    enabled: false,
    hasPassword: false,
    activeSessions: 0,
    isLoggedIn: true,
  });
  mockApi.setupAuth.mockResolvedValue({
    ok: true,
    enabled: true,
    hasPassword: true,
    activeSessions: 0,
  });
  mockApi.login.mockResolvedValue({ token: "new-session-token" });
  mockApi.disableAuth.mockResolvedValue({ ok: true });
  mockTelemetry.getTelemetryPreferenceEnabled.mockReturnValue(true);
});

/** Switch to a settings tab by its accessible tab name. */
function openTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

/** Wait for the initial getSettings load to have been kicked off and settled. */
async function waitForSettingsLoad() {
  await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalledTimes(1));
}

/**
 * The OpenRouter API key input lives on the "API Keys" tab and is labeled
 * simply "API Key" (as is the Moltbook key input), so we resolve it by id.
 */
function getOpenrouterKeyInput(): HTMLElement {
  const input = document.getElementById("openrouter-key");
  expect(input).not.toBeNull();
  return input as HTMLElement;
}

describe("SettingsPage", () => {
  it("loads settings on mount and shows configured status", async () => {
    // Validates: getSettings fires once on mount, and the API Keys tab shows
    // the "Configured" badge plus the persisted OpenRouter model value.
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    openTab("API Keys");
    await screen.findByText("Configured");
    expect(screen.getByDisplayValue("openrouter/free")).toBeInTheDocument();
  });

  it("shows not configured status", async () => {
    // Validates: when no OpenRouter key is stored, the API Keys tab shows the
    // "not configured" helper explaining that auto-naming is disabled.
    mockApi.getSettings.mockResolvedValueOnce({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openrouter/free",
      moltbookApiKeyConfigured: false,
    });

    render(<SettingsPage />);

    openTab("API Keys");
    await screen.findByText("Not configured — auto-naming is disabled");
  });

  it("shows the auto-naming helper copy under the API key input", async () => {
    // Validates: the OpenRouter card explains that the key drives session
    // auto-naming after the first turn.
    render(<SettingsPage />);

    openTab("API Keys");
    expect(
      await screen.findByText("Used for auto-naming sessions after the first turn"),
    ).toBeInTheDocument();
  });

  it("saves settings with trimmed values", async () => {
    // Validates: key/model values are trimmed before being sent to the API,
    // and the success confirmation is displayed.
    render(<SettingsPage />);
    openTab("API Keys");
    await screen.findByText("Configured");

    fireEvent.change(getOpenrouterKeyInput(), {
      target: { value: "  or-key  " },
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "  openai/gpt-4o-mini  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save API Keys" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterApiKey: "or-key",
        openrouterModel: "openai/gpt-4o-mini",
      });
    });

    expect(await screen.findByText("Settings saved successfully")).toBeInTheDocument();
  });

  it("falls back model to openrouter/free when blank", async () => {
    // Validates: a whitespace-only model resets to the default openrouter/free.
    render(<SettingsPage />);
    openTab("API Keys");
    await screen.findByText("Configured");
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "   " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save API Keys" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterModel: "openrouter/free",
      });
    });
  });

  it("does not send key when left empty", async () => {
    // Validates: leaving the key input empty keeps the stored key untouched
    // (payload omits openrouterApiKey entirely).
    render(<SettingsPage />);
    openTab("API Keys");
    await screen.findByText("Configured");

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "openai/gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API Keys" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        openrouterModel: "openai/gpt-4o-mini",
      });
    });
  });

  it("shows error if initial load fails", async () => {
    // Validates: a getSettings failure surfaces in the API Keys save bar.
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    openTab("API Keys");
    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("shows error if save fails", async () => {
    // Validates: an updateSettings failure surfaces in the API Keys save bar.
    mockApi.updateSettings.mockRejectedValueOnce(new Error("save failed"));

    render(<SettingsPage />);
    openTab("API Keys");
    await screen.findByText("Configured");

    fireEvent.change(getOpenrouterKeyInput(), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API Keys" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    // Validates: the standalone (non-embedded) page has a "Go back" button
    // that clears the location hash.
    render(<SettingsPage />);
    await waitForSettingsLoad();

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    // Validates: when rendered inside the app chrome (embedded), the back
    // button is hidden because the sidebar provides navigation.
    render(<SettingsPage embedded />);
    await waitForSettingsLoad();
    expect(screen.queryByRole("button", { name: "Go back" })).not.toBeInTheDocument();
  });

  it("shows saving state while request is in flight", async () => {
    // Validates: the save button is disabled and reads "Saving..." until the
    // updateSettings promise resolves.
    let resolveSave: ((value: {
      openrouterApiKeyConfigured: boolean;
      openrouterModel: string;
      moltbookApiKeyConfigured: boolean;
    }) => void) | undefined;
    mockApi.updateSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve as typeof resolveSave;
      }),
    );

    render(<SettingsPage />);
    openTab("API Keys");
    await screen.findByText("Configured");

    fireEvent.change(getOpenrouterKeyInput(), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API Keys" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    resolveSave?.({
      openrouterApiKeyConfigured: true,
      openrouterModel: "openrouter/free",
      moltbookApiKeyConfigured: false,
    });

    await screen.findByText("Settings saved successfully");
  });

  it("toggles sound notifications from settings", async () => {
    // Validates: the Notifications tab exposes a sound toggle wired to the
    // store's toggleNotificationSound action.
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Notifications");
    fireEvent.click(screen.getByRole("switch", { name: "Toggle notification sound" }));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("toggles theme from settings", async () => {
    // Validates: the Appearance tab exposes a dark mode toggle wired to the
    // store's toggleDarkMode action.
    mockState = createMockState({ darkMode: true });
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Appearance");
    fireEvent.click(screen.getByRole("switch", { name: "Toggle dark mode" }));
    expect(mockState.toggleDarkMode).toHaveBeenCalledTimes(1);
  });

  it("toggles telemetry preference from settings", async () => {
    // Validates: the General tab's telemetry toggle persists the inverted
    // preference (enabled -> disabled).
    render(<SettingsPage />);
    await waitForSettingsLoad();

    fireEvent.click(screen.getByRole("switch", { name: "Toggle telemetry" }));
    expect(mockTelemetry.setTelemetryPreferenceEnabled).toHaveBeenCalledWith(false);
  });

  it("navigates to environments page from settings", async () => {
    // Validates: the General tab's Environments card links to #/environments.
    render(<SettingsPage />);
    await waitForSettingsLoad();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(window.location.hash).toBe("#/environments");
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    // Validates: enabling desktop alerts first requests browser Notification
    // permission and only enables the setting once granted.
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    render(<SettingsPage />);
    await waitForSettingsLoad();
    openTab("Notifications");
    fireEvent.click(screen.getByRole("switch", { name: "Toggle desktop notifications" }));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(true);
    });
    vi.unstubAllGlobals();
  });

  it("checks for updates from settings and stores update info", async () => {
    // Validates: the Updates tab's check button stores the fetched update
    // info in the store and shows the available-version message.
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.22.1",
      latestVersion: "0.23.0",
      updateAvailable: true,
      isServiceMode: true,
      updateInProgress: false,
      lastChecked: Date.now(),
    });

    render(<SettingsPage />);
    await waitForSettingsLoad();
    openTab("Updates");
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));

    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalledTimes(1);
      expect(mockState.setUpdateInfo).toHaveBeenCalledWith(expect.objectContaining({
        latestVersion: "0.23.0",
        updateAvailable: true,
      }));
    });
    expect(await screen.findByText("Update v0.23.0 is available.")).toBeInTheDocument();
  });

  it("triggers app update from settings when service mode is enabled", async () => {
    // Validates: with an available update in service mode, "Update & Restart"
    // triggers the server update and activates the update overlay.
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.22.1",
        latestVersion: "0.23.0",
        updateAvailable: true,
        isServiceMode: true,
        updateInProgress: false,
        lastChecked: Date.now(),
      },
    });
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Updates");
    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));

    await waitFor(() => {
      expect(mockApi.triggerUpdate).toHaveBeenCalledTimes(1);
    });
    expect(mockState.setUpdateOverlayActive).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Update started. Server will restart shortly.")).toBeInTheDocument();
  });

  it("sets up password authentication from the Security tab", async () => {
    // Validates: enabling auth calls setupAuth, logs in with the same
    // password, stores the returned session token, and confirms with "Saved".
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Security");
    fireEvent.change(screen.getByLabelText("Set a password"), {
      target: { value: "valid-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enable Authentication" }));

    await waitFor(() => {
      expect(mockApi.setupAuth).toHaveBeenCalledWith("valid-password");
    });
    expect(mockApi.login).toHaveBeenCalledWith("valid-password");
    expect(mockApi.setAuthToken).toHaveBeenCalledWith("new-session-token");
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });
});

describe("SettingsPage - Memory tab", () => {
  it("shows default memory settings (days) when the server has no memory section", async () => {
    // Validates: with no `memory` in GET /settings, the Memory tab seeds from
    // DEFAULT_MEMORY_SETTINGS — half-lives shown in days (90/30/7/60) and the
    // default recall depths.
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Memory");

    expect(document.getElementById("memory-halflife-global")).toHaveValue(90);
    expect(document.getElementById("memory-halflife-repo")).toHaveValue(30);
    expect(document.getElementById("memory-halflife-session")).toHaveValue(7);
    expect(document.getElementById("memory-halflife-agent")).toHaveValue(60);
    expect(document.getElementById("memory-depth-repo")).toHaveValue(6);
    expect(document.getElementById("memory-depth-session")).toHaveValue(4);
  });

  it("saves memory settings converting days to hours and empty half-life to null", async () => {
    // Validates: PUT /settings receives { memory } with halfLifeHours derived
    // from the days inputs, and an empty half-life persists as null (never
    // decays), matching the §3.1 settings contract.
    mockApi.updateSettings.mockResolvedValueOnce({});
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Memory");
    fireEvent.change(document.getElementById("memory-halflife-repo")!, {
      target: { value: "14" },
    });
    fireEvent.change(document.getElementById("memory-halflife-global")!, {
      target: { value: "" },
    });
    fireEvent.change(document.getElementById("memory-depth-agent")!, {
      target: { value: "5" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Memory Settings" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        memory: {
          decay: {
            global: { halfLifeHours: null, reinforceMultiplier: 1.5 },
            repo: { halfLifeHours: 336, reinforceMultiplier: 1.5 },
            session: { halfLifeHours: 168, reinforceMultiplier: 1.2 },
            agent: { halfLifeHours: 1440, reinforceMultiplier: 1.2 },
          },
          recallDepth: { session: 4, repo: 6, agent: 5, global: 3 },
        },
      });
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("rejects an invalid reinforce multiplier without calling the API", async () => {
    // Validates: client-side validation blocks multipliers < 1 and surfaces
    // an inline error instead of persisting bad settings.
    render(<SettingsPage />);
    await waitForSettingsLoad();

    openTab("Memory");
    fireEvent.change(document.getElementById("memory-reinforce-repo")!, {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Memory Settings" }));

    expect(await screen.findByText(/reinforce multiplier must be/)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it("loads server-provided memory settings into the form", async () => {
    // Validates: when GET /settings includes a memory section, the form shows
    // those values instead of defaults.
    mockApi.getSettings.mockResolvedValueOnce({
      openrouterApiKeyConfigured: false,
      openrouterModel: "openrouter/free",
      moltbookApiKeyConfigured: false,
      memory: {
        decay: {
          global: { halfLifeHours: null, reinforceMultiplier: 2 },
          repo: { halfLifeHours: 48, reinforceMultiplier: 1.5 },
          session: { halfLifeHours: 168, reinforceMultiplier: 1.2 },
          agent: { halfLifeHours: 1440, reinforceMultiplier: 1.2 },
        },
        recallDepth: { session: 1, repo: 2, agent: 3, global: 4 },
      },
    });

    render(<SettingsPage />);
    await waitForSettingsLoad();
    openTab("Memory");

    await waitFor(() => {
      expect(document.getElementById("memory-halflife-repo")).toHaveValue(2);
    });
    // null half-life renders as an empty input (placeholder "never")
    expect(document.getElementById("memory-halflife-global")).toHaveValue(null);
    expect(document.getElementById("memory-reinforce-global")).toHaveValue(2);
    expect(document.getElementById("memory-depth-global")).toHaveValue(4);
  });
});
