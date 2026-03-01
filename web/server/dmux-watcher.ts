/**
 * DmuxWatcher — Server-side poll + WebSocket push for dmux status.
 *
 * Replaces client-side 3-second REST polling with server-side polling
 * that pushes diffs over WebSocket. Follows the PRPoller pattern.
 */

import { dmuxManager } from "./dmux-manager.js";
import type { DmuxSessionStatus } from "./dmux-manager.js";
import { DmuxPaneStreamer, type PaneStreamSubscriber } from "./dmux-pane-streamer.js";

const POLL_INTERVAL_MS = 2000;

export interface DmuxWatchClient extends PaneStreamSubscriber {
  cwd: string;
  send(data: string): void;
}

// ─── WS Protocol Types ────────────────────────────────────────────────────

export interface DmuxSubscribeMsg {
  type: "subscribe";
  cwd: string;
}

export interface DmuxFocusPaneMsg {
  type: "focus_pane";
  tmuxTarget: string;
}

export interface DmuxSendKeysMsg {
  type: "send_keys";
  tmuxTarget: string;
  keys: string;
  enter?: boolean;
}

export interface DmuxStreamPaneMsg {
  type: "stream_pane";
  tmuxTarget: string;
}

export interface DmuxStopStreamPaneMsg {
  type: "stop_stream_pane";
  tmuxTarget: string;
}

export type DmuxBrowserMessage =
  | DmuxSubscribeMsg
  | DmuxFocusPaneMsg
  | DmuxSendKeysMsg
  | DmuxStreamPaneMsg
  | DmuxStopStreamPaneMsg;

export class DmuxWatcher {
  private clients = new Set<DmuxWatchClient>();
  private lastStatus = new Map<string, string>(); // JSON-stringified status keyed by cwd
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  readonly paneStreamer = new DmuxPaneStreamer();

  /**
   * Register a browser WebSocket client and start polling if needed.
   * Sends an immediate full status snapshot.
   */
  addClient(client: DmuxWatchClient): void {
    this.clients.add(client);

    // Send immediate status snapshot
    const status = dmuxManager.getStatus(client.cwd);
    this.sendToClient(client, { type: "dmux_status", status });
    this.lastStatus.set(client.cwd, JSON.stringify(status));

    // Start poll timer if this is the first client
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  /**
   * Unregister a client. Stops polling if no clients remain.
   */
  removeClient(client: DmuxWatchClient): void {
    this.clients.delete(client);
    this.paneStreamer.removeSubscriber(client);
    this.cleanupStatusForCwd(client.cwd);

    if (this.clients.size === 0) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      // Clean up unused cwd entries
      this.lastStatus.clear();
    }
  }

  /**
   * Handle an incoming message from a browser client.
   */
  handleMessage(client: DmuxWatchClient, msg: DmuxBrowserMessage): void {
    switch (msg.type) {
      case "subscribe": {
        const previousCwd = client.cwd;
        client.cwd = msg.cwd;
        // Send immediate snapshot for new cwd
        const status = dmuxManager.getStatus(msg.cwd);
        this.sendToClient(client, { type: "dmux_status", status });
        this.lastStatus.set(msg.cwd, JSON.stringify(status));
        if (previousCwd !== msg.cwd) {
          this.cleanupStatusForCwd(previousCwd);
        }
        break;
      }

      case "focus_pane": {
        dmuxManager.focusPane(msg.tmuxTarget);
        break;
      }

      case "send_keys": {
        dmuxManager.sendToPane(msg.tmuxTarget, msg.keys, msg.enter);
        break;
      }

      case "stream_pane": {
        this.paneStreamer.startStream(msg.tmuxTarget, client);
        break;
      }

      case "stop_stream_pane": {
        this.paneStreamer.stopStream(msg.tmuxTarget, client);
        break;
      }
    }
  }

  private cleanupStatusForCwd(cwd: string): void {
    for (const client of this.clients) {
      if (client.cwd === cwd) return;
    }
    this.lastStatus.delete(cwd);
  }

  /** Clean up resources. */
  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.paneStreamer.destroy();
    this.clients.clear();
    this.lastStatus.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private poll(): void {
    // Group clients by cwd to avoid duplicate getStatus calls
    const cwdClients = new Map<string, DmuxWatchClient[]>();
    for (const client of this.clients) {
      const list = cwdClients.get(client.cwd) || [];
      list.push(client);
      cwdClients.set(client.cwd, list);
    }

    for (const [cwd, clients] of cwdClients) {
      const status = dmuxManager.getStatus(cwd);
      const serialized = JSON.stringify(status);

      // Only broadcast if status changed
      if (this.lastStatus.get(cwd) === serialized) continue;
      this.lastStatus.set(cwd, serialized);

      const message = JSON.stringify({ type: "dmux_status", status });
      for (const client of clients) {
        try {
          client.send(message);
        } catch {
          // Client may be disconnected
        }
      }
    }
  }

  private sendToClient(client: DmuxWatchClient, data: { type: string; status: DmuxSessionStatus }): void {
    try {
      client.send(JSON.stringify(data));
    } catch {
      // Client may be disconnected
    }
  }
}
