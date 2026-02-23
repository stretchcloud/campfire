/**
 * Campfire channel plugin for OpenClaw.
 *
 * This plugin enables OpenClaw users to interact with their agents
 * through Campfire's rich web UI — with cost tracking, session replay,
 * permission voting, session gallery, and collaboration features
 * that OpenClaw's native UI doesn't have.
 *
 * Architecture:
 *   Browser (Campfire React UI)
 *       ↕ WebSocket
 *   Campfire Server (Hono/Bun)
 *       ↕ HTTP webhook + outbound API
 *   OpenClaw Gateway
 *       ↕ Agent runtime
 *   AI Agent (Claude, GPT, Gemini, etc.)
 */

import type {
  ChannelPlugin,
  InboundMessage,
} from "./types.js";

// ─── Active account tracking ────────────────────────────────────────────────

interface ActiveAccount {
  accountId: string;
  campfireUrl: string;
  onMessage: (msg: InboundMessage) => void;
}

const activeAccounts = new Map<string, ActiveAccount>();

// ─── Channel Plugin implementation ─────────────────────────────────────────

export const campfirePlugin: ChannelPlugin = {
  meta: {
    id: "campfire",
    label: "Campfire",
    icon: "🔥",
    docsPath: "/channels/campfire",
    blurb: "Rich web UI with cost tracking, session replay, and collaboration",
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  config: {
    fields: [
      {
        key: "campfireUrl",
        label: "Campfire Server URL",
        type: "url",
        required: true,
        placeholder: "http://localhost:3456",
        help: "The URL of your running Campfire server",
      },
      {
        key: "campfirePort",
        label: "Campfire Port",
        type: "number",
        required: false,
        placeholder: "3456",
        help: "Port number (default: 3456)",
      },
    ],

    validate(values: Record<string, string>): { valid: boolean; error?: string } {
      const url = values.campfireUrl;
      if (!url) {
        return { valid: false, error: "Campfire Server URL is required" };
      }
      try {
        new URL(url);
        return { valid: true };
      } catch {
        return { valid: false, error: "Invalid URL format" };
      }
    },
  },

  outbound: {
    /**
     * Send a text message from the OpenClaw agent to Campfire.
     * Posts to Campfire's inbound webhook endpoint.
     */
    async sendText(opts: {
      accountId: string;
      recipientId: string;
      text: string;
      metadata?: Record<string, unknown>;
    }): Promise<{ success: boolean; error?: string }> {
      const account = activeAccounts.get(opts.accountId);
      if (!account) {
        return { success: false, error: `Account ${opts.accountId} is not active` };
      }

      try {
        const res = await fetch(`${account.campfireUrl}/api/openclaw/inbound`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            senderId: "openclaw-agent",
            sessionId: opts.recipientId,
            text: opts.text,
            metadata: opts.metadata,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "unknown error");
          return { success: false, error: `HTTP ${res.status}: ${body}` };
        }

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },

  gateway: {
    /**
     * Start an account: register with Campfire for inbound messages.
     * When a user sends a message in Campfire, Campfire will POST
     * to the OpenClaw webhook to route it to the agent.
     */
    async startAccount(opts: {
      accountId: string;
      config: Record<string, string>;
      onMessage: (msg: InboundMessage) => void;
    }): Promise<void> {
      const campfireUrl = opts.config.campfireUrl || "http://localhost:3456";

      activeAccounts.set(opts.accountId, {
        accountId: opts.accountId,
        campfireUrl,
        onMessage: opts.onMessage,
      });

      console.log(`[campfire-channel] Started account ${opts.accountId} → ${campfireUrl}`);
    },

    /**
     * Stop an account: unregister from Campfire.
     */
    async stopAccount(accountId: string): Promise<void> {
      activeAccounts.delete(accountId);
      console.log(`[campfire-channel] Stopped account ${accountId}`);
    },
  },
};

/**
 * Handle an inbound webhook from Campfire.
 * Called when a user sends a message in the Campfire UI
 * and it needs to be routed to the OpenClaw agent.
 */
export function handleCampfireWebhook(body: {
  accountId: string;
  senderId: string;
  text: string;
  metadata?: Record<string, unknown>;
}): { ok: boolean; error?: string } {
  const account = activeAccounts.get(body.accountId);
  if (!account) {
    return { ok: false, error: `Account ${body.accountId} not found` };
  }

  account.onMessage({
    senderId: body.senderId,
    text: body.text,
    metadata: body.metadata,
  });

  return { ok: true };
}

/** Get the list of active account IDs (for status checking). */
export function getActiveAccounts(): string[] {
  return Array.from(activeAccounts.keys());
}
