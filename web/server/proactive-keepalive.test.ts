import { describe, expect, it, vi } from "vitest";
import { ProactiveKeepalive } from "./proactive-keepalive.js";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";

function createLauncher() {
  let exitCb: ((sessionId: string, exitCode: number | null) => void) | null = null;
  const session: SdkSessionInfo = {
    sessionId: "s1",
    state: "connected",
    cwd: "/repo",
    createdAt: 1,
  };
  const launcher = {
    onSessionExited: vi.fn((cb) => {
      exitCb = cb;
    }),
    getSession: vi.fn(() => session),
    relaunch: vi.fn(async () => true),
  } as unknown as CliLauncher;

  return {
    launcher,
    emitExit: (exitCode: number | null) => exitCb?.("s1", exitCode),
  };
}

describe("ProactiveKeepalive", () => {
  it("relaunches crashed sessions after the backoff delay", async () => {
    vi.useFakeTimers();
    const { launcher, emitExit } = createLauncher();
    new ProactiveKeepalive(launcher);

    // Non-zero exits are treated as crashes and should be relaunched once the
    // backoff timer expires.
    emitExit(1);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
    vi.useRealTimers();
  });

  it("does not schedule relaunches after destroy", async () => {
    vi.useFakeTimers();
    const { launcher, emitExit } = createLauncher();
    const keepalive = new ProactiveKeepalive(launcher);

    // During service shutdown, child processes can exit after SIGTERM. Those
    // exits must not schedule fresh agents while systemd is stopping the unit.
    keepalive.destroy();
    emitExit(143);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(launcher.relaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancels pending relaunch timers during destroy", async () => {
    vi.useFakeTimers();
    const { launcher, emitExit } = createLauncher();
    const keepalive = new ProactiveKeepalive(launcher);

    // If shutdown happens after a crash was scheduled but before the timer
    // fires, the pending timer should be cleared and no relaunch should happen.
    emitExit(1);
    keepalive.destroy();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(launcher.relaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
