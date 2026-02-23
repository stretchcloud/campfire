/**
 * AgentAdapter — the formal interface that all backend adapters must implement.
 *
 * CodexAdapter and GooseAdapter both implement this interface so that
 * WsBridge can treat all stdio-based backends uniformly.
 */

import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
} from "./session-types.js";

/** Metadata emitted by adapters during initialization. */
export interface AdapterSessionMeta {
  cliSessionId?: string;
  model?: string;
  cwd?: string;
}

/**
 * Common interface for all agent backend adapters.
 *
 * Each adapter translates between a backend-specific protocol (JSON-RPC, etc.)
 * and the Companion's BrowserIncomingMessage/BrowserOutgoingMessage types,
 * making the browser completely unaware of which backend is running.
 */
export interface AgentAdapter {
  /** Route a message from the browser to the backend. Returns false if the message was rejected. */
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;

  /** Register callback for translated messages heading to the browser. */
  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void;

  /** Register callback for session metadata updates (cliSessionId, model, cwd). */
  onSessionMeta(cb: (meta: AdapterSessionMeta) => void): void;

  /** Register callback for when the backend process disconnects. */
  onDisconnect(cb: () => void): void;

  /** Register callback for initialization failures. */
  onInitError(cb: (error: string) => void): void;

  /** Whether the adapter has completed initialization and the backend is connected. */
  isConnected(): boolean;

  /** Gracefully disconnect from the backend process. */
  disconnect(): Promise<void>;

  /** Get the backend's internal session/thread ID, or null if not yet initialized. */
  getBackendSessionId(): string | null;
}
