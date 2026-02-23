import type { Hono } from "hono";
import type { RouteDeps } from "./route-deps.js";
import { join } from "node:path";
import { loadRecording, filterEntries } from "../replay.js";

export function registerRecordingRoutes(api: Hono, deps: RouteDeps): void {
  const { recorder, sessionStore } = deps;

  api.post("/sessions/:id/recording/start", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = c.req.param("id");
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: recorder.listRecordings() });
  });

  api.get("/recordings/:filename", (c) => {
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    const filename = c.req.param("filename");
    if (filename.includes("/") || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(recorder.getRecordingsDir(), filename);
    try {
      const recording = loadRecording(filePath);
      const browserEntries = filterEntries(recording.entries, "out", "browser");
      const messages = browserEntries.map((e) => {
        try { return JSON.parse(e.raw); } catch { return null; }
      }).filter(Boolean);
      const timestamps = browserEntries.map((e) => e.ts);
      return c.json({ header: recording.header, messages, timestamps });
    } catch (err: any) {
      return c.json({ error: err?.message || "Failed to load recording" }, 404);
    }
  });

  api.get("/sessions/:id/history", (c) => {
    const id = c.req.param("id");
    const persisted = sessionStore.load(id);
    if (!persisted) return c.json({ error: "Session not found" }, 404);
    return c.json({
      messages: persisted.messageHistory || [],
      state: persisted.state || null,
    });
  });
}
