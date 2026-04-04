import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { DEFAULT_PORT } from "./constants.js";
import { getServicePath } from "./path-resolver.js";

// ─── Shared Constants ───────────────────────────────────────────────────────────

const CAMPFIRE_DIR = join(homedir(), ".campfire");
const LOG_DIR = join(CAMPFIRE_DIR, "logs");
const STDOUT_LOG = join(LOG_DIR, "campfire.log");
const STDERR_LOG = join(LOG_DIR, "campfire.error.log");

// ─── System binary paths (absolute to satisfy S4036 PATH safety) ───────────────

const BIN_WHICH = "/usr/bin/which";
const BIN_LAUNCHCTL = "/bin/launchctl";
const BIN_SYSTEMCTL = "/usr/bin/systemctl";
const BIN_LOGINCTL = "/usr/bin/loginctl";

// ─── macOS (launchd) Constants ──────────────────────────────────────────────────

const LABEL = "sh.campfire.app";
const OLD_LABEL = "co.thevibecompany.campfire";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const OLD_PLIST_PATH = join(PLIST_DIR, `${OLD_LABEL}.plist`);

// ─── Linux (systemd) Constants ──────────────────────────────────────────────────

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_NAME = "the-campfire.service";
const UNIT_PATH = join(SYSTEMD_DIR, UNIT_NAME);

// ─── Platform check ─────────────────────────────────────────────────────────────

function ensureSupportedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    console.error(
      "Service management is only supported on macOS (launchd) and Linux (systemd).",
    );
    process.exit(1);
  }
}

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

// ─── Plist generation (macOS) ───────────────────────────────────────────────────

interface PlistOptions {
  binPath: string;
  port?: number;
  path?: string;
}

export function generatePlist(opts: PlistOptions): string {
  const port = opts.port ?? DEFAULT_PORT;
  const home = homedir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.binPath}</string>
        <string>start</string>
        <string>--foreground</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${home}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>

    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>${port}</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${opts.path || getServicePath()}</string>
    </dict>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>`;
}

// ─── Systemd unit generation (Linux) ────────────────────────────────────────────

interface UnitOptions {
  binPath: string;
  port?: number;
  path?: string;
}

export function generateSystemdUnit(opts: UnitOptions): string {
  const port = opts.port ?? DEFAULT_PORT;
  const home = homedir();

  return `[Unit]
Description=Campfire - Web UI for Claude Code
After=network.target

[Service]
Type=simple
ExecStart=${opts.binPath} start --foreground
WorkingDirectory=${home}
Restart=always
RestartSec=5
SuccessExitStatus=42
StandardOutput=append:${STDOUT_LOG}
StandardError=append:${STDERR_LOG}
Environment=NODE_ENV=production
Environment=PORT=${port}
Environment=HOME=${home}
Environment=PATH=${opts.path || getServicePath()}

[Install]
WantedBy=default.target
`;
}

// ─── Binary resolution ──────────────────────────────────────────────────────────

function resolveBinPath(): string {
  try {
    const binPath = execFileSync(BIN_WHICH, ["the-campfire"], { encoding: "utf-8" }).trim();
    if (binPath) return binPath;
  } catch {
    // not found globally
  }

  console.error("the-campfire must be installed globally for service mode.");
  console.error("");
  console.error("  bun install -g the-campfire");
  console.error("");
  console.error("Then retry:");
  console.error("");
  console.error("  the-campfire install");
  process.exit(1);
}

// ─── macOS helpers ──────────────────────────────────────────────────────────────

function unloadLaunchdService(plistPath: string): void {
  try {
    execFileSync(BIN_LAUNCHCTL, ["unload", "-w", plistPath], { stdio: "pipe" });
  } catch {
    // Service may already be unloaded — that's fine
  }
}

function removePlist(plistPath: string): void {
  try {
    unlinkSync(plistPath);
  } catch {
    // Already gone
  }
}

function migrateLegacyInstallIfNeeded(): void {
  if (!existsSync(OLD_PLIST_PATH)) return;

  console.log("Found legacy The Vibe Campfire service. Migrating...");
  unloadLaunchdService(OLD_PLIST_PATH);
  removePlist(OLD_PLIST_PATH);
}

function getInstalledLaunchdService():
  | { label: string; plistPath: string }
  | undefined {
  if (existsSync(PLIST_PATH)) return { label: LABEL, plistPath: PLIST_PATH };
  if (existsSync(OLD_PLIST_PATH)) {
    return { label: OLD_LABEL, plistPath: OLD_PLIST_PATH };
  }
  return undefined;
}

// ─── Linux helpers ──────────────────────────────────────────────────────────────

function isSystemdUnitInstalled(): boolean {
  return existsSync(UNIT_PATH);
}

function systemctlUser(cmd: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return execFileSync(BIN_SYSTEMCTL, ["--user", ...cmd.split(" ")], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    },
  });
}

// ─── Install ────────────────────────────────────────────────────────────────────

export async function install(opts?: { port?: number }): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return installDarwin(opts);
  }
  return installLinux(opts);
}

async function installDarwin(opts?: { port?: number }): Promise<void> {
  migrateLegacyInstallIfNeeded();

  if (existsSync(PLIST_PATH)) {
    console.error("Campfire is already installed as a service.");
    console.error("Run 'the-campfire uninstall' first to reinstall.");
    process.exit(1);
  }

  const binPath = resolveBinPath();
  const port = opts?.port ?? DEFAULT_PORT;

  // Create log directory
  mkdirSync(LOG_DIR, { recursive: true });

  // Generate and write plist (capture user's shell PATH at install time)
  const path = getServicePath();
  const plist = generatePlist({ binPath, port, path });
  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plist, "utf-8");

  // Load the service
  try {
    execFileSync(BIN_LAUNCHCTL, ["load", "-w", PLIST_PATH], { stdio: "pipe" });
  } catch (err: unknown) {
    console.error("Failed to load the service with launchctl:");
    console.error(err instanceof Error ? err.message : "Unknown error");
    // Clean up the plist on failure
    try { unlinkSync(PLIST_PATH); } catch { /* ok */ }
    process.exit(1);
  }

  console.log("Campfire has been installed as a background service.");
  console.log("");
  console.log(`  URL:    http://localhost:${port}`);
  console.log(`  Logs:   ${LOG_DIR}`);
  console.log(`  Plist:  ${PLIST_PATH}`);
  console.log("");
  console.log("The service will start automatically on login.");
  console.log("Use 'the-campfire status' to check if it's running.");
}

async function installLinux(opts?: { port?: number }): Promise<void> {
  if (isSystemdUnitInstalled()) {
    console.error("Campfire is already installed as a service.");
    console.error("Run 'the-campfire uninstall' first to reinstall.");
    process.exit(1);
  }

  const binPath = resolveBinPath();
  const port = opts?.port ?? DEFAULT_PORT;

  // Create log directory
  mkdirSync(LOG_DIR, { recursive: true });

  // Generate and write systemd unit (capture user's shell PATH at install time)
  const path = getServicePath();
  const unit = generateSystemdUnit({ binPath, port, path });
  mkdirSync(SYSTEMD_DIR, { recursive: true });
  writeFileSync(UNIT_PATH, unit, "utf-8");

  // Reload systemd and enable + start the service
  try {
    systemctlUser("daemon-reload");
    systemctlUser(`enable --now ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to enable the service with systemctl:");
    console.error(err instanceof Error ? err.message : "Unknown error");
    // Clean up the unit file on failure
    try { unlinkSync(UNIT_PATH); } catch { /* ok */ }
    process.exit(1);
  }

  // Enable linger so user services survive logout
  try {
    execFileSync(BIN_LOGINCTL, ["enable-linger"], { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    console.warn(
      "Warning: Could not enable linger. The service may stop when you log out.",
    );
    console.warn("  sudo loginctl enable-linger $(whoami)");
  }

  console.log("Campfire has been installed as a background service.");
  console.log("");
  console.log(`  URL:    http://localhost:${port}`);
  console.log(`  Logs:   ${LOG_DIR}`);
  console.log(`  Unit:   ${UNIT_PATH}`);
  console.log("");
  console.log("The service will start automatically on login.");
  console.log("Use 'the-campfire status' to check if it's running.");
}

// ─── Uninstall ──────────────────────────────────────────────────────────────────

export async function uninstall(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return uninstallDarwin();
  }
  return uninstallLinux();
}

async function uninstallDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  unloadLaunchdService(installedService.plistPath);
  removePlist(installedService.plistPath);

  console.log("Campfire service has been removed.");
  console.log(`Logs are preserved at ${LOG_DIR}`);
}

async function uninstallLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  try {
    systemctlUser(`disable --now ${UNIT_NAME}`);
  } catch {
    // Service may already be stopped — that's fine
  }

  try {
    unlinkSync(UNIT_PATH);
  } catch {
    // Already gone
  }

  try {
    systemctlUser("daemon-reload");
  } catch {
    // Best-effort reload
  }

  console.log("Campfire service has been removed.");
  console.log(`Logs are preserved at ${LOG_DIR}`);
}

// ─── Stop / Restart ────────────────────────────────────────────────────────────

export async function start(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return startDarwin();
  }
  return startLinux();
}

async function startDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("Campfire is not installed as a service.");
    console.log("Run 'the-campfire install' first.");
    return;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domain = uid === undefined ? "gui" : `gui/${uid}`;
  const domainTarget = uid === undefined
    ? installedService.label
    : `gui/${uid}/${installedService.label}`;

  try {
    execFileSync(BIN_LAUNCHCTL, ["kickstart", "-k", domainTarget], { stdio: "pipe" });
  } catch {
    try {
      execFileSync(BIN_LAUNCHCTL, ["bootstrap", domain, installedService.plistPath], { stdio: "pipe" });
    } catch {
      try {
        execFileSync(BIN_LAUNCHCTL, ["load", "-w", installedService.plistPath], { stdio: "pipe" });
      } catch (err: unknown) {
        console.error("Failed to start the service with launchctl:");
        console.error(err instanceof Error ? err.message : "Unknown error");
        process.exit(1);
      }
    }
  }

  console.log("Campfire service has been started.");
}

async function startLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    console.log("Service not yet installed. Installing now...");
    await installLinux();
    return; // installLinux uses enable --now which starts the service
  }

  // Ensure the installed unit file matches the latest template (e.g.
  // SuccessExitStatus=42, Restart=always) so that stale definitions from
  // older versions don't cause restart loops after an auto-update.
  refreshServiceDefinition();

  try {
    systemctlUser(`start ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to start the service with systemctl:");
    console.error(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }

  console.log("Campfire service has been started.");
}

export async function stop(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return stopDarwin();
  }
  return stopLinux();
}

async function stopDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const domainTarget = uid === undefined
      ? installedService.label
      : `gui/${uid}/${installedService.label}`;
    // `stop` is not enough with KeepAlive=true: launchd can immediately restart it.
    // Booting out unloads the job from launchd while keeping the plist installed.
    execFileSync(BIN_LAUNCHCTL, ["bootout", domainTarget], { stdio: "pipe" });
  } catch {
    // Fallback for environments where bootout/domain targeting is unavailable.
    unloadLaunchdService(installedService.plistPath);
  }

  console.log("Campfire service has been stopped.");
  console.log("Run 'the-campfire restart' to start it again.");
}

async function stopLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  try {
    systemctlUser(`stop ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to stop the service with systemctl:");
    console.error(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }

  console.log("Campfire service has been stopped.");
  console.log("Run 'the-campfire restart' to start it again.");
}

export async function restart(): Promise<void> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return restartDarwin();
  }
  return restartLinux();
}

async function restartDarwin(): Promise<void> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const domainTarget = uid === undefined
    ? installedService.label
    : `gui/${uid}/${installedService.label}`;

  try {
    execFileSync(BIN_LAUNCHCTL, ["kickstart", "-k", domainTarget], { stdio: "pipe" });
  } catch {
    // Fallback for environments where kickstart/domain targeting is unavailable.
    unloadLaunchdService(installedService.plistPath);
    try {
      execFileSync(BIN_LAUNCHCTL, ["load", "-w", installedService.plistPath], { stdio: "pipe" });
    } catch (err: unknown) {
      console.error("Failed to restart the service with launchctl:");
      console.error(err instanceof Error ? err.message : "Unknown error");
      process.exit(1);
    }
  }

  console.log("Campfire service has been restarted.");
}

async function restartLinux(): Promise<void> {
  if (!isSystemdUnitInstalled()) {
    console.log("Campfire is not installed as a service.");
    return;
  }

  // Keep the unit file in sync with the latest template before restarting.
  refreshServiceDefinition();

  try {
    systemctlUser(`restart ${UNIT_NAME}`);
  } catch (err: unknown) {
    console.error("Failed to restart the service with systemctl:");
    console.error(err instanceof Error ? err.message : "Unknown error");
    process.exit(1);
  }

  console.log("Campfire service has been restarted.");
}

// ─── Status ─────────────────────────────────────────────────────────────────────

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
}

/**
 * Safe check for whether the current process is running as a managed service.
 * Unlike status(), this never calls process.exit() and works on all platforms.
 */
export function isRunningAsService(): boolean {
  if (isDarwin()) {
    const installedService = getInstalledLaunchdService();
    if (!installedService) return false;
    try {
      const output = execFileSync(BIN_LAUNCHCTL, ["list", installedService.label], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return /"PID"\s*=\s*\d+/.test(output);
    } catch {
      return false;
    }
  }

  if (isLinux()) {
    if (!isSystemdUnitInstalled()) return false;
    try {
      const output = systemctlUser(`is-active ${UNIT_NAME}`);
      return output.trim() === "active";
    } catch {
      return false;
    }
  }

  return false;
}

function refreshDarwinDefinition(): void {
  const installedService = getInstalledLaunchdService();
  if (!installedService) return;

  let port = DEFAULT_PORT;
  try {
    const content = readFileSync(installedService.plistPath, "utf-8");
    const portMatch = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(content);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  const binPath = resolveBinPath();
  const path = getServicePath();
  const plist = generatePlist({ binPath, port, path });
  writeFileSync(installedService.plistPath, plist, "utf-8");
}

function refreshLinuxDefinition(): void {
  if (!isSystemdUnitInstalled()) return;

  let port = DEFAULT_PORT;
  try {
    const content = readFileSync(UNIT_PATH, "utf-8");
    const portMatch = /Environment=PORT=(\d+)/.exec(content);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  const binPath = resolveBinPath();
  const path = getServicePath();
  const unit = generateSystemdUnit({ binPath, port, path });
  writeFileSync(UNIT_PATH, unit, "utf-8");

  try {
    systemctlUser("daemon-reload");
  } catch { /* best effort */ }
}

/**
 * Re-write the service definition (plist or systemd unit) using the current
 * binary path and the latest template, preserving the user's custom port.
 * On Linux this also calls daemon-reload so systemd picks up the changes.
 */
export function refreshServiceDefinition(): void {
  if (isDarwin()) {
    refreshDarwinDefinition();
  } else if (isLinux()) {
    refreshLinuxDefinition();
  }
}

export async function status(): Promise<ServiceStatus> {
  ensureSupportedPlatform();

  if (isDarwin()) {
    return statusDarwin();
  }
  return statusLinux();
}

async function statusDarwin(): Promise<ServiceStatus> {
  const installedService = getInstalledLaunchdService();
  if (!installedService) {
    return { installed: false, running: false };
  }

  // Read port from the plist
  let port = DEFAULT_PORT;
  try {
    const plistContent = readFileSync(installedService.plistPath, "utf-8");
    const portMatch = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(plistContent);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  // Check if service is running via launchctl
  try {
    const output = execFileSync(BIN_LAUNCHCTL, ["list", installedService.label], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse PID from the launchctl list output
    const pidMatch = /"PID"\s*=\s*(\d+)/.exec(output);
    if (pidMatch) {
      return { installed: true, running: true, pid: Number(pidMatch[1]), port };
    }

    // Service is loaded but not running (no PID)
    return { installed: true, running: false, port };
  } catch {
    // launchctl list fails if service is not loaded
    return { installed: true, running: false, port };
  }
}

async function statusLinux(): Promise<ServiceStatus> {
  if (!isSystemdUnitInstalled()) {
    return { installed: false, running: false };
  }

  // Read port from the unit file
  let port = DEFAULT_PORT;
  try {
    const unitContent = readFileSync(UNIT_PATH, "utf-8");
    const portMatch = /Environment=PORT=(\d+)/.exec(unitContent);
    if (portMatch) port = Number(portMatch[1]);
  } catch { /* use default */ }

  // Check if service is running via systemctl
  try {
    const output = systemctlUser(`show ${UNIT_NAME} --property=ActiveState,MainPID --no-pager`);
    const activeMatch = /ActiveState=(\w+)/.exec(output);
    const pidMatch = /MainPID=(\d+)/.exec(output);

    const isActive = activeMatch?.[1] === "active";
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;

    if (isActive && pid && pid > 0) {
      return { installed: true, running: true, pid, port };
    }

    return { installed: true, running: false, port };
  } catch {
    return { installed: true, running: false, port };
  }
}
