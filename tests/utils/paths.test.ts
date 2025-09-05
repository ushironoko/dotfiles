import { homedir } from "os";
import { dirname } from "path";
import { describe, expect, it } from "bun:test";
import {
  ensureParentDir,
  expandPath,
  getRelativePath,
} from "../../src/utils/paths";

describe("paths utilities", () => {
  describe("expandPath", () => {
    it("should expand tilde to home directory", () => {
      const expanded = expandPath("~/test/file.txt");
      expect(expanded).toBe(`${homedir()}/test/file.txt`);
    });

    it("should return absolute paths unchanged", () => {
      const absolute = "/usr/local/bin";
      expect(expandPath(absolute)).toBe(absolute);
    });

    it("should resolve relative paths", () => {
      const expanded = expandPath("./test");
      expect(expanded).toContain("/test");
      expect(expanded).not.toContain("./");
    });
  });

  describe("getRelativePath", () => {
    it("should return relative path from base", () => {
      const fullPath = `${homedir()}/documents/file.txt`;
      const basePath = homedir();
      const relative = getRelativePath(fullPath, basePath);
      expect(relative).toBe("documents/file.txt");
    });

    it("should handle paths with tilde", () => {
      const fullPath = "~/documents/file.txt";
      const basePath = "~";
      const relative = getRelativePath(fullPath, basePath);
      expect(relative).toBe("documents/file.txt");
    });

    it("should return full path if not under base", () => {
      const fullPath = "/usr/local/bin";
      const basePath = "/home/user";
      const relative = getRelativePath(fullPath, basePath);
      expect(relative).toBe("/usr/local/bin");
    });
  });

  describe("ensureParentDir", () => {
    it("should return parent directory path", () => {
      const filePath = "~/test/file.txt";
      const parent = ensureParentDir(filePath);
      expect(parent).toBe(dirname(expandPath(filePath)));
    });

    it("should handle absolute paths", () => {
      const filePath = "/usr/local/bin/script";
      const parent = ensureParentDir(filePath);
      expect(parent).toBe("/usr/local/bin");
    });
  });
});
