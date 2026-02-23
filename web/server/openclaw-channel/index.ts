/**
 * Campfire Channel Plugin for OpenClaw
 *
 * When installed in OpenClaw (~/.openclaw/extensions/campfire/),
 * this plugin:
 * 1. Registers a "Campfire" channel in OpenClaw's channel list
 * 2. Routes messages between OpenClaw agents and Campfire's browser UI
 * 3. Exposes an HTTP webhook route for inbound messages from Campfire
 *
 * Install: Copy this directory to ~/.openclaw/extensions/campfire/
 *   or: npm install @campfire/openclaw-channel
 */

import type { OpenClawPluginApi, HttpRouteHandler } from "./types.js";
import { campfirePlugin, handleCampfireWebhook, getActiveAccounts } from "./channel.js";

const webhookHandler: HttpRouteHandler = async (req) => {
  if (req.method !== "POST") {
    return { status: 405, body: { ok: false, error: "Method not allowed" } };
  }

  const body = req.body as {
    accountId?: string;
    senderId?: string;
    text?: string;
    metadata?: Record<string, unknown>;
  };

  if (!body.accountId || !body.text) {
    return {
      status: 400,
      body: { ok: false, error: "accountId and text are required" },
    };
  }

  const result = handleCampfireWebhook({
    accountId: body.accountId,
    senderId: body.senderId || "campfire-user",
    text: body.text,
    metadata: body.metadata,
  });

  return {
    status: result.ok ? 200 : 404,
    body: result,
  };
};

export default {
  id: "campfire",
  name: "Campfire",
  description: "Rich web UI for OpenClaw agents with cost tracking, session replay, and collaboration",

  register(api: OpenClawPluginApi) {
    // Register the Campfire channel with OpenClaw
    api.registerChannel({ plugin: campfirePlugin });

    // Register the inbound webhook route for Campfire → OpenClaw messages
    api.registerHttpRoute({
      path: "/webhook/campfire",
      handler: webhookHandler,
    });
  },
};

// Re-export for direct usage
export { campfirePlugin, handleCampfireWebhook, getActiveAccounts };
export type { OpenClawPluginApi } from "./types.js";
