/**
 * Proactive Keepalive — auto-relaunches crashed CLI sessions.
 *
 * When a CLI process exits unexpectedly, this module schedules a relaunch
 * with exponential backoff. Ensures autonomous sessions (agents, cron jobs)
 * stay alive even without a browser connected.
 *
 * Excludes: intentional kills, archived sessions, clean exits (code 0).
 *
 * Stability window: the attempt counter is only reset after the CLI has been
 * connected for at least STABILITY_WINDOW_MS. This prevents infinite
 * relaunch loops when a session connects briefly then crashes immediately.
 */

import type { CliLauncher } from "./cli-launcher.js";

const BASE_DELAY_MS = Number(process.env.CAMPFIRE_KEEPALIVE_DELAY_MS) || 3_000;
const MAX_ATTEMPTS = Number(process.env.CAMPFIRE_KEEPALIVE_MAX_ATTEMPTS) || 3;
const STABILITY_WINDOW_MS = 30_000;

export class ProactiveKeepalive {
  private readonly launcher: CliLauncher;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly intentionalKills = new Set<string>();
  /** Tracks when each session was last relaunched by keepalive. */
  private readonly launchTimes = new Map<string, number>();
  private destroyed = false;

  constructor(launcher: CliLauncher) {
    this.launcher = launcher;

    // Listen for CLI process exits
    launcher.onSessionExited((sessionId, exitCode) => {
      this.handleExit(sessionId, exitCode);
    });
  }

  /** Mark a session as intentionally killed (don't auto-relaunch). */
  markIntentionalKill(sessionId: string): void {
    this.intentionalKills.add(sessionId);
    this.cancelTimer(sessionId);
  }

  /** Cancel a pending relaunch timer. */
  cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /** Stop all timers (graceful shutdown). */
  destroy(): void {
    this.destroyed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.attempts.clear();
    this.launchTimes.clear();
  }

  private handleExit(sessionId: string, exitCode: number | null): void {
    if (this.destroyed) return;

    // Skip intentional kills
    if (this.intentionalKills.has(sessionId)) {
      this.intentionalKills.delete(sessionId);
      return;
    }

    // Skip clean exits (user typed /exit or session completed normally)
    if (exitCode === 0) return;

    // Skip archived sessions
    const info = this.launcher.getSession(sessionId);
    if (!info) return;
    if (info.archived) return;

    // Only reset the attempt counter if the CLI was stable for the
    // full stability window. This prevents infinite loops when a
    // session connects briefly then immediately crashes (e.g. missing
    // --resume session ID or empty prompt).
    const launchTime = this.launchTimes.get(sessionId);
    if (launchTime && Date.now() - launchTime >= STABILITY_WINDOW_MS) {
      this.attempts.delete(sessionId);
    }

    // Check attempt count
    const attempt = (this.attempts.get(sessionId) || 0) + 1;
    if (attempt > MAX_ATTEMPTS) {
      console.warn(`[keepalive] Session ${sessionId} exceeded max relaunch attempts (${MAX_ATTEMPTS}), giving up`);
      this.attempts.delete(sessionId);
      this.launchTimes.delete(sessionId);
      return;
    }
    this.attempts.set(sessionId, attempt);

    // Exponential backoff: 3s → 6s → 12s
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.log(`[keepalive] Session ${sessionId} exited (code=${exitCode}), scheduling relaunch #${attempt} in ${delay}ms`);

    const timer = setTimeout(async () => {
      this.timers.delete(sessionId);
      if (this.destroyed) return;
      try {
        const success = await this.launcher.relaunch(sessionId);
        if (success) {
          console.log(`[keepalive] Session ${sessionId} relaunched successfully (attempt #${attempt})`);
          this.launchTimes.set(sessionId, Date.now());
        }
      } catch (err) {
        console.error(`[keepalive] Failed to relaunch session ${sessionId}:`, err);
      }
    }, delay);

    this.timers.set(sessionId, timer);
  }
}
