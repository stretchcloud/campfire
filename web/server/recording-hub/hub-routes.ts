/**
 * Recording Hub REST API routes.
 *
 * Provides CRUD for hub recordings, validation, diagnostics,
 * timeline, import/upload, and tag management.
 */

import type { Hono } from "hono";
import type { RouteDeps } from "../routes/route-deps.js";
import { loadRecording } from "../replay.js";
import { validateRecording } from "./compat-validator.js";
import { analyzeRecording, buildTimeline } from "./diagnostics.js";
import * as hubStore from "./hub-store.js";

export function registerHubRoutes(api: Hono, deps: RouteDeps): void {
  const { recorder } = deps;

  // ─── List hub recordings ────────────────────────────────────────────
  api.get("/hub/recordings", (c) => {
    return c.json(hubStore.listHubRecordings());
  });

  // ─── Get single recording metadata ─────────────────────────────────
  api.get("/hub/recordings/:id", (c) => {
    const meta = hubStore.getHubRecording(c.req.param("id"));
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    return c.json(meta);
  });

  // ─── Get recording summary (with tool names, permission count) ─────
  api.get("/hub/recordings/:id/summary", (c) => {
    const summary = hubStore.getSummary(c.req.param("id"));
    if (!summary) return c.json({ error: "Recording not found" }, 404);
    return c.json(summary);
  });

  // ─── Update tags ───────────────────────────────────────────────────
  api.put("/hub/recordings/:id/tags", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.tags)) return c.json({ error: "tags must be an array" }, 400);
    const meta = hubStore.updateTags(c.req.param("id"), body.tags);
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    return c.json(meta);
  });

  // ─── Delete hub recording (from index only, not the file) ──────────
  api.delete("/hub/recordings/:id", (c) => {
    const deleted = hubStore.deleteHubRecording(c.req.param("id"));
    if (!deleted) return c.json({ error: "Recording not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Upload recording (JSONL content) ──────────────────────────────
  api.post("/hub/recordings/upload", async (c) => {
    const contentType = c.req.header("content-type") || "";
    let content: string;
    let filename: string | undefined;

    if (contentType.includes("application/json")) {
      const body = await c.req.json().catch(() => ({}));
      content = typeof body.content === "string" ? body.content : "";
      filename = typeof body.filename === "string" ? body.filename : undefined;
    } else {
      content = await c.req.text();
    }

    if (!content.trim()) return c.json({ error: "Empty content" }, 400);

    try {
      const meta = hubStore.uploadRecording(content, filename);
      return c.json(meta, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Upload failed" }, 400);
    }
  });

  // ─── Import from existing auto-recording ───────────────────────────
  api.post("/hub/recordings/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const filename = typeof body.filename === "string" ? body.filename : "";
    if (!filename) return c.json({ error: "filename is required" }, 400);

    const recordings = recorder?.listRecordings() || [];
    const match = recordings.find((r) => r.filename === filename);
    if (!match) return c.json({ error: "Recording file not found" }, 404);

    try {
      const recDir = process.env.CAMPFIRE_RECORDINGS_DIR || `${process.env.HOME || ""}/.campfire/recordings`;
      const filePath = `${recDir}/${filename}`;
      const meta = hubStore.importRecording(filePath);
      return c.json(meta, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Import failed" }, 400);
    }
  });

  // ─── Index all existing auto-recordings ────────────────────────────
  api.post("/hub/recordings/index-all", (c) => {
    if (!recorder) return c.json({ error: "Recorder not available" }, 500);
    const count = hubStore.indexExistingRecordings(recorder);
    return c.json({ ok: true, imported: count });
  });

  // ─── Validate recording (compat check) ─────────────────────────────
  api.get("/hub/recordings/:id/validate", (c) => {
    const meta = hubStore.getHubRecording(c.req.param("id"));
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    try {
      const recording = loadRecording(meta.filePath);
      return c.json(validateRecording(recording));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Validation failed" }, 500);
    }
  });

  // ─── Diagnostics (health report) ───────────────────────────────────
  api.get("/hub/recordings/:id/diagnostics", (c) => {
    const meta = hubStore.getHubRecording(c.req.param("id"));
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    try {
      const recording = loadRecording(meta.filePath);
      return c.json(analyzeRecording(recording));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Diagnostics failed" }, 500);
    }
  });

  // ─── Timeline ──────────────────────────────────────────────────────
  api.get("/hub/recordings/:id/timeline", (c) => {
    const meta = hubStore.getHubRecording(c.req.param("id"));
    if (!meta) return c.json({ error: "Recording not found" }, 404);
    try {
      const recording = loadRecording(meta.filePath);
      return c.json(buildTimeline(recording));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Timeline failed" }, 500);
    }
  });
}
