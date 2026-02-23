import type { BackendType } from "./session-types.js";

export type WebhookEvent =
  | "session.created"
  | "session.completed"
  | "session.failed"
  | "permission.requested"
  | "permission.resolved"
  | "turn.completed"
  | "cost.threshold";

export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = [
  "session.created",
  "session.completed",
  "session.failed",
  "permission.requested",
  "permission.resolved",
  "turn.completed",
  "cost.threshold",
];

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  enabled: boolean;
  /** Payload format: "generic" (default), "slack", or "openclaw" (POST to /hooks/agent). */
  format?: WebhookFormat;
  sessionFilter?: {
    backendType?: BackendType;
    cwd?: string;
  };
  createdAt: number;
  updatedAt: number;
  totalDeliveries: number;
  failedDeliveries: number;
  lastDeliveryAt?: number;
  lastDeliverySuccess?: boolean;
}

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  sessionId: string;
  data: Record<string, unknown>;
}

/** Payload format for outbound webhook delivery. */
export type WebhookFormat = "generic" | "slack" | "openclaw";

export const ALL_WEBHOOK_FORMATS: WebhookFormat[] = ["generic", "slack", "openclaw"];

export interface WebhookCreateInput {
  name: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  enabled?: boolean;
  format?: WebhookFormat;
  sessionFilter?: {
    backendType?: BackendType;
    cwd?: string;
  };
}
