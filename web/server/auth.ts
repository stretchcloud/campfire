import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const AUTH_FILE = join(homedir(), ".companion", "auth.json");

interface AuthConfig {
  /** bcrypt-style hash of the password/token */
  passwordHash: string;
  /** Active session tokens (browser login sessions) */
  sessions: { token: string; createdAt: number; userAgent?: string }[];
  /** Whether auth is enabled */
  enabled: boolean;
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function load(): AuthConfig {
  try {
    if (existsSync(AUTH_FILE)) {
      return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return { passwordHash: "", sessions: [], enabled: false };
}

function save(config: AuthConfig): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/** Check if auth is enabled (either via env var or saved config) */
export function isAuthEnabled(): boolean {
  // CAMPFIRE_PASSWORD env var takes priority
  if (process.env.CAMPFIRE_PASSWORD) return true;
  return load().enabled;
}

/** Get the expected password hash */
function getExpectedHash(): string | null {
  const envPassword = process.env.CAMPFIRE_PASSWORD;
  if (envPassword) return sha256(envPassword);
  const config = load();
  if (config.enabled && config.passwordHash) return config.passwordHash;
  return null;
}

/** Set a password (for UI-based setup) */
export function setPassword(password: string): void {
  const config = load();
  config.passwordHash = sha256(password);
  config.enabled = true;
  save(config);
}

/** Disable auth entirely */
export function disableAuth(): void {
  const config = load();
  config.enabled = false;
  config.passwordHash = "";
  config.sessions = [];
  save(config);
}

/** Verify a password and return a session token if valid */
export function login(password: string, userAgent?: string): string | null {
  const expected = getExpectedHash();
  if (!expected) return null;
  if (sha256(password) !== expected) return null;

  const token = randomBytes(32).toString("hex");
  const config = load();
  // Prune expired sessions
  const now = Date.now();
  config.sessions = config.sessions.filter((s) => now - s.createdAt < SESSION_MAX_AGE_MS);
  config.sessions.push({ token: sha256(token), createdAt: now, userAgent });
  save(config);
  return token;
}

/** Verify a session token */
export function verifyToken(token: string): boolean {
  if (!isAuthEnabled()) return true; // no auth = always valid
  const config = load();
  const hashed = sha256(token);
  const now = Date.now();
  return config.sessions.some(
    (s) => s.token === hashed && now - s.createdAt < SESSION_MAX_AGE_MS,
  );
}

/** Logout — invalidate a session token */
export function logout(token: string): void {
  const config = load();
  const hashed = sha256(token);
  config.sessions = config.sessions.filter((s) => s.token !== hashed);
  save(config);
}

/** Get auth status (for the frontend) */
export function getAuthStatus(): { enabled: boolean; hasPassword: boolean; activeSessions: number } {
  const envPassword = !!process.env.CAMPFIRE_PASSWORD;
  const config = load();
  const now = Date.now();
  const activeSessions = config.sessions.filter(
    (s) => now - s.createdAt < SESSION_MAX_AGE_MS,
  ).length;
  return {
    enabled: envPassword || config.enabled,
    hasPassword: envPassword || !!config.passwordHash,
    activeSessions,
  };
}
