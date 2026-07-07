/**
 * Security middleware — headers + rate limiting for the Hono server.
 *
 * Security headers: X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
 * X-XSS-Protection, Strict-Transport-Security, Permissions-Policy.
 *
 * Rate limiting: per-IP sliding window, configurable via env vars.
 */

import type { Context, Next } from "hono";

// ─── Security Headers ──────────────────────────────────────────────────────

export async function securityHeaders(c: Context, next: Next): Promise<void> {
  await next();

  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // HSTS only if behind HTTPS (don't break HTTP dev setups)
  if (c.req.header("x-forwarded-proto") === "https") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

const WINDOW_MS = Number(process.env.CAMPFIRE_RATE_LIMIT_WINDOW_MS) || 60_000;
const MAX_REQUESTS = Number(process.env.CAMPFIRE_RATE_LIMIT_MAX) || 120;

interface RateEntry {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateEntry>();

// Clean up stale entries every 5 minutes. unref() so the interval never
// keeps the process (or a test runner) alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipBuckets) {
    if (entry.resetAt <= now) ipBuckets.delete(ip);
  }
}, 5 * 60_000).unref?.();

/** Socket-level remote IPs, tagged by the Bun.serve fetch handler before the
 *  request reaches Hono. A WeakMap keyed by the raw Request cannot be spoofed
 *  by client-supplied headers. */
const requestIps = new WeakMap<Request, string>();

/** Record the actual socket remote address for a request (called from index.ts). */
export function tagRequestIp(req: Request, ip: string | undefined | null): void {
  if (ip) requestIps.set(req, ip);
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function getClientIp(c: Context): string {
  const socketIp = requestIps.get(c.req.raw) ?? "";
  // Forwarded headers are only trustworthy when the direct peer is a local
  // reverse proxy — otherwise a client could spoof them to dodge the limiter.
  if (!socketIp || isLoopback(socketIp)) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip");
    if (forwarded) return forwarded;
  }
  return socketIp || "unknown";
}

export async function rateLimiter(c: Context, next: Next): Promise<void> {
  const ip = getClientIp(c);
  const now = Date.now();

  let entry = ipBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    ipBuckets.set(ip, entry);
  }

  entry.count++;

  // Set rate limit headers
  const remaining = Math.max(0, MAX_REQUESTS - entry.count);
  c.header("X-RateLimit-Limit", String(MAX_REQUESTS));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

  if (entry.count > MAX_REQUESTS) {
    c.header("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return c.json({ error: "Too many requests. Please retry later." }, 429) as unknown as void;
  }

  await next();
}
