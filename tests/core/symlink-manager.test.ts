import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSymlinkManager } from "../../src/core/symlink-manager";
import { createLogger } from "../../src/utils/logger";
import { fileExists } from "../../src/utils/fs";
import type { FileMapping } from "../../src/types/config";

describe("SymlinkManager", () => {
  let testDir: string;
  let sourceDir: string;
  let targetDir: string;
  let manager: ReturnType<typeof createSymlinkManager>;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `symlink-test-${Date.now()}`);
    sourceDir = join(testDir, "source");
    targetDir = join(testDir, "target");

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });

    logger = createLogger(false, false);
    manager = createSymlinkManager(logger);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("createSymlink", () => {
    it("should create symlink for file", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.writeFile(sourceFile, "content");

      await manager.createSymlink(sourceFile, targetFile, false);

      const stats = await fs.lstat(targetFile);
      expect(stats.isSymbolicLink()).toBe(true);

      const linkTarget = await fs.readlink(targetFile);
      expect(linkTarget).toBe(sourceFile);
    });

    it("should create symlink for directory", async () => {
      const sourceSubDir = join(sourceDir, "subdir");
      const targetSubDir = join(targetDir, "subdir");
      await fs.mkdir(sourceSubDir);
      await fs.writeFile(join(sourceSubDir, "file.txt"), "content");

      await manager.createSymlink(sourceSubDir, targetSubDir, false);

      const stats = await fs.lstat(targetSubDir);
      expect(stats.isSymbolicLink()).toBe(true);
    });

    it("should overwrite existing file when force is true", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.writeFile(sourceFile, "new content");
      await fs.writeFile(targetFile, "old content");

      await manager.createSymlink(sourceFile, targetFile, true);

      const stats = await fs.lstat(targetFile);
      expect(stats.isSymbolicLink()).toBe(true);
    });

    it("should not overwrite existing file when force is false", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.writeFile(sourceFile, "new content");
      await fs.writeFile(targetFile, "old content");

      await manager.createSymlink(sourceFile, targetFile, false);

      const stats = await fs.lstat(targetFile);
      expect(stats.isSymbolicLink()).toBe(false);

      const content = await fs.readFile(targetFile, "utf8");
      expect(content).toBe("old content");
    });

    it("should handle dry run mode", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.writeFile(sourceFile, "content");

      await manager.createSymlink(sourceFile, targetFile, false, true);

      expect(await fileExists(targetFile)).toBe(false);
    });
  });

  describe("createMultipleSymlinks", () => {
    it("should create multiple symlinks", async () => {
      const mappings = [
        {
          source: join(sourceDir, "file1.txt"),
          target: join(targetDir, "file1.txt"),
          type: "file" as const,
        },
        {
          source: join(sourceDir, "file2.txt"),
          target: join(targetDir, "file2.txt"),
          type: "file" as const,
        },
      ];

      await fs.writeFile(mappings[0].source, "content1");
      await fs.writeFile(mappings[1].source, "content2");

      await manager.createMultipleSymlinks(mappings, { force: false });

      for (const mapping of mappings) {
        const stats = await fs.lstat(mapping.target);
        expect(stats.isSymbolicLink()).toBe(true);
      }
    });

    it("should handle selective type mappings", async () => {
      const sourceSubDir = join(sourceDir, "config");
      const targetSubDir = join(targetDir, "config");

      await fs.mkdir(sourceSubDir);
      await fs.writeFile(join(sourceSubDir, "file1.txt"), "content1");
      await fs.writeFile(join(sourceSubDir, "file2.txt"), "content2");
      await fs.writeFile(join(sourceSubDir, "skip.txt"), "skip");

      const mapping = {
        source: sourceSubDir,
        target: targetSubDir,
        type: "selective" as const,
        files: ["file1.txt", "file2.txt"],
      };

      await manager.createMultipleSymlinks([mapping], { force: false });

      expect(await fileExists(join(targetSubDir, "file1.txt"))).toBe(true);
      expect(await fileExists(join(targetSubDir, "file2.txt"))).toBe(true);
      expect(await fileExists(join(targetSubDir, "skip.txt"))).toBe(false);
    });

    it("should set permissions when specified", async () => {
      const sourceFile = join(sourceDir, "script.sh");
      const targetFile = join(targetDir, "script.sh");
      await fs.writeFile(sourceFile, "#!/bin/bash\necho hello");

      const mapping = {
        source: sourceFile,
        target: targetFile,
        type: "file" as const,
        permissions: "755",
      };

      await manager.createMultipleSymlinks([mapping], { force: false });

      const stats = await fs.stat(targetFile);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe("755");
    });
  });

  describe("checkSymlinkStatus", () => {
    it("should return correct status for valid symlink", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.writeFile(sourceFile, "content");
      await fs.symlink(sourceFile, targetFile);

      const status = await manager.checkSymlinkStatus(targetFile, sourceFile);

      expect(status.exists).toBe(true);
      expect(status.isSymlink).toBe(true);
      expect(status.pointsToCorrectTarget).toBe(true);
      expect(status.targetExists).toBe(true);
    });

    it("should detect broken symlink", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");
      await fs.symlink(sourceFile, targetFile);

      const status = await manager.checkSymlinkStatus(targetFile, sourceFile);

      expect(status.exists).toBe(true);
      expect(status.isSymlink).toBe(true);
      expect(status.targetExists).toBe(false);
    });

    it("should detect incorrect symlink target", async () => {
      const sourceFile = join(sourceDir, "correct.txt");
      const wrongFile = join(sourceDir, "wrong.txt");
      const targetFile = join(targetDir, "test.txt");

      await fs.writeFile(sourceFile, "correct");
      await fs.writeFile(wrongFile, "wrong");
      await fs.symlink(wrongFile, targetFile);

      const status = await manager.checkSymlinkStatus(targetFile, sourceFile);

      expect(status.exists).toBe(true);
      expect(status.isSymlink).toBe(true);
      expect(status.pointsToCorrectTarget).toBe(false);
    });

    it("should handle non-existent target", async () => {
      const sourceFile = join(sourceDir, "test.txt");
      const targetFile = join(targetDir, "test.txt");

      const status = await manager.checkSymlinkStatus(targetFile, sourceFile);

      expect(status.exists).toBe(false);
      expect(status.isSymlink).toBe(false);
    });
  });

  describe("selective symlinks with permissions", () => {
    it("should apply permissions to source files in selective mapping", async () => {
      const configDir = join(sourceDir, "config");
      await fs.mkdir(configDir, { recursive: true });

      const scriptFile = join(configDir, "script.sh");
      await fs.writeFile(scriptFile, "#!/bin/bash\necho 'test'");

      const normalFile = join(configDir, "config.txt");
      await fs.writeFile(normalFile, "config content");

      const mapping: FileMapping = {
        source: configDir,
        target: join(targetDir, "config"),
        type: "selective",
        include: ["script.sh", "config.txt"],
        permissions: {
          "script.sh": "755",
        },
      };

      await manager.createFromMapping(mapping);

      // Check source file permissions (should be executable)
      const scriptStats = await fs.stat(scriptFile);
      const scriptMode = (scriptStats.mode & 0o777).toString(8);
      expect(scriptMode).toBe("755");

      // Check that normal file remains unchanged (permissions may vary based on umask)
      const normalStats = await fs.stat(normalFile);
      const normalMode = (normalStats.mode & 0o777).toString(8);
      // Normal file should not have execute permissions
      expect(normalMode).toMatch(/^6[46][46]$/);

      // Verify symlinks were created
      const targetScriptFile = join(targetDir, "config", "script.sh");
      const targetNormalFile = join(targetDir, "config", "config.txt");

      expect(
        await fs.lstat(targetScriptFile).then((s) => s.isSymbolicLink()),
      ).toBe(true);
      expect(
        await fs.lstat(targetNormalFile).then((s) => s.isSymbolicLink()),
      ).toBe(true);
    });
  });
});
