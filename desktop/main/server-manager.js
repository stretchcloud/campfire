// Sidecar lifecycle: locate the bundled Bun runtime + backend, spawn the
// Campfire server, wait for readiness, and tear it down on quit.
//
// Reuse-first: if a Campfire server already answers on the default port
// (e.g. the user runs `the-campfire` as a launchd service), the app attaches
// to it instead of spawning a second server against the same ~/.campfire
// state directory.
"use strict";

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, createWriteStream } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");
const { findFreePort, probeCampfire, waitForCampfire } = require("./net-utils.js");

const DEFAULT_PORT = 4567;

class ServerManager {
  /**
   * @param {{ resourcesPath: string, isPackaged: boolean, repoRoot: string }} opts
   *   resourcesPath — Electron's process.resourcesPath (packaged builds)
   *   repoRoot — repository root (dev runs; vendor/ staging lives under desktop/)
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.port = null;
    this.external = false; // true when attached to an already-running server
    this.onUnexpectedExit = null; // set by the app; called with the exit code
    this.stopping = false;
  }

  /** Resolve the staged backend + bun runtime for this build flavor. */
  paths() {
    const base = this.opts.isPackaged
      ? this.opts.resourcesPath
      : join(this.opts.repoRoot, "desktop", "vendor");
    return {
      backendDir: join(base, "backend"),
      bunBin: join(base, "bun", "bun"),
    };
  }

  origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /**
   * Ensure a Campfire server is available. Returns { port, external }.
   * Throws with a user-presentable message on failure.
   */
  async ensure() {
    // Explicit override for development / debugging.
    const overrideUrl = process.env.CAMPFIRE_DESKTOP_URL;
    if (overrideUrl) {
      const url = new URL(overrideUrl);
      this.port = Number(url.port) || 80;
      this.external = true;
      return { port: this.port, external: true };
    }

    // Attach to an existing local Campfire (service install, `bunx the-campfire`, dev server).
    if (await probeCampfire(DEFAULT_PORT)) {
      this.port = DEFAULT_PORT;
      this.external = true;
      return { port: DEFAULT_PORT, external: true };
    }

    const { backendDir, bunBin } = this.paths();
    if (!existsSync(bunBin) || !existsSync(join(backendDir, "server", "index.ts"))) {
      throw new Error(
        `Bundled server not found.\nExpected runtime at:\n  ${bunBin}\n  ${backendDir}\n` +
        (this.opts.isPackaged ? "The app bundle appears damaged — please re-download." : "Run `make desktop-stage` first."),
      );
    }

    this.port = await findFreePort(DEFAULT_PORT);

    // Sidecar logs go next to the existing service logs so `the-campfire logs`
    // habits still work for debugging the desktop flavor.
    const logDir = join(os.homedir(), ".campfire", "logs");
    mkdirSync(logDir, { recursive: true });
    const logStream = createWriteStream(join(logDir, "desktop-server.log"), { flags: "a" });
    logStream.write(`\n──── Campfire desktop sidecar starting (port ${this.port}) ${new Date().toISOString()} ────\n`);

    this.child = spawn(bunBin, [join(backendDir, "server", "index.ts")], {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(this.port),
        __CAMPFIRE_PACKAGE_ROOT: backendDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.pipe(logStream, { end: false });
    this.child.stderr.pipe(logStream, { end: false });
    logStream.write(`[desktop] spawned bun pid=${this.child.pid}\n`);

    this.child.on("error", (err) => {
      // spawn() failures (EPERM, ENOENT, …) surface here, not on "exit".
      logStream.write(`[desktop] sidecar spawn error: ${err.message}\n`);
      this.child = null;
    });
    this.child.on("exit", (code, signal) => {
      logStream.write(`[desktop] sidecar exited code=${code} signal=${signal}\n`);
      const wasStopping = this.stopping;
      this.child = null;
      if (!wasStopping && this.onUnexpectedExit) this.onUnexpectedExit(code);
    });

    const ready = await waitForCampfire(this.port, 30000, () => this.child !== null);
    if (!ready) {
      this.stop();
      throw new Error(
        "The Campfire server did not start.\nSee ~/.campfire/logs/desktop-server.log for details.",
      );
    }
    return { port: this.port, external: false };
  }

  /** Stop the sidecar (no-op when attached to an external server). */
  stop() {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    child.kill("SIGTERM");
    // Escalate if the server ignores SIGTERM (it normally exits immediately).
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 3000);
    killTimer.unref();
  }
}

module.exports = { ServerManager, DEFAULT_PORT };
