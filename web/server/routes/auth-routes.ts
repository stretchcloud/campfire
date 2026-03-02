import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import {
  isAuthEnabled,
  login,
  logout,
  verifyToken,
  getAuthStatus,
  setPassword,
  disableAuth,
} from "../auth.js";

export function registerAuthRoutes(api: Hono, _deps: RouteDeps): void {
  // Check if auth is enabled and whether the user is logged in
  api.get("/auth/status", (c) => {
    const status = getAuthStatus();
    const token = c.req.header("Authorization")?.replace("Bearer ", "")
      || c.req.query("token");
    const isLoggedIn = token ? verifyToken(token) : !status.enabled;
    return c.json({ ...status, isLoggedIn });
  });

  // Login with password
  api.post("/auth/login", async (c) => {
    const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
    if (!body.password) {
      return c.json({ error: "Password is required" }, 400);
    }
    const userAgent = c.req.header("User-Agent");
    const token = login(body.password, userAgent);
    if (!token) {
      return c.json({ error: "Invalid password" }, 401);
    }
    return c.json({ token });
  });

  // Logout
  api.post("/auth/logout", async (c) => {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (token) {
      logout(token);
    }
    return c.json({ ok: true });
  });

  // Set password (only when no password is set yet, or when authenticated)
  api.post("/auth/setup", async (c) => {
    const status = getAuthStatus();
    // If auth is already enabled, require a valid token
    if (status.enabled) {
      const token = c.req.header("Authorization")?.replace("Bearer ", "");
      if (!token || !verifyToken(token)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
    if (!body.password || body.password.length < 4) {
      return c.json({ error: "Password must be at least 4 characters" }, 400);
    }
    setPassword(body.password);
    return c.json({ ok: true, ...getAuthStatus() });
  });

  // Disable auth (requires valid token)
  api.post("/auth/disable", async (c) => {
    const token = c.req.header("Authorization")?.replace("Bearer ", "");
    if (!token || !verifyToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    disableAuth();
    return c.json({ ok: true });
  });
}

/**
 * Middleware that checks auth for all /api/* routes except /api/auth/*
 */
export function authMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    // Always allow auth routes
    if (c.req.path.startsWith("/api/auth")) {
      return next();
    }

    // If auth is not enabled, skip
    if (!isAuthEnabled()) {
      return next();
    }

    // Check token from Authorization header or query param
    const token = c.req.header("Authorization")?.replace("Bearer ", "")
      || c.req.query("token");

    if (!token || !verifyToken(token)) {
      return c.json({ error: "Unauthorized", authRequired: true }, 401);
    }

    return next();
  };
}
