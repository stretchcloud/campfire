import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import * as sessionFolders from "../session-folders.js";

export function registerFolderRoutes(api: Hono, _deps: RouteDeps): void {
  // List all folders
  api.get("/folders", (c) => {
    return c.json(sessionFolders.listFolders());
  });

  // Create a folder
  api.post("/folders", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body.name || typeof body.name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    const folder = sessionFolders.createFolder(body.name.trim(), body.color);
    return c.json(folder);
  });

  // Update a folder
  api.patch("/folders/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const folder = sessionFolders.updateFolder(id, {
      name: body.name,
      color: body.color,
    });
    if (!folder) return c.json({ error: "Folder not found" }, 404);
    return c.json(folder);
  });

  // Delete a folder
  api.delete("/folders/:id", (c) => {
    const id = c.req.param("id");
    const ok = sessionFolders.deleteFolder(id);
    if (!ok) return c.json({ error: "Folder not found" }, 404);
    return c.json({ ok: true });
  });

  // Add session to folder
  api.post("/folders/:id/sessions/:sessionId", (c) => {
    const folderId = c.req.param("id");
    const sessionId = c.req.param("sessionId");
    const ok = sessionFolders.addSessionToFolder(folderId, sessionId);
    if (!ok) return c.json({ error: "Folder not found" }, 404);
    return c.json({ ok: true });
  });

  // Remove session from any folder
  api.delete("/folders/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    sessionFolders.removeSessionFromFolder(sessionId);
    return c.json({ ok: true });
  });
}
