import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";

export function registerPromptRoutes(api: Hono, _deps: RouteDeps): void {
  api.get("/prompts", async (c) => {
    const { listPrompts } = await import("../prompt-manager.js");
    const cwd = c.req.query("cwd");
    return c.json(listPrompts(cwd ? { cwd } : undefined));
  });

  api.post("/prompts", async (c) => {
    const { createPrompt } = await import("../prompt-manager.js");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const scope = body.scope === "project" ? "project" : "global";
    const projectPath = scope === "project" && typeof body.projectPath === "string" ? body.projectPath : undefined;
    const prompt = createPrompt(body.name.trim(), body.content.trim(), scope, projectPath);
    return c.json(prompt, 201);
  });

  api.put("/prompts/:id", async (c) => {
    const { updatePrompt } = await import("../prompt-manager.js");
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.content === "string") updates.content = body.content.trim();
    if (body.scope === "global" || body.scope === "project") updates.scope = body.scope;
    if (typeof body.projectPath === "string") updates.projectPath = body.projectPath;
    const updated = updatePrompt(id, updates as Parameters<typeof updatePrompt>[1]);
    if (!updated) return c.json({ error: "Prompt not found" }, 404);
    return c.json(updated);
  });

  api.delete("/prompts/:id", async (c) => {
    const { deletePrompt } = await import("../prompt-manager.js");
    const id = c.req.param("id");
    const deleted = deletePrompt(id);
    if (!deleted) return c.json({ error: "Prompt not found" }, 404);
    return c.json({ ok: true });
  });
}
