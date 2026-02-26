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

      // Playable message types for the replay UI
      const PLAYABLE_TYPES = new Set([
        "assistant", "result", "user_message", "stream_event",
        "permission_request", "permission_cancelled", "status_change",
      ]);

      // Collect outgoing browser messages (server→browser)
      const outEntries = filterEntries(recording.entries, "out", "browser");
      // Collect incoming browser messages (browser→server) for user_message
      const inEntries = filterEntries(recording.entries, "in", "browser");

      // Merge both channels chronologically, filtering to playable types
      const merged: { ts: number; parsed: unknown }[] = [];
      for (const e of outEntries) {
        try {
          const parsed = JSON.parse(e.raw);
          if (PLAYABLE_TYPES.has(parsed.type)) {
            merged.push({ ts: e.ts, parsed });
          }
        } catch { /* skip malformed */ }
      }
      for (const e of inEntries) {
        try {
          const parsed = JSON.parse(e.raw);
          if (parsed.type === "user_message") {
            merged.push({ ts: e.ts, parsed });
          }
        } catch { /* skip malformed */ }
      }

      // Sort by timestamp
      merged.sort((a, b) => a.ts - b.ts);

      const messages = merged.map((m) => m.parsed);
      const timestamps = merged.map((m) => m.ts);
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
