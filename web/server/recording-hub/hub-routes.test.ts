import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecorderManager } from "../recorder.js";
import type { HubRecordingMeta } from "./hub-store.js";

let tempDir: string;
let previousRecordingsDir: string | undefined;
let recordingCounter: number;

beforeEach(() => {
  previousRecordingsDir = process.env.CAMPFIRE_RECORDINGS_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "hub-routes-test-"));
  process.env.CAMPFIRE_RECORDINGS_DIR = tempDir;
  recordingCounter = 0;
  vi.resetModules();
});

afterEach(() => {
  if (previousRecordingsDir === undefined) {
    delete process.env.CAMPFIRE_RECORDINGS_DIR;
  } else {
    process.env.CAMPFIRE_RECORDINGS_DIR = previousRecordingsDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function createHubApp(recorder?: Pick<RecorderManager, "listRecordings">): Promise<Hono> {
  const { registerHubRoutes } = await import("./hub-routes.js");
  const app = new Hono();
  registerHubRoutes(app, { recorder } as any);
  return app;
}

function createRecording(sessionId: string): string {
  const startedAt = Date.now();
  const filename = `${sessionId}_claude_test-${recordingCounter++}.jsonl`;
  const lines = [
    JSON.stringify({
      _header: true,
      version: 1,
      session_id: sessionId,
      backend_type: "claude",
      started_at: startedAt,
      cwd: "/repo",
    }),
    JSON.stringify({
      ts: startedAt + 10,
      dir: "out",
      ch: "browser",
      raw: JSON.stringify({ type: "assistant", message: { content: [] } }),
    }),
  ];
  const filePath = join(tempDir, filename);
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

async function listRecordings(app: Hono): Promise<HubRecordingMeta[]> {
  const res = await app.request("/hub/recordings");
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /hub/recordings", () => {
  it("auto-indexes existing JSONL recordings on first GET", async () => {
    // Verifies opening the hub is enough to discover recordings already on disk.
    const filePath = createRecording("session-a");
    const filename = basename(filePath);
    const recorder = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const app = await createHubApp(recorder);

    const recordings = await listRecordings(app);

    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({
      filename,
      filePath,
      sessionId: "session-a",
      backendType: "claude",
      entryCount: 1,
    });
  });

  it("does not duplicate entries on later GETs", async () => {
    // Repeated hub opens should be idempotent because recordings are keyed by filename.
    createRecording("session-b");
    const recorder = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const app = await createHubApp(recorder);

    const first = await listRecordings(app);
    const second = await listRecordings(app);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
  });

  it("returns existing indexed entries if indexing fails", async () => {
    // The list route should degrade to the saved index if a filesystem scan throws.
    const filePath = createRecording("session-c");
    const filename = basename(filePath);
    const recorder = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const app = await createHubApp(recorder);

    const indexed = await listRecordings(app);
    const appWithFailingRecorder = await createHubApp({
      listRecordings: () => {
        throw new Error("scan failed");
      },
    });

    const recordings = await listRecordings(appWithFailingRecorder);

    expect(recordings).toHaveLength(1);
    expect(recordings[0].id).toBe(indexed[0].id);
    expect(recordings[0].filename).toBe(filename);
  });

  it("returns existing indexed entries if recorder is unavailable", async () => {
    // A missing recorder dependency should not hide recordings that are already indexed.
    const filePath = createRecording("session-d");
    const filename = basename(filePath);
    const recorder = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const app = await createHubApp(recorder);

    const indexed = await listRecordings(app);
    const appWithoutRecorder = await createHubApp();
    const recordings = await listRecordings(appWithoutRecorder);

    expect(recordings).toHaveLength(1);
    expect(recordings[0].id).toBe(indexed[0].id);
    expect(recordings[0].filename).toBe(filename);
  });

  it("returns an empty list when no recordings exist", async () => {
    // Empty recording directories should remain a successful empty response.
    const recorder = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const app = await createHubApp(recorder);

    const recordings = await listRecordings(app);

    expect(recordings).toEqual([]);
  });
});
