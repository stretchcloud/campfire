/**
 * Tests for security-middleware.ts — rate limiter client identification.
 *
 * Validates:
 * - direct clients are bucketed by their actual socket IP (tagged via
 *   tagRequestIp from the Bun.serve fetch handler), so two different hosts
 *   never share a bucket
 * - a non-loopback direct client cannot dodge the limiter by spoofing
 *   x-forwarded-for headers
 * - when the direct peer is a loopback reverse proxy, x-forwarded-for is
 *   honored so real client IPs are used behind a proxy
 * - security headers are applied to responses
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LIMIT = 3;

async function loadMiddleware() {
  // Re-import with a small limit so tests don't need 120 requests per bucket.
  process.env.CAMPFIRE_RATE_LIMIT_MAX = String(LIMIT);
  process.env.CAMPFIRE_RATE_LIMIT_WINDOW_MS = "60000";
  vi.resetModules();
  return import("./security-middleware.js");
}

function buildApp(mw: Awaited<ReturnType<typeof loadMiddleware>>): Hono {
  const app = new Hono();
  app.use("/*", mw.rateLimiter);
  app.get("/ping", (c) => c.json({ ok: true }));
  return app;
}

/** Issue a request tagged with a socket IP, mimicking index.ts's fetch handler. */
async function request(
  app: Hono,
  mw: Awaited<ReturnType<typeof loadMiddleware>>,
  socketIp: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request("http://localhost/ping", { headers });
  if (socketIp) mw.tagRequestIp(req, socketIp);
  return app.fetch(req);
}

beforeEach(() => {
  delete process.env.CAMPFIRE_RATE_LIMIT_MAX;
  delete process.env.CAMPFIRE_RATE_LIMIT_WINDOW_MS;
});

describe("rateLimiter client identification", () => {
  it("buckets direct clients by socket IP, not a shared 'unknown' bucket", async () => {
    const mw = await loadMiddleware();
    const app = buildApp(mw);

    // Exhaust the limit for host A…
    for (let i = 0; i < LIMIT; i++) {
      expect((await request(app, mw, "10.0.0.1")).status).toBe(200);
    }
    expect((await request(app, mw, "10.0.0.1")).status).toBe(429);

    // …host B must be unaffected (previously both fell into "unknown").
    expect((await request(app, mw, "10.0.0.2")).status).toBe(200);
  });

  it("ignores spoofed x-forwarded-for from a non-loopback direct client", async () => {
    const mw = await loadMiddleware();
    const app = buildApp(mw);

    // The attacker rotates x-forwarded-for on every request; the socket IP
    // stays the same, so the limiter must still trip.
    for (let i = 0; i < LIMIT; i++) {
      const res = await request(app, mw, "10.0.0.9", { "x-forwarded-for": `1.2.3.${i}` });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app, mw, "10.0.0.9", { "x-forwarded-for": "9.9.9.9" });
    expect(blocked.status).toBe(429);
  });

  it("honors x-forwarded-for when the direct peer is a loopback proxy", async () => {
    const mw = await loadMiddleware();
    const app = buildApp(mw);

    // Behind a local reverse proxy, distinct forwarded clients get distinct buckets.
    for (let i = 0; i < LIMIT; i++) {
      expect((await request(app, mw, "127.0.0.1", { "x-forwarded-for": "203.0.113.5" })).status).toBe(200);
    }
    expect((await request(app, mw, "127.0.0.1", { "x-forwarded-for": "203.0.113.5" })).status).toBe(429);
    expect((await request(app, mw, "127.0.0.1", { "x-forwarded-for": "203.0.113.6" })).status).toBe(200);
  });

  it("sets rate-limit headers and Retry-After on 429", async () => {
    const mw = await loadMiddleware();
    const app = buildApp(mw);

    const ok = await request(app, mw, "10.1.1.1");
    expect(ok.headers.get("X-RateLimit-Limit")).toBe(String(LIMIT));
    expect(Number(ok.headers.get("X-RateLimit-Remaining"))).toBe(LIMIT - 1);

    for (let i = 0; i < LIMIT; i++) await request(app, mw, "10.1.1.1");
    const blocked = await request(app, mw, "10.1.1.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("securityHeaders", () => {
  it("applies standard security headers", async () => {
    const mw = await loadMiddleware();
    const app = new Hono();
    app.use("/*", mw.securityHeaders);
    app.get("/ping", (c) => c.json({ ok: true }));

    const res = await app.fetch(new Request("http://localhost/ping"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    // HSTS only when the request arrived over HTTPS via a proxy.
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();

    const httpsRes = await app.fetch(new Request("http://localhost/ping", {
      headers: { "x-forwarded-proto": "https" },
    }));
    expect(httpsRes.headers.get("Strict-Transport-Security")).toContain("max-age");
  });
});
