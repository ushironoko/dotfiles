import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestDirectory,
  cleanupTestDirectory,
  createTestLogger,
  createTestFile,
  createTestSymlink,
} from "./test-helpers";

describe("test-helpers", () => {
  let testDir: string;

  describe("setupTestDirectory", () => {
    it("should create a unique temporary directory", async () => {
      const dir1 = await setupTestDirectory("test1");
      const dir2 = await setupTestDirectory("test2");

      expect(dir1).not.toBe(dir2);
      expect(existsSync(dir1)).toBe(true);
      expect(existsSync(dir2)).toBe(true);

      // Cleanup
      await cleanupTestDirectory(dir1);
      await cleanupTestDirectory(dir2);
    });

    it("should create subdirectories if specified", async () => {
      testDir = await setupTestDirectory("test", ["sub1", "sub2/nested"]);

      expect(existsSync(join(testDir, "sub1"))).toBe(true);
      expect(existsSync(join(testDir, "sub2", "nested"))).toBe(true);

      await cleanupTestDirectory(testDir);
    });
  });

  describe("cleanupTestDirectory", () => {
    it("should remove directory and all contents", async () => {
      testDir = await setupTestDirectory("cleanup-test");
      await createTestFile(join(testDir, "test.txt"), "content");

      expect(existsSync(testDir)).toBe(true);
      await cleanupTestDirectory(testDir);
      expect(existsSync(testDir)).toBe(false);
    });

    it("should handle non-existent directory gracefully", async () => {
      // Should not throw
      await cleanupTestDirectory("/non/existent/path");
      expect(true).toBe(true); // Test passes if we reach here
    });
  });

  describe("createTestLogger", () => {
    it("should create a logger with default settings", () => {
      const logger = createTestLogger();

      expect(logger).toHaveProperty("info");
      expect(logger).toHaveProperty("error");
      expect(logger).toHaveProperty("warn");
      expect(logger).toHaveProperty("success");
      expect(logger).toHaveProperty("debug");
      expect(logger).toHaveProperty("action");
    });

    it("should respect verbose and dryRun options", () => {
      const logger1 = createTestLogger({ verbose: true });
      const logger2 = createTestLogger({ dryRun: true });

      expect(logger1).toBeDefined();
      expect(logger2).toBeDefined();
    });
  });

  describe("createTestFile", () => {
    beforeEach(async () => {
      testDir = await setupTestDirectory("file-test");
    });

    afterEach(async () => {
      await cleanupTestDirectory(testDir);
    });

    it("should create a file with content", async () => {
      const filePath = join(testDir, "test.txt");
      await createTestFile(filePath, "test content");

      expect(existsSync(filePath)).toBe(true);
      const content = await import("node:fs").then((fs) =>
        fs.promises.readFile(filePath, "utf8"),
      );
      expect(content).toBe("test content");
    });

    it("should create nested directories if needed", async () => {
      const filePath = join(testDir, "nested", "deep", "test.txt");
      await createTestFile(filePath, "content");

      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("createTestSymlink", () => {
    beforeEach(async () => {
      testDir = await setupTestDirectory("symlink-test");
    });

    afterEach(async () => {
      await cleanupTestDirectory(testDir);
    });

    it("should create a symlink to target", async () => {
      const target = join(testDir, "target.txt");
      const link = join(testDir, "link.txt");

      await createTestFile(target, "content");
      await createTestSymlink(target, link);

      expect(existsSync(link)).toBe(true);
      const content = await import("node:fs").then((fs) =>
        fs.promises.readFile(link, "utf8"),
      );
      expect(content).toBe("content");
    });
  });
});
