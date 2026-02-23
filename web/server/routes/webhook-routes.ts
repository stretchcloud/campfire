import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as webhookStore from "../webhook-store.js";
import type { WebhookCreateInput } from "../webhook-types.js";

export function registerWebhookRoutes(api: Hono, deps: RouteDeps): void {
  const { launcher, wsBridge, webhookManager } = deps;

  api.get("/webhooks", (c) => {
    return c.json(webhookStore.listWebhooks());
  });

  api.get("/webhooks/:id", (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);
    return c.json(webhook);
  });

  api.post("/webhooks", async (c) => {
    const data = await c.req.json() as WebhookCreateInput;
    try {
      const webhook = webhookStore.createWebhook(data);
      return c.json(webhook, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.put("/webhooks/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json();
    try {
      const webhook = webhookStore.updateWebhook(id, updates);
      if (!webhook) return c.json({ error: "Webhook not found" }, 404);
      return c.json(webhook);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.delete("/webhooks/:id", (c) => {
    const id = c.req.param("id");
    const deleted = webhookStore.deleteWebhook(id);
    if (!deleted) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/webhooks/:id/toggle", (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);
    const updated = webhookStore.updateWebhook(id, { enabled: !webhook.enabled });
    return c.json(updated);
  });

  api.post("/webhooks/:id/test", async (c) => {
    const id = c.req.param("id");
    const webhook = webhookStore.getWebhook(id);
    if (!webhook) return c.json({ error: "Webhook not found" }, 404);
    if (webhookManager) {
      webhookManager.emit("session.completed", "test-session", {
        backendType: "claude",
        model: "claude-sonnet-4-5-20250929",
        totalCostUsd: 0.05,
        numTurns: 3,
        isError: false,
        test: true,
      });
    }
    return c.json({ ok: true });
  });

  // ─── OpenClaw Inbound Webhook ───────────────────────────────────
  api.post("/webhooks/openclaw", async (c) => {
    const expectedToken = process.env.CAMPFIRE_OPENCLAW_TOKEN;
    if (expectedToken) {
      const authHeader = c.req.header("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== expectedToken) {
        return c.json({ ok: false, error: "Unauthorized" }, 401);
      }
    }
    try {
      const body = await c.req.json() as {
        message?: string;
        name?: string;
        model?: string;
        cwd?: string;
      };
      if (!body.message || !body.message.trim()) {
        return c.json({ ok: false, error: "message is required" }, 400);
      }
      const cwd = body.cwd || process.env.HOME || "/";
      const session = launcher.launch({
        model: body.model || "default",
        permissionMode: "bypassPermissions",
        cwd,
        backendType: "openclaw",
        env: {},
      });
      setTimeout(() => {
        wsBridge.injectUserMessage(session.sessionId, body.message!.trim());
      }, 2000);
      console.log(`[routes] OpenClaw inbound webhook → created session ${session.sessionId} with prompt: "${body.message.trim().slice(0, 80)}..."`);
      return c.json({
        ok: true,
        sessionId: session.sessionId,
        name: body.name || "OpenClaw Hook",
      }, 202);
    } catch (err) {
      console.error("[routes] OpenClaw inbound webhook error:", err);
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── OpenClaw Channel Inbound ────────────────────────────────────
  api.post("/openclaw/inbound", async (c) => {
    try {
      const body = await c.req.json() as {
        sessionId?: string;
        senderId?: string;
        text?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body.sessionId || !body.text) {
        return c.json({ ok: false, error: "sessionId and text are required" }, 400);
      }
      wsBridge.injectAgentMessage(body.sessionId, body.text, body.metadata);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
