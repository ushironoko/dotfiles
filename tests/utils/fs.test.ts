import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  fileExists,
  ensureDir,
  copyRecursive,
  removeRecursive,
  isSymlink,
  readDir,
} from "../../src/utils/fs";

describe("fs utilities", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `fs-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("fileExists", () => {
    it("should return true for existing file", async () => {
      const filePath = join(testDir, "test.txt");
      await fs.writeFile(filePath, "test");
      expect(await fileExists(filePath)).toBe(true);
    });

    it("should return false for non-existing file", async () => {
      const filePath = join(testDir, "non-existent.txt");
      expect(await fileExists(filePath)).toBe(false);
    });

    it("should return true for existing directory", async () => {
      expect(await fileExists(testDir)).toBe(true);
    });
  });

  describe("ensureDir", () => {
    it("should create directory if it doesn't exist", async () => {
      const newDir = join(testDir, "new-dir");
      await ensureDir(newDir);
      const stats = await fs.stat(newDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it("should not throw if directory already exists", async () => {
      const newDir = join(testDir, "existing-dir");
      await fs.mkdir(newDir);
      await ensureDir(newDir);
      expect(await fileExists(newDir)).toBe(true);
    });

    it("should create nested directories", async () => {
      const nestedDir = join(testDir, "a", "b", "c");
      await ensureDir(nestedDir);
      const stats = await fs.stat(nestedDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("copyRecursive", () => {
    it("should copy single file", async () => {
      const srcFile = join(testDir, "source.txt");
      const destFile = join(testDir, "dest.txt");
      await fs.writeFile(srcFile, "content");

      await copyRecursive(srcFile, destFile);

      const content = await fs.readFile(destFile, "utf8");
      expect(content).toBe("content");
    });

    it("should copy directory recursively", async () => {
      const srcDir = join(testDir, "src");
      const destDir = join(testDir, "dest");

      await fs.mkdir(join(srcDir, "sub"), { recursive: true });
      await fs.writeFile(join(srcDir, "file1.txt"), "file1");
      await fs.writeFile(join(srcDir, "sub", "file2.txt"), "file2");

      await copyRecursive(srcDir, destDir);

      expect(await fileExists(join(destDir, "file1.txt"))).toBe(true);
      expect(await fileExists(join(destDir, "sub", "file2.txt"))).toBe(true);
    });

    it("should throw error for non-existent source", async () => {
      const srcFile = join(testDir, "non-existent.txt");
      const destFile = join(testDir, "dest.txt");

      await expect(copyRecursive(srcFile, destFile)).rejects.toThrow();
    });
  });

  describe("removeRecursive", () => {
    it("should remove single file", async () => {
      const filePath = join(testDir, "file.txt");
      await fs.writeFile(filePath, "content");

      await removeRecursive(filePath);

      expect(await fileExists(filePath)).toBe(false);
    });

    it("should remove directory recursively", async () => {
      const dirPath = join(testDir, "dir");
      await fs.mkdir(join(dirPath, "sub"), { recursive: true });
      await fs.writeFile(join(dirPath, "file.txt"), "content");

      await removeRecursive(dirPath);

      expect(await fileExists(dirPath)).toBe(false);
    });

    it("should not throw for non-existent path", async () => {
      const nonExistentPath = join(testDir, "non-existent");
      await removeRecursive(nonExistentPath);
      expect(await fileExists(nonExistentPath)).toBe(false);
    });
  });

  describe("isSymlink", () => {
    it("should return true for symlink", async () => {
      const targetFile = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");
      await fs.writeFile(targetFile, "content");
      await fs.symlink(targetFile, linkPath);

      expect(await isSymlink(linkPath)).toBe(true);
    });

    it("should return false for regular file", async () => {
      const filePath = join(testDir, "regular.txt");
      await fs.writeFile(filePath, "content");

      expect(await isSymlink(filePath)).toBe(false);
    });

    it("should return false for non-existent path", async () => {
      const nonExistentPath = join(testDir, "non-existent");
      expect(await isSymlink(nonExistentPath)).toBe(false);
    });
  });

  describe("readDir", () => {
    it("should list directory contents", async () => {
      await fs.writeFile(join(testDir, "file1.txt"), "content1");
      await fs.writeFile(join(testDir, "file2.txt"), "content2");
      await fs.mkdir(join(testDir, "subdir"));

      const entries = await readDir(testDir);

      expect(entries).toHaveLength(3);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["file1.txt", "file2.txt", "subdir"]);
    });

    it("should include file type information", async () => {
      await fs.writeFile(join(testDir, "file.txt"), "content");
      await fs.mkdir(join(testDir, "dir"));

      const entries = await readDir(testDir);

      const fileEntry = entries.find((e) => e.name === "file.txt");
      const dirEntry = entries.find((e) => e.name === "dir");

      expect(fileEntry?.isFile()).toBe(true);
      expect(fileEntry?.isDirectory()).toBe(false);
      expect(dirEntry?.isDirectory()).toBe(true);
      expect(dirEntry?.isFile()).toBe(false);
    });
  });
});
