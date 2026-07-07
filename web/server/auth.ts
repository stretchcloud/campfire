import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const AUTH_FILE = join(homedir(), ".campfire", "auth.json");

interface AuthConfig {
  /** Salted scrypt hash (`scrypt:<saltHex>:<hashHex>`), or a legacy unsalted SHA-256 hex digest. */
  passwordHash: string;
  /** Active session tokens (browser login sessions) */
  sessions: { token: string; createdAt: number; userAgent?: string }[];
  /** Whether auth is enabled */
  enabled: boolean;
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEYLEN = 32;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a password against a stored hash. Supports the current salted
 *  scrypt format and the legacy unsalted SHA-256 format (pre-migration). */
function verifyPassword(password: string, stored: string): { valid: boolean; legacy: boolean } {
  if (stored.startsWith(`${SCRYPT_PREFIX}:`)) {
    const [, saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex) return { valid: false, legacy: false };
    const candidate = scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
    return { valid: constantTimeEqualHex(candidate.toString("hex"), hashHex), legacy: false };
  }
  return { valid: constantTimeEqualHex(sha256(password), stored), legacy: true };
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

/** Set a password (for UI-based setup) */
export function setPassword(password: string): void {
  const config = load();
  config.passwordHash = hashPassword(password);
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

/** Check the supplied password against the env var or saved config.
 *  Returns whether it matched and whether a legacy hash should be upgraded. */
function checkPassword(password: string, config: AuthConfig): { valid: boolean; upgradeLegacy: boolean } {
  const envPassword = process.env.CAMPFIRE_PASSWORD;
  if (envPassword) {
    // Hash both sides so the comparison is constant-time for any input length.
    return { valid: constantTimeEqualHex(sha256(password), sha256(envPassword)), upgradeLegacy: false };
  }
  if (!config.enabled || !config.passwordHash) return { valid: false, upgradeLegacy: false };
  const { valid, legacy } = verifyPassword(password, config.passwordHash);
  return { valid, upgradeLegacy: valid && legacy };
}

/** Verify a password and return a session token if valid */
export function login(password: string, userAgent?: string): string | null {
  const config = load();
  const { valid, upgradeLegacy } = checkPassword(password, config);
  if (!valid) return null;

  // Transparently migrate legacy unsalted SHA-256 hashes to salted scrypt.
  if (upgradeLegacy) {
    config.passwordHash = hashPassword(password);
  }

  const token = randomBytes(32).toString("hex");
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
