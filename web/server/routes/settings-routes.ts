import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { DEFAULT_OPENROUTER_MODEL, getSettings, updateSettings } from "../settings-manager.js";

export function registerSettingsRoutes(api: Hono, _deps: RouteDeps): void {
  api.get("/settings", (c) => {
    const settings = getSettings();
    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
      moltbookApiKeyConfigured: !!settings.moltbookApiKey?.trim(),
      linearApiKeyConfigured: !!settings.linearApiKey?.trim(),
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.openrouterApiKey !== undefined && typeof body.openrouterApiKey !== "string") {
      return c.json({ error: "openrouterApiKey must be a string" }, 400);
    }
    if (body.openrouterModel !== undefined && typeof body.openrouterModel !== "string") {
      return c.json({ error: "openrouterModel must be a string" }, 400);
    }
    if (body.moltbookApiKey !== undefined && typeof body.moltbookApiKey !== "string") {
      return c.json({ error: "moltbookApiKey must be a string" }, 400);
    }
    if (body.linearApiKey !== undefined && typeof body.linearApiKey !== "string") {
      return c.json({ error: "linearApiKey must be a string" }, 400);
    }
    if (
      body.openrouterApiKey === undefined &&
      body.openrouterModel === undefined &&
      body.moltbookApiKey === undefined &&
      body.linearApiKey === undefined
    ) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    const patch: Record<string, string> = {};
    if (typeof body.openrouterApiKey === "string") patch.openrouterApiKey = body.openrouterApiKey.trim();
    if (typeof body.openrouterModel === "string") patch.openrouterModel = body.openrouterModel.trim() || DEFAULT_OPENROUTER_MODEL;
    if (typeof body.moltbookApiKey === "string") patch.moltbookApiKey = body.moltbookApiKey.trim();
    if (typeof body.linearApiKey === "string") patch.linearApiKey = body.linearApiKey.trim();

    const settings = updateSettings(patch);

    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
      moltbookApiKeyConfigured: !!settings.moltbookApiKey?.trim(),
      linearApiKeyConfigured: !!settings.linearApiKey?.trim(),
    });
  });
}
