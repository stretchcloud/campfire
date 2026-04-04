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

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipBuckets) {
    if (entry.resetAt <= now) ipBuckets.delete(ip);
  }
}, 5 * 60_000);

function getClientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "unknown";
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
