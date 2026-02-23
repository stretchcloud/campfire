import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";

export function registerAdapterRoutes(api: Hono, deps: RouteDeps): void {
  const { adapterRegistry } = deps;

  api.get("/adapters", (c) => {
    if (!adapterRegistry) return c.json([]);
    return c.json(adapterRegistry.listInstalled());
  });

  api.post("/adapters/install", async (c) => {
    if (!adapterRegistry) return c.json({ error: "Adapter registry not available" }, 500);
    const { npmPackage } = await c.req.json() as { npmPackage: string };
    if (!npmPackage) return c.json({ error: "npmPackage is required" }, 400);
    try {
      const adapter = await adapterRegistry.install(npmPackage);
      return c.json(adapter, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.delete("/adapters/:name", (c) => {
    if (!adapterRegistry) return c.json({ error: "Adapter registry not available" }, 500);
    const name = c.req.param("name");
    const removed = adapterRegistry.uninstall(name);
    if (!removed) return c.json({ error: "Adapter not found" }, 404);
    return c.json({ ok: true });
  });
}
