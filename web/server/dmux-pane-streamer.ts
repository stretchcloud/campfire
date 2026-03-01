/**
 * DmuxPaneStreamer — Per-pane output capture via tmux pipe-pane.
 *
 * Uses `tmux pipe-pane` to route pane output to temp log files, then
 * `tail -f` to stream incrementally to WebSocket subscribers.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBinary } from "./path-resolver.js";
import type { DmuxPaneRecorder } from "./dmux-recorder.js";

export interface PaneStreamSubscriber {
  send(data: string): void;
}

interface PaneStream {
  tmuxTarget: string;
  logFile: string;
  tailProcess: ChildProcess | null;
  subscribers: Set<PaneStreamSubscriber>;
}

export class DmuxPaneStreamer {
  private streams = new Map<string, PaneStream>();
  private logDir: string;
  private recorder: DmuxPaneRecorder | null = null;

  constructor() {
    this.logDir = mkdtempSync(join(tmpdir(), "dmux-pane-logs-"));
  }

  /** Attach a recorder that receives all pane output. */
  setRecorder(recorder: DmuxPaneRecorder | null): void {
    this.recorder = recorder;
  }

  getRecorder(): DmuxPaneRecorder | null {
    return this.recorder;
  }

  /**
   * Start streaming output from a tmux pane to a subscriber.
   * If the stream already exists, adds the subscriber and sends history.
   */
  startStream(tmuxTarget: string, subscriber: PaneStreamSubscriber): void {
    const existing = this.streams.get(tmuxTarget);
    if (existing) {
      existing.subscribers.add(subscriber);
      // Send history (last 200 lines of log file)
      this.sendHistory(existing, subscriber);
      return;
    }

    const tmux = resolveBinary("tmux");
    if (!tmux) {
      console.warn("[dmux-pane-streamer] tmux not found, cannot start stream");
      return;
    }

    const logFile = join(this.logDir, `${tmuxTarget.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`);
    writeFileSync(logFile, "");

    const stream: PaneStream = {
      tmuxTarget,
      logFile,
      tailProcess: null,
      subscribers: new Set([subscriber]),
    };

    try {
      // Capture current pane content as initial history
      const currentContent = execSync(
        `${tmux} capture-pane -t ${this.shellEscape(tmuxTarget)} -p`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (currentContent.trim()) {
        this.sendOutput(stream, currentContent, { historyOnly: subscriber });
      }

      // Start pipe-pane to capture future output
      execSync(
        `${tmux} pipe-pane -t ${this.shellEscape(tmuxTarget)} "cat >> ${this.shellEscape(logFile)}"`,
        { timeout: 5000 },
      );

      // Start tail -f to stream new output
      const tail = spawn("tail", ["-f", logFile], { stdio: ["pipe", "pipe", "pipe"] });
      stream.tailProcess = tail;

      tail.stdout.on("data", (chunk: Buffer) => {
        this.sendOutput(stream, chunk.toString());
      });

      tail.on("error", (err) => {
        console.warn(`[dmux-pane-streamer] tail error for ${tmuxTarget}:`, err.message);
      });

      this.streams.set(tmuxTarget, stream);
    } catch (err) {
      console.warn(`[dmux-pane-streamer] Failed to start stream for ${tmuxTarget}:`, err);
      if (stream.tailProcess) {
        stream.tailProcess.kill();
      }
      try {
        unlinkSync(logFile);
      } catch {
        // File may not exist yet
      }
    }
  }

  /**
   * Stop streaming a pane for a specific subscriber.
   * If no subscribers remain, tears down the stream entirely.
   */
  stopStream(tmuxTarget: string, subscriber: PaneStreamSubscriber): void {
    const stream = this.streams.get(tmuxTarget);
    if (!stream) return;

    stream.subscribers.delete(subscriber);

    if (stream.subscribers.size === 0) {
      this.teardownStream(tmuxTarget, stream);
    }
  }

  /**
   * Remove a subscriber from all active streams.
   * Called when a WebSocket disconnects.
   */
  removeSubscriber(subscriber: PaneStreamSubscriber): void {
    for (const [target, stream] of this.streams) {
      stream.subscribers.delete(subscriber);
      if (stream.subscribers.size === 0) {
        this.teardownStream(target, stream);
      }
    }
  }

  /** Stop all streams and clean up. */
  destroy(): void {
    for (const [target, stream] of this.streams) {
      this.teardownStream(target, stream);
    }
    this.streams.clear();
  }

  /** Return currently active stream targets. */
  getActiveTargets(): string[] {
    return Array.from(this.streams.keys());
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private teardownStream(tmuxTarget: string, stream: PaneStream): void {
    // Stop pipe-pane
    const tmux = resolveBinary("tmux");
    if (tmux) {
      try {
        execSync(`${tmux} pipe-pane -t ${this.shellEscape(tmuxTarget)}`, { timeout: 5000 });
      } catch {
        // Pane may already be gone
      }
    }

    // Kill tail process
    if (stream.tailProcess) {
      stream.tailProcess.kill();
      stream.tailProcess = null;
    }

    // Delete log file
    try {
      unlinkSync(stream.logFile);
    } catch {
      // File may already be gone
    }

    this.streams.delete(tmuxTarget);
  }

  private sendHistory(stream: PaneStream, subscriber: PaneStreamSubscriber): void {
    try {
      const content = readFileSync(stream.logFile, "utf-8");
      const lines = content.split("\n");
      const last200 = lines.slice(-200).join("\n");
      if (last200.trim()) {
        this.sendOutput(stream, last200, { historyOnly: subscriber, record: false });
      }
    } catch {
      // Log file may not exist yet
    }
  }

  private sendOutput(
    stream: PaneStream,
    data: string,
    options?: { historyOnly?: PaneStreamSubscriber; record?: boolean },
  ): void {
    const msg = JSON.stringify({
      type: "dmux_pane_output",
      tmuxTarget: stream.tmuxTarget,
      data,
      ...(options?.historyOnly ? { isHistory: true } : {}),
    });

    if (options?.historyOnly) {
      try {
        options.historyOnly.send(msg);
      } catch {
        // Subscriber disconnected
      }
    } else {
      for (const sub of stream.subscribers) {
        try {
          sub.send(msg);
        } catch {
          // Subscriber disconnected
        }
      }
    }

    if (options?.record !== false && this.recorder) {
      this.recorder.record(stream.tmuxTarget, data);
    }
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
