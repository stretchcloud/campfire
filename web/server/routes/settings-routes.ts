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

    const settings = updateSettings({
      openrouterApiKey:
        typeof body.openrouterApiKey === "string"
          ? body.openrouterApiKey.trim()
          : undefined,
      openrouterModel:
        typeof body.openrouterModel === "string"
          ? (body.openrouterModel.trim() || DEFAULT_OPENROUTER_MODEL)
          : undefined,
      moltbookApiKey:
        typeof body.moltbookApiKey === "string"
          ? body.moltbookApiKey.trim()
          : undefined,
      linearApiKey:
        typeof body.linearApiKey === "string"
          ? body.linearApiKey.trim()
          : undefined,
    });

    return c.json({
      openrouterApiKeyConfigured: !!settings.openrouterApiKey.trim(),
      openrouterModel: settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
      moltbookApiKeyConfigured: !!settings.moltbookApiKey?.trim(),
      linearApiKeyConfigured: !!settings.linearApiKey?.trim(),
    });
  });
}
