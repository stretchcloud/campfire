/**
 * Types for the Campfire OpenClaw channel plugin.
 *
 * These are simplified versions of the OpenClaw plugin SDK types
 * that define the contract between Campfire and OpenClaw.
 */

// ─── Plugin SDK types (subset) ──────────────────────────────────────────────

export interface OpenClawPluginApi {
  registerChannel(opts: { plugin: ChannelPlugin }): void;
  registerHttpRoute(opts: { path: string; handler: HttpRouteHandler }): void;
}

export type HttpRouteHandler = (req: InboundRequest) => Promise<HttpResponse> | HttpResponse;

export interface InboundRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

// ─── Channel Plugin interface ───────────────────────────────────────────────

export interface ChannelPlugin {
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfig;
  outbound: ChannelOutbound;
  gateway: ChannelGateway;
}

export interface ChannelMeta {
  id: string;
  label: string;
  icon: string;
  docsPath: string;
  blurb: string;
}

export interface ChannelCapabilities {
  chatTypes: ("direct" | "group")[];
  media: boolean;
}

export interface ChannelConfig {
  /** Define the fields required to configure an account for this channel. */
  fields: ChannelConfigField[];
  /** Validate an account configuration. */
  validate(values: Record<string, string>): { valid: boolean; error?: string };
}

export interface ChannelConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "number";
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface ChannelOutbound {
  /** Send a text message from the agent to the channel. */
  sendText(opts: {
    accountId: string;
    recipientId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; error?: string }>;
}

export interface ChannelGateway {
  /** Start an account: register webhooks, open connections, etc. */
  startAccount(opts: {
    accountId: string;
    config: Record<string, string>;
    onMessage: (msg: InboundMessage) => void;
  }): Promise<void>;
  /** Stop an account: unregister webhooks, close connections. */
  stopAccount(accountId: string): Promise<void>;
}

export interface InboundMessage {
  senderId: string;
  text: string;
  metadata?: Record<string, unknown>;
}
