import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { readDmuxConfig, writeDmuxConfig, updateDmuxConfig } from "./dmux-config.js";

const mockReadFileSync = readFileSync as unknown as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as unknown as ReturnType<typeof vi.fn>;

describe("dmux-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readDmuxConfig", () => {
    it("returns parsed config when file exists", () => {
      const config = {
        session_name: "dmux-test",
        project_root: "/test",
        branch_prefix: "dmux/",
        auto_restart: true,
        panes: [{ id: "p1", slug: "cc-1", agent: "claude" }],
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(config));

      const result = readDmuxConfig("/test");
      expect(result).toEqual(config);
      expect(mockReadFileSync).toHaveBeenCalledWith(
        "/test/.dmux/dmux.config.json",
        "utf-8",
      );
    });

    it("returns null when file doesn't exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = readDmuxConfig("/nonexistent");
      expect(result).toBeNull();
    });

    it("returns null for corrupt JSON", () => {
      mockReadFileSync.mockReturnValue("not valid json{{{");

      const result = readDmuxConfig("/test");
      expect(result).toBeNull();
    });
  });

  describe("writeDmuxConfig", () => {
    it("writes config as formatted JSON", () => {
      const config = { session_name: "dmux-test", auto_restart: false };

      writeDmuxConfig("/test", config);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/test/.dmux/dmux.config.json",
        JSON.stringify(config, null, 2),
      );
    });
  });

  describe("updateDmuxConfig", () => {
    it("merges updates into existing config", () => {
      const existing = {
        session_name: "dmux-test",
        branch_prefix: "old/",
        panes: [{ id: "p1" }],
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(existing));

      const result = updateDmuxConfig("/test", { branch_prefix: "new/" });

      expect(result).toEqual({
        session_name: "dmux-test",
        branch_prefix: "new/",
        panes: [{ id: "p1" }],
      });
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("returns null when no existing config", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = updateDmuxConfig("/test", { branch_prefix: "new/" });
      expect(result).toBeNull();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });
});
