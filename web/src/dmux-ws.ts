/**
 * Browser-side WebSocket client for dmux real-time status + pane streaming.
 *
 * Module-level singleton following the terminal-ws.ts pattern.
 */

import type { DmuxSessionStatus } from "./api.js";

type StatusCallback = (status: DmuxSessionStatus) => void;
type PaneOutputCallback = (tmuxTarget: string, data: string, isHistory?: boolean) => void;
type ErrorCallback = (error: string) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentCwd: string | null = null;
let onStatus: StatusCallback | null = null;
let onPaneOutput: PaneOutputCallback | null = null;
let onError: ErrorCallback | null = null;

const RECONNECT_DELAY = 3000;

function getWsUrl(cwd: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = location.host;
  return `${proto}//${host}/ws/dmux?cwd=${encodeURIComponent(cwd)}`;
}

/**
 * Connect to the dmux WebSocket. Replaces any existing connection.
 */
export function connectDmux(
  cwd: string,
  statusCb: StatusCallback,
  paneOutputCb?: PaneOutputCallback,
  errorCb?: ErrorCallback,
): void {
  disconnectDmux();

  currentCwd = cwd;
  onStatus = statusCb;
  onPaneOutput = paneOutputCb ?? null;
  onError = errorCb ?? null;

  openSocket(cwd);
}

/**
 * Send a message to the dmux WebSocket.
 */
export function sendDmuxMessage(msg: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Focus a tmux pane via the WebSocket. */
export function sendDmuxFocusPane(tmuxTarget: string): void {
  sendDmuxMessage({ type: "focus_pane", tmuxTarget });
}

/** Send keys to a tmux pane via the WebSocket. */
export function sendDmuxKeys(tmuxTarget: string, keys: string, enter?: boolean): void {
  sendDmuxMessage({ type: "send_keys", tmuxTarget, keys, enter });
}

/** Start streaming a pane's output. */
export function sendDmuxStreamPane(tmuxTarget: string): void {
  sendDmuxMessage({ type: "stream_pane", tmuxTarget });
}

/** Stop streaming a pane's output. */
export function sendDmuxStopStreamPane(tmuxTarget: string): void {
  sendDmuxMessage({ type: "stop_stream_pane", tmuxTarget });
}

/**
 * Disconnect from the dmux WebSocket and stop reconnecting.
 */
export function disconnectDmux(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null; // Prevent reconnect
    ws.close();
    ws = null;
  }
  currentCwd = null;
  onStatus = null;
  onPaneOutput = null;
  onError = null;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function openSocket(cwd: string): void {
  const socket = new WebSocket(getWsUrl(cwd));
  ws = socket;

  socket.onopen = () => {
    // Connection established, server sends initial status automatically
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "dmux_status":
          onStatus?.(msg.status);
          break;
        case "dmux_pane_output":
          onPaneOutput?.(msg.tmuxTarget, msg.data, msg.isHistory);
          break;
        default:
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  };

  socket.onerror = () => {
    onError?.("WebSocket error");
  };

  socket.onclose = () => {
    ws = null;
    // Auto-reconnect if we still have a cwd (i.e. not explicitly disconnected)
    if (currentCwd) {
      reconnectTimer = setTimeout(() => {
        if (currentCwd) openSocket(currentCwd);
      }, RECONNECT_DELAY);
    }
  };
}
