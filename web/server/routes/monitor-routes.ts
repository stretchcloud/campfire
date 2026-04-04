import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";

export function registerMonitorRoutes(api: Hono, deps: RouteDeps): void {
  const { protocolMonitor } = deps;

  api.get("/monitor/stats", (c) => {
    if (!protocolMonitor) return c.json({ error: "Monitor not available" }, 500);
    return c.json(protocolMonitor.getSnapshot());
  });
}
