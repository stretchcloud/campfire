import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as skillsManager from "../skills-manager.js";

export function registerSkillsRoutes(api: Hono, _deps: RouteDeps): void {
  // List all installed plugins with their skills and commands
  api.get("/skills", (c) => {
    const plugins = skillsManager.listPlugins();
    const disabled = skillsManager.getDisabledPlugins();
    const enriched = plugins.map((p) => ({
      ...p,
      disabledInCampfire: disabled.includes(p.id),
    }));
    return c.json(enriched);
  });

  // Get a single plugin by ID
  api.get("/skills/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const plugin = skillsManager.getPlugin(id);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);
    const disabled = skillsManager.isPluginDisabled(id);
    return c.json({ ...plugin, disabledInCampfire: disabled });
  });

  // Read a skill's SKILL.md content
  api.get("/skills/:id/skill/:name", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const name = decodeURIComponent(c.req.param("name"));
    const content = skillsManager.readSkillContent(id, name);
    if (content === null) return c.json({ error: "Skill not found" }, 404);
    return c.json({ content });
  });

  // Read a command's content
  api.get("/skills/:id/command/:name", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const name = decodeURIComponent(c.req.param("name"));
    const content = skillsManager.readCommandContent(id, name);
    if (content === null) return c.json({ error: "Command not found" }, 404);
    return c.json({ content });
  });

  // Toggle plugin enabled/disabled in Campfire
  api.post("/skills/:id/toggle", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json().catch(() => ({}));
    const disabled = body.disabled === true;
    skillsManager.setPluginDisabled(id, disabled);
    return c.json({ ok: true, disabled });
  });
}
