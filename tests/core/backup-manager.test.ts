import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBackupManager, type BackupManager } from "../../src/core/backup-manager";
import { createLogger } from "../../src/utils/logger";
import { fileExists } from "../../src/utils/fs";

describe("BackupManager", () => {
  let testDir: string;
  let sourceDir: string;
  let backupDir: string;
  let manager: BackupManager;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `backup-test-${Date.now()}`);
    sourceDir = join(testDir, "source");
    backupDir = join(testDir, "backups");
    
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    
    logger = createLogger(false, false);
    manager = createBackupManager(logger, { 
      directory: backupDir,
      keepLast: 3,
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("createBackup", () => {
    it("should create backup of files", async () => {
      const file1 = join(sourceDir, "file1.txt");
      const file2 = join(sourceDir, "file2.txt");
      await fs.writeFile(file1, "content1");
      await fs.writeFile(file2, "content2");
      
      const backupName = await manager.createBackup([file1, file2]);
      
      expect(backupName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      
      const backupPath = join(backupDir, backupName);
      expect(await fileExists(backupPath)).toBe(true);
      expect(await fileExists(join(backupPath, file1))).toBe(true);
      expect(await fileExists(join(backupPath, file2))).toBe(true);
    });

    it("should preserve directory structure in backup", async () => {
      const subDir = join(sourceDir, "subdir");
      await fs.mkdir(subDir);
      const file = join(subDir, "file.txt");
      await fs.writeFile(file, "content");
      
      const backupName = await manager.createBackup([file]);
      
      const backupPath = join(backupDir, backupName, file);
      expect(await fileExists(backupPath)).toBe(true);
      
      const content = await fs.readFile(backupPath, "utf8");
      expect(content).toBe("content");
    });

    it("should skip backup for non-existent files", async () => {
      const existingFile = join(sourceDir, "exists.txt");
      const nonExistentFile = join(sourceDir, "not-exists.txt");
      await fs.writeFile(existingFile, "content");
      
      const backupName = await manager.createBackup([existingFile, nonExistentFile]);
      
      const backupPath = join(backupDir, backupName);
      expect(await fileExists(join(backupPath, existingFile))).toBe(true);
      expect(await fileExists(join(backupPath, nonExistentFile))).toBe(false);
    });

    it("should handle dry run mode", async () => {
      const file = join(sourceDir, "file.txt");
      await fs.writeFile(file, "content");
      
      const backupName = await manager.createBackup([file], true);
      
      expect(backupName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      
      const backupPath = join(backupDir, backupName);
      expect(await fileExists(backupPath)).toBe(false);
    });
  });

  describe("listBackups", () => {
    it("should list all backups sorted by date", async () => {
      // Create mock backups with different timestamps
      const backup1 = "2024-01-01T10-00-00";
      const backup2 = "2024-01-02T10-00-00";
      const backup3 = "2024-01-03T10-00-00";
      
      await fs.mkdir(join(backupDir, backup1));
      await fs.mkdir(join(backupDir, backup2));
      await fs.mkdir(join(backupDir, backup3));
      
      const backups = await manager.listBackups();
      
      expect(backups).toHaveLength(3);
      expect(backups[0].name).toBe(backup3); // Most recent first
      expect(backups[1].name).toBe(backup2);
      expect(backups[2].name).toBe(backup1);
    });

    it("should include backup metadata", async () => {
      const backupName = "2024-01-01T10-00-00";
      const backupPath = join(backupDir, backupName);
      await fs.mkdir(backupPath);
      
      const file1 = join(backupPath, "file1.txt");
      const file2 = join(backupPath, "file2.txt");
      await fs.writeFile(file1, "content1");
      await fs.writeFile(file2, "content2");
      
      const backups = await manager.listBackups();
      
      expect(backups).toHaveLength(1);
      expect(backups[0].name).toBe(backupName);
      expect(backups[0].path).toBe(backupPath);
      expect(backups[0].date).toBeInstanceOf(Date);
    });

    it("should return empty array when no backups exist", async () => {
      const backups = await manager.listBackups();
      expect(backups).toEqual([]);
    });
  });

  describe("restoreBackup", () => {
    it("should restore files from backup", async () => {
      const backupName = "2024-01-01T10-00-00";
      const backupPath = join(backupDir, backupName);
      await fs.mkdir(backupPath, { recursive: true });
      
      const file1 = join(sourceDir, "file1.txt");
      const file2 = join(sourceDir, "file2.txt");
      const backupFile1 = join(backupPath, file1);
      const backupFile2 = join(backupPath, file2);
      
      await fs.mkdir(join(backupPath, sourceDir), { recursive: true });
      await fs.writeFile(backupFile1, "backup1");
      await fs.writeFile(backupFile2, "backup2");
      
      await manager.restoreBackup(backupName);
      
      expect(await fileExists(file1)).toBe(true);
      expect(await fileExists(file2)).toBe(true);
      
      const content1 = await fs.readFile(file1, "utf8");
      const content2 = await fs.readFile(file2, "utf8");
      expect(content1).toBe("backup1");
      expect(content2).toBe("backup2");
    });

    it("should restore specific files when target paths provided", async () => {
      const backupName = "2024-01-01T10-00-00";
      const backupPath = join(backupDir, backupName);
      
      const file1 = join(sourceDir, "file1.txt");
      const file2 = join(sourceDir, "file2.txt");
      const backupFile1 = join(backupPath, file1);
      const backupFile2 = join(backupPath, file2);
      
      await fs.mkdir(join(backupPath, sourceDir), { recursive: true });
      await fs.writeFile(backupFile1, "backup1");
      await fs.writeFile(backupFile2, "backup2");
      
      await manager.restoreBackup(backupName, [file1]);
      
      expect(await fileExists(file1)).toBe(true);
      expect(await fileExists(file2)).toBe(false);
    });

    it("should throw error for non-existent backup", async () => {
      await expect(manager.restoreBackup("non-existent")).rejects.toThrow();
    });

    it("should handle dry run mode", async () => {
      const backupName = "2024-01-01T10-00-00";
      const backupPath = join(backupDir, backupName);
      
      const file = join(sourceDir, "file.txt");
      const backupFile = join(backupPath, file);
      
      await fs.mkdir(join(backupPath, sourceDir), { recursive: true });
      await fs.writeFile(backupFile, "backup");
      
      await manager.restoreBackup(backupName, undefined, true);
      
      expect(await fileExists(file)).toBe(false);
    });
  });

  describe("cleanOldBackups", () => {
    it("should keep only specified number of recent backups", async () => {
      const backups = [
        "2024-01-01T10-00-00",
        "2024-01-02T10-00-00",
        "2024-01-03T10-00-00",
        "2024-01-04T10-00-00",
        "2024-01-05T10-00-00",
      ];
      
      for (const backup of backups) {
        await fs.mkdir(join(backupDir, backup));
      }
      
      await manager.cleanOldBackups(false);
      
      const remaining = await manager.listBackups();
      expect(remaining).toHaveLength(3);
      expect(remaining.map(b => b.name)).toEqual([
        "2024-01-05T10-00-00",
        "2024-01-04T10-00-00",
        "2024-01-03T10-00-00",
      ]);
    });

    it("should not delete backups when under limit", async () => {
      const backups = ["2024-01-01T10-00-00", "2024-01-02T10-00-00"];
      
      for (const backup of backups) {
        await fs.mkdir(join(backupDir, backup));
      }
      
      await manager.cleanOldBackups(false);
      
      const remaining = await manager.listBackups();
      expect(remaining).toHaveLength(2);
    });

    it("should handle dry run mode", async () => {
      const backups = [
        "2024-01-01T10-00-00",
        "2024-01-02T10-00-00",
        "2024-01-03T10-00-00",
        "2024-01-04T10-00-00",
      ];
      
      for (const backup of backups) {
        await fs.mkdir(join(backupDir, backup));
      }
      
      await manager.cleanOldBackups(true);
      
      const remaining = await manager.listBackups();
      expect(remaining).toHaveLength(4);
    });
  });
});