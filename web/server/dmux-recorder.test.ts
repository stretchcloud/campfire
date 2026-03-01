import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "abc123" })),
}));

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { DmuxPaneRecorder, listDmuxRecordings, loadDmuxRecording } from "./dmux-recorder.js";

const mockAppendFileSync = appendFileSync as unknown as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as unknown as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;

describe("DmuxPaneRecorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes header line on construction", () => {
    const _recorder = new DmuxPaneRecorder("/test", "dmux-session", ["dmux-test:0.0", "dmux-test:0.1"]);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const headerLine = mockAppendFileSync.mock.calls[0][1] as string;
    const header = JSON.parse(headerLine.trim());
    expect(header._header).toBe(true);
    expect(header.version).toBe(1);
    expect(header.cwd).toBe("/test");
    expect(header.sessionName).toBe("dmux-session");
    expect(header.panes).toEqual(["dmux-test:0.0", "dmux-test:0.1"]);
    expect(header.startedAt).toBeTypeOf("number");
  });

  it("records entries as JSONL lines", () => {
    const recorder = new DmuxPaneRecorder("/test", "dmux-session", ["dmux-test:0.0"]);
    mockAppendFileSync.mockClear();

    recorder.record("dmux-test:0.0", "hello world");

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const entryLine = mockAppendFileSync.mock.calls[0][1] as string;
    const entry = JSON.parse(entryLine.trim());
    expect(entry.tmuxTarget).toBe("dmux-test:0.0");
    expect(entry.data).toBe("hello world");
    expect(entry.ts).toBeTypeOf("number");
  });

  it("stops recording after close", () => {
    const recorder = new DmuxPaneRecorder("/test", "dmux-session", []);
    recorder.close();
    mockAppendFileSync.mockClear();

    recorder.record("target", "data");
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("returns filename via getFilename()", () => {
    const recorder = new DmuxPaneRecorder("/test", "dmux-session", []);
    const filename = recorder.getFilename();
    expect(filename).toMatch(/^dmux_.*\.jsonl$/);
  });
});

describe("listDmuxRecordings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed headers from JSONL files", () => {
    mockReaddirSync.mockReturnValue(["rec1.jsonl", "rec2.jsonl", "not-jsonl.txt"]);

    const header1 = JSON.stringify({ _header: true, version: 1, cwd: "/a", sessionName: "s1", startedAt: 1000, panes: ["p1"] });
    const header2 = JSON.stringify({ _header: true, version: 1, cwd: "/b", sessionName: "s2", startedAt: 2000, panes: ["p2"] });

    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes("rec1")) return header1 + "\n";
      if (path.includes("rec2")) return header2 + "\n";
      return "";
    });

    const results = listDmuxRecordings();
    expect(results).toHaveLength(2);
    // Sorted by startedAt descending
    expect(results[0].sessionName).toBe("s2");
    expect(results[1].sessionName).toBe("s1");
  });

  it("returns empty array when directory doesn't exist", () => {
    mockReaddirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(listDmuxRecordings()).toEqual([]);
  });

  it("skips corrupt files", () => {
    mockReaddirSync.mockReturnValue(["bad.jsonl"]);
    mockReadFileSync.mockReturnValue("not json");

    expect(listDmuxRecordings()).toEqual([]);
  });

  it("skips files with invalid header shapes", () => {
    mockReaddirSync.mockReturnValue(["bad-header.jsonl"]);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ _header: true, version: 1, cwd: "/test" }) + "\n",
    );

    expect(listDmuxRecordings()).toEqual([]);
  });
});

describe("loadDmuxRecording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads header and entries from JSONL", () => {
    const header = { _header: true, version: 1, cwd: "/test", sessionName: "s", startedAt: 1000, panes: ["p1"] };
    const entry1 = { ts: 1001, tmuxTarget: "p1", data: "hello" };
    const entry2 = { ts: 1002, tmuxTarget: "p1", data: "world" };

    mockReadFileSync.mockReturnValue(
      [JSON.stringify(header), JSON.stringify(entry1), JSON.stringify(entry2)].join("\n"),
    );

    const result = loadDmuxRecording("test.jsonl");
    expect(result).not.toBeNull();
    expect(result!.header._header).toBe(true);
    expect(result!.entries).toHaveLength(2);
    expect(result!.entries[0].data).toBe("hello");
    expect(result!.entries[1].data).toBe("world");
  });

  it("returns null for missing file", () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(loadDmuxRecording("missing.jsonl")).toBeNull();
  });

  it("skips corrupt entry lines but keeps valid ones", () => {
    const header = { _header: true, version: 1, cwd: "/test", sessionName: "s", startedAt: 1000, panes: [] };
    const entry = { ts: 1001, tmuxTarget: "p1", data: "ok" };

    mockReadFileSync.mockReturnValue(
      [JSON.stringify(header), "corrupt line", JSON.stringify(entry)].join("\n"),
    );

    const result = loadDmuxRecording("test.jsonl");
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].data).toBe("ok");
  });

  it("rejects unsafe filenames", () => {
    expect(loadDmuxRecording("../secret.jsonl")).toBeNull();
    expect(loadDmuxRecording("recording.txt")).toBeNull();
    expect(loadDmuxRecording("subdir/recording.jsonl")).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("returns null when header shape is invalid", () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ _header: true, version: 1, cwd: "/test" }) + "\n",
    );
    expect(loadDmuxRecording("test.jsonl")).toBeNull();
  });

  it("skips parsed entries with invalid shape", () => {
    const header = { _header: true, version: 1, cwd: "/test", sessionName: "s", startedAt: 1000, panes: [] };
    const badEntry = { ts: "oops", tmuxTarget: "p1", data: "bad" };
    const goodEntry = { ts: 1001, tmuxTarget: "p1", data: "ok" };

    mockReadFileSync.mockReturnValue(
      [JSON.stringify(header), JSON.stringify(badEntry), JSON.stringify(goodEntry)].join("\n"),
    );

    const result = loadDmuxRecording("test.jsonl");
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0]).toEqual(goodEntry);
  });
});
