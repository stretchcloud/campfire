import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WebhookEvent } from "./webhook-types.js";

// ─── Mock homedir so webhook-store writes to a temp directory ────────────────

let tempDir: string;
let webhookStore: typeof import("./webhook-store.js");
let WebhookManager: typeof import("./webhook-manager.js").WebhookManager;

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

// ─── Mock global fetch ──────────────────────────────────────────────────────

const mockFetch = vi.fn<typeof fetch>();

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "webhook-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();

  // Re-import both modules after resetting so they share the same mocked homedir
  webhookStore = await import("./webhook-store.js");
  const managerModule = await import("./webhook-manager.js");
  WebhookManager = managerModule.WebhookManager;

  // Set up global fetch mock with a default successful response
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("OK", { status: 200 }));
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ─── Helper to create a test webhook ────────────────────────────────────────

function createTestWebhook(overrides: Record<string, unknown> = {}) {
  return webhookStore.createWebhook({
    name: "Test Hook",
    url: "https://example.com/webhook",
    events: ["session.created"] as WebhookEvent[],
    enabled: true,
    ...overrides,
  });
}

// ===========================================================================
// WebhookManager.emit() — verify it POSTs to matching webhooks
// ===========================================================================
describe("WebhookManager.emit()", () => {
  it("sends a POST request to a matching webhook", async () => {
    // Create a webhook subscribed to session.created
    createTestWebhook({ name: "Session Hook", events: ["session.created"] });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-123", { model: "claude-sonnet" });

    // Wait for the async delivery to complete
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/webhook");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toBeDefined();

    const body = JSON.parse(options?.body as string);
    expect(body.event).toBe("session.created");
    expect(body.sessionId).toBe("sess-123");
    expect(body.data.model).toBe("claude-sonnet");
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it("does not send to disabled webhooks", async () => {
    // Create a disabled webhook
    createTestWebhook({ name: "Disabled Hook", events: ["session.created"], enabled: false });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-123", {});

    // Give the async delivery time to fire (it should not)
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not send to webhooks not subscribed to the event", async () => {
    // Webhook only cares about session.completed, but we emit session.created
    createTestWebhook({ name: "Wrong Event", events: ["session.completed"] });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-123", {});

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends to multiple matching webhooks", async () => {
    createTestWebhook({ name: "Hook A", url: "https://a.example.com/hook", events: ["session.created"] });
    createTestWebhook({ name: "Hook B", url: "https://b.example.com/hook", events: ["session.created"] });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-123", {});

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const urls = mockFetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("https://a.example.com/hook");
    expect(urls).toContain("https://b.example.com/hook");
  });

  it("includes correct custom headers in the request", async () => {
    createTestWebhook({ name: "Header Check" });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-abc", {});

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("Campfire-Webhook/1.0");
    expect(headers["X-Campfire-Event"]).toBe("session.created");
    expect(headers["X-Campfire-Delivery"]).toMatch(/^header-check-/);
  });
});

// ===========================================================================
// HMAC Signing — verify X-Campfire-Signature is correct HMAC-SHA256
// ===========================================================================
describe("HMAC signing", () => {
  it("includes X-Campfire-Signature header when secret is set", async () => {
    createTestWebhook({ name: "Signed Hook", secret: "my-secret-key" });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-456", { foo: "bar" });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    const body = mockFetch.mock.calls[0][1]?.body as string;

    // Verify the signature matches our own HMAC-SHA256 computation
    const expectedSignature =
      "sha256=" + createHmac("sha256", "my-secret-key").update(body).digest("hex");
    expect(headers["X-Campfire-Signature"]).toBe(expectedSignature);
  });

  it("does not include X-Campfire-Signature when no secret is set", async () => {
    createTestWebhook({ name: "Unsigned Hook" });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-789", {});

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Campfire-Signature"]).toBeUndefined();
  });

  it("produces a valid sha256 HMAC hex digest", async () => {
    const secret = "test-secret-value";
    createTestWebhook({ name: "HMAC Verify", secret });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-hmac", { key: "value" });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
    const signature = headers["X-Campfire-Signature"];

    // Should be "sha256=" followed by exactly 64 hex characters
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});

// ===========================================================================
// Cost threshold checking — thresholds only emitted once per session
// ===========================================================================
describe("cost threshold checking", () => {
  it("emits cost.threshold when threshold is crossed", async () => {
    createTestWebhook({ name: "Cost Watcher", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    manager.checkCostThreshold("sess-cost-1", 0.55);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.event).toBe("cost.threshold");
    expect(body.data.threshold).toBe(0.50);
    expect(body.data.totalCostUsd).toBe(0.55);
  });

  it("emits multiple thresholds when cost jumps past several", async () => {
    createTestWebhook({ name: "Multi Threshold", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    // Jump past $0.50 and $1.00 in one go
    manager.checkCostThreshold("sess-cost-2", 1.50);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const bodies = mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts?.body as string));
    const thresholds = bodies.map((b: Record<string, unknown>) => (b.data as Record<string, unknown>).threshold).sort();
    expect(thresholds).toEqual([0.50, 1.00]);
  });

  it("does not re-emit a threshold already crossed for the same session", async () => {
    createTestWebhook({ name: "No Re-emit", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    manager.checkCostThreshold("sess-cost-3", 0.55);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    mockFetch.mockClear();

    // Same session, same or slightly higher cost — $0.50 threshold already crossed
    manager.checkCostThreshold("sess-cost-3", 0.60);

    await new Promise((r) => setTimeout(r, 50));
    // Should not have fired again for $0.50 since it was already emitted
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("emits separately for different sessions", async () => {
    createTestWebhook({ name: "Multi Session", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    manager.checkCostThreshold("sess-a", 0.55);
    manager.checkCostThreshold("sess-b", 0.55);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const sessionIds = mockFetch.mock.calls.map(
      ([, opts]) => JSON.parse(opts?.body as string).sessionId,
    );
    expect(sessionIds).toContain("sess-a");
    expect(sessionIds).toContain("sess-b");
  });

  it("clears threshold tracking when clearSession is called", async () => {
    createTestWebhook({ name: "Clear Session", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    manager.checkCostThreshold("sess-clear", 0.55);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    mockFetch.mockClear();

    // Clear session threshold tracking, then re-check — should re-emit the $0.50 threshold
    manager.clearSession("sess-clear");
    manager.checkCostThreshold("sess-clear", 0.55);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.data.threshold).toBe(0.50);
  });

  it("does not emit when cost is below all thresholds", async () => {
    createTestWebhook({ name: "Below Threshold", events: ["cost.threshold"] });

    const manager = new WebhookManager();
    // $0.10 is below the lowest threshold of $0.50
    manager.checkCostThreshold("sess-low", 0.10);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Filter matching — verify sessionFilter works (backendType, cwd)
// ===========================================================================
describe("filter matching", () => {
  it("sends when no filter is configured", async () => {
    createTestWebhook({ name: "No Filter" });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-any", { backendType: "codex", cwd: "/anything" });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("filters by backendType — matching", async () => {
    createTestWebhook({
      name: "Claude Only",
      sessionFilter: { backendType: "claude" },
    });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-claude", { backendType: "claude" });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("filters by backendType — non-matching", async () => {
    createTestWebhook({
      name: "Claude Only 2",
      sessionFilter: { backendType: "claude" },
    });

    const manager = new WebhookManager();
    // Data has backendType "codex" but filter expects "claude" — should be excluded
    manager.emit("session.created", "sess-codex", { backendType: "codex" });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("filters by cwd prefix — matching", async () => {
    createTestWebhook({
      name: "Repo Filter",
      sessionFilter: { cwd: "/home/user/projects" },
    });

    const manager = new WebhookManager();
    // cwd starts with the filter prefix — should match
    manager.emit("session.created", "sess-proj", { cwd: "/home/user/projects/my-app" });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("filters by cwd prefix — non-matching", async () => {
    createTestWebhook({
      name: "Repo Filter 2",
      sessionFilter: { cwd: "/home/user/projects" },
    });

    const manager = new WebhookManager();
    // cwd does NOT start with the filter prefix
    manager.emit("session.created", "sess-other", { cwd: "/home/other/stuff" });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("passes when filter field is set but data does not include it", async () => {
    // If the filter specifies backendType but the data doesn't include it,
    // the filter should pass (no data to compare against)
    createTestWebhook({
      name: "Missing Data",
      sessionFilter: { backendType: "claude" },
    });

    const manager = new WebhookManager();
    manager.emit("session.created", "sess-nobackend", {});

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("applies both filters together — both must match", async () => {
    createTestWebhook({
      name: "Both Filters",
      sessionFilter: { backendType: "claude", cwd: "/home/user/repo" },
    });

    const manager = new WebhookManager();

    // backendType matches but cwd does not — should be excluded
    manager.emit("session.created", "sess-partial", {
      backendType: "claude",
      cwd: "/other/path",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockFetch).not.toHaveBeenCalled();

    // Both filters match — should send
    manager.emit("session.created", "sess-both", {
      backendType: "claude",
      cwd: "/home/user/repo/subdir",
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

// ===========================================================================
// Slack payload formatting — verify static method output
// ===========================================================================
describe("WebhookManager.formatSlackPayload()", () => {
  it("returns correct text and blocks for session.created", () => {
    const result = WebhookManager.formatSlackPayload(
      "session.created",
      "abcdef12-3456-7890-abcd-ef1234567890",
      { model: "claude-sonnet" },
    );

    expect(result.text).toBe("Campfire: Session Started \u2014 session abcdef12");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*Session Started*" },
    });
  });

  it("includes model field when provided", () => {
    const result = WebhookManager.formatSlackPayload(
      "session.completed",
      "sess12345678",
      { model: "gpt-4o", totalCostUsd: 1.2345 },
    );

    const fields = result.blocks[1].fields as Array<{ type: string; text: string }>;
    const modelField = fields.find((f) => f.text.includes("Model"));
    expect(modelField).toBeDefined();
    expect(modelField!.text).toBe("*Model:* gpt-4o");
  });

  it("includes cost field when totalCostUsd is a number", () => {
    const result = WebhookManager.formatSlackPayload(
      "cost.threshold",
      "sess12345678",
      { totalCostUsd: 5.6789 },
    );

    const fields = result.blocks[1].fields as Array<{ type: string; text: string }>;
    const costField = fields.find((f) => f.text.includes("Cost"));
    expect(costField).toBeDefined();
    expect(costField!.text).toBe("*Cost:* $5.6789");
  });

  it("omits model field when not provided", () => {
    const result = WebhookManager.formatSlackPayload(
      "session.failed",
      "sess12345678",
      {},
    );

    const fields = result.blocks[1].fields as Array<{ type: string; text: string }>;
    const modelField = fields.find((f) => f.text.includes("Model"));
    expect(modelField).toBeUndefined();
  });

  it("omits cost field when totalCostUsd is not a number", () => {
    const result = WebhookManager.formatSlackPayload(
      "session.created",
      "sess12345678",
      {},
    );

    const fields = result.blocks[1].fields as Array<{ type: string; text: string }>;
    const costField = fields.find((f) => f.text.includes("Cost"));
    expect(costField).toBeUndefined();
  });

  it("truncates sessionId to first 8 characters", () => {
    const result = WebhookManager.formatSlackPayload(
      "turn.completed",
      "abcdefgh-long-session-id-here",
      {},
    );

    expect(result.text).toContain("abcdefgh");
    expect(result.text).not.toContain("abcdefgh-long");

    const fields = result.blocks[1].fields as Array<{ type: string; text: string }>;
    const sessionField = fields.find((f) => f.text.includes("Session"));
    expect(sessionField!.text).toBe("*Session:* abcdefgh");
  });

  it("maps all event types to human-readable labels", () => {
    // Verify every webhook event type has a corresponding human-readable label
    const events: WebhookEvent[] = [
      "session.created",
      "session.completed",
      "session.failed",
      "permission.requested",
      "permission.resolved",
      "turn.completed",
      "cost.threshold",
    ];

    const expectedLabels = [
      "Session Started",
      "Session Completed",
      "Session Failed",
      "Permission Requested",
      "Permission Resolved",
      "Turn Completed",
      "Cost Threshold Reached",
    ];

    for (let i = 0; i < events.length; i++) {
      const result = WebhookManager.formatSlackPayload(events[i], "sess12345678", {});
      expect(result.text).toContain(expectedLabels[i]);
    }
  });
});
