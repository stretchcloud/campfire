import { createHmac } from "node:crypto";
import * as webhookStore from "./webhook-store.js";
import type { WebhookConfig, WebhookEvent, WebhookPayload } from "./webhook-types.js";

export class WebhookManager {
  // Cost thresholds to emit cost.threshold events (in USD)
  private costThresholds = [0.50, 1.00, 2.00, 5.00, 10.00];
  // Track which thresholds have been crossed per session to avoid re-emitting
  private crossedThresholds = new Map<string, Set<number>>();

  emit(event: WebhookEvent, sessionId: string, data: Record<string, unknown>): void {
    // Load all webhooks, find matching ones, deliver asynchronously (fire-and-forget)
    const webhooks = webhookStore.listWebhooks();
    for (const webhook of webhooks) {
      if (!webhook.enabled) continue;
      if (!webhook.events.includes(event)) continue;
      if (!this.matchesFilter(webhook, sessionId, data)) continue;

      const payload: WebhookPayload = {
        event,
        timestamp: Date.now(),
        sessionId,
        data,
      };

      // Fire and forget — don't block the caller
      this.deliver(webhook, payload).catch((err) => {
        console.error(`[webhook-manager] Delivery failed for webhook ${webhook.id}:`, err);
      });
    }
  }

  /** Check cost thresholds and emit cost.threshold if crossed */
  checkCostThreshold(sessionId: string, totalCostUsd: number): void {
    if (!this.crossedThresholds.has(sessionId)) {
      this.crossedThresholds.set(sessionId, new Set());
    }
    const crossed = this.crossedThresholds.get(sessionId)!;
    for (const threshold of this.costThresholds) {
      if (totalCostUsd >= threshold && !crossed.has(threshold)) {
        crossed.add(threshold);
        this.emit("cost.threshold", sessionId, {
          threshold,
          totalCostUsd,
        });
      }
    }
  }

  /** Clean up threshold tracking when session ends */
  clearSession(sessionId: string): void {
    this.crossedThresholds.delete(sessionId);
  }

  private async deliver(webhook: WebhookConfig, payload: WebhookPayload, attempt = 1): Promise<void> {
    const format = webhook.format || "generic";
    let body: string;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Campfire-Webhook/1.0",
      "X-Campfire-Event": payload.event,
      "X-Campfire-Delivery": `${webhook.id}-${Date.now()}`,
    };

    if (format === "slack") {
      body = JSON.stringify(
        WebhookManager.formatSlackPayload(payload.event, payload.sessionId, payload.data),
      );
    } else if (format === "openclaw") {
      body = JSON.stringify(
        WebhookManager.formatOpenClawPayload(payload.event, payload.sessionId, payload.data),
      );
      // OpenClaw uses Bearer token auth — use the webhook secret as the token
      if (webhook.secret) {
        headers["Authorization"] = `Bearer ${webhook.secret}`;
      }
    } else {
      body = JSON.stringify(payload);
    }

    // HMAC-SHA256 signing if secret is configured (not used for openclaw format which uses Bearer)
    if (webhook.secret && format !== "openclaw") {
      headers["X-Campfire-Signature"] = this.sign(body, webhook.secret);
    }

    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      const success = res.ok;
      webhookStore.updateWebhook(webhook.id, {
        totalDeliveries: webhook.totalDeliveries + 1,
        failedDeliveries: success ? webhook.failedDeliveries : webhook.failedDeliveries + 1,
        lastDeliveryAt: Date.now(),
        lastDeliverySuccess: success,
      });

      if (!success && attempt < 3) {
        // Retry with exponential backoff: 1s, 5s, 15s
        const delays = [1000, 5000, 15000];
        const delay = delays[attempt - 1] || 15000;
        console.log(`[webhook-manager] Webhook ${webhook.id} returned ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, delay));
        await this.deliver(webhook, payload, attempt + 1);
      }
    } catch (err) {
      webhookStore.updateWebhook(webhook.id, {
        totalDeliveries: webhook.totalDeliveries + 1,
        failedDeliveries: webhook.failedDeliveries + 1,
        lastDeliveryAt: Date.now(),
        lastDeliverySuccess: false,
      });

      if (attempt < 3) {
        const delays = [1000, 5000, 15000];
        const delay = delays[attempt - 1] || 15000;
        console.log(`[webhook-manager] Webhook ${webhook.id} delivery error, retrying in ${delay}ms (attempt ${attempt + 1}/3):`, err);
        await new Promise((r) => setTimeout(r, delay));
        await this.deliver(webhook, payload, attempt + 1);
      }
    }
  }

  private sign(payload: string, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  }

  private matchesFilter(
    webhook: WebhookConfig,
    sessionId: string,
    data: Record<string, unknown>,
  ): boolean {
    if (!webhook.sessionFilter) return true;

    if (webhook.sessionFilter.backendType && data.backendType) {
      if (webhook.sessionFilter.backendType !== data.backendType) return false;
    }
    if (webhook.sessionFilter.cwd && data.cwd) {
      if (!(data.cwd as string).startsWith(webhook.sessionFilter.cwd)) return false;
    }

    return true;
  }

  /**
   * Format a webhook payload as a Slack incoming webhook message.
   * Can be used by webhook consumers to post to Slack.
   */
  static formatSlackPayload(
    event: WebhookEvent,
    sessionId: string,
    data: Record<string, unknown>,
  ): { text: string; blocks: Array<Record<string, unknown>> } {
    const eventLabels: Record<WebhookEvent, string> = {
      "session.created": "Session Started",
      "session.completed": "Session Completed",
      "session.failed": "Session Failed",
      "permission.requested": "Permission Requested",
      "permission.resolved": "Permission Resolved",
      "turn.completed": "Turn Completed",
      "cost.threshold": "Cost Threshold Reached",
    };

    const label = eventLabels[event] || event;
    const cost = typeof data.totalCostUsd === "number" ? `$${data.totalCostUsd.toFixed(4)}` : "";
    const model = (data.model as string) || "";

    return {
      text: `Campfire: ${label} — session ${sessionId.slice(0, 8)}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${label}*` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Session:* ${sessionId.slice(0, 8)}` },
            ...(model ? [{ type: "mrkdwn", text: `*Model:* ${model}` }] : []),
            ...(cost ? [{ type: "mrkdwn", text: `*Cost:* ${cost}` }] : []),
          ],
        },
      ],
    };
  }

  /**
   * Format a webhook payload as an OpenClaw /hooks/agent request.
   * This allows Campfire events to trigger OpenClaw agent runs.
   */
  static formatOpenClawPayload(
    event: WebhookEvent,
    sessionId: string,
    data: Record<string, unknown>,
  ): {
    message: string;
    name: string;
    wakeMode: string;
    deliver: boolean;
  } {
    const eventLabels: Record<WebhookEvent, string> = {
      "session.created": "Session Started",
      "session.completed": "Session Completed",
      "session.failed": "Session Failed",
      "permission.requested": "Permission Requested",
      "permission.resolved": "Permission Resolved",
      "turn.completed": "Turn Completed",
      "cost.threshold": "Cost Threshold Reached",
    };

    const label = eventLabels[event] || event;
    const cost = typeof data.totalCostUsd === "number" ? ` | Cost: $${data.totalCostUsd.toFixed(4)}` : "";
    const model = data.model ? ` | Model: ${data.model}` : "";
    const backend = data.backendType ? ` | Backend: ${data.backendType}` : "";
    const turns = typeof data.numTurns === "number" ? ` | Turns: ${data.numTurns}` : "";

    return {
      message: `[Campfire] ${label} — session ${sessionId.slice(0, 8)}${backend}${model}${cost}${turns}`,
      name: "Campfire",
      wakeMode: "now",
      deliver: true,
    };
  }
}
