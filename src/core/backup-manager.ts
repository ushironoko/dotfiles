import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { BackupConfig, BackupInfo } from "@/types/config";
import { 
  copyRecursive,
  ensureDir,
  fileExists, 
  removeRecursive 
} from "@/utils/fs";
import { Logger } from "@/utils/logger";
import { expandPath, getRelativePath } from "@/utils/paths";

const SLICE_START = 0;
const TIMESTAMP_LENGTH = 19;

export class BackupManager {
  private logger: Logger;
  private config: BackupConfig;

  constructor(logger: Logger, config: BackupConfig) {
    this.logger = logger;
    this.config = config;
  }

  async createBackup(paths: string[], dryRun = false): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(SLICE_START, TIMESTAMP_LENGTH);
    const backupDir = join(this.config.directory, timestamp);
    
    this.logger.info(`Creating backup in ${backupDir}`);
    
    if (!dryRun) {
      await ensureDir(backupDir);
    }

    for (const path of paths) {
      await this.backupFile(path, backupDir, dryRun);
    }

    await this.cleanOldBackups(dryRun);
    
    return timestamp;
  }

  private async backupFile(
    sourcePath: string, 
    backupDir: string,
    dryRun: boolean
  ): Promise<void> {
    const expandedSource = expandPath(sourcePath);
    
    if (!(await fileExists(expandedSource))) {
      this.logger.debug(`Skipping backup - file not found: ${expandedSource}`);
      return;
    }

    const homePath = expandPath("~");
    const relativePath = getRelativePath(expandedSource, homePath);
    const backupPath = join(backupDir, relativePath);

    this.logger.action("Backing up", `${expandedSource} -> ${backupPath}`);
    
    if (!dryRun) {
      await copyRecursive(expandedSource, backupPath);
    }
  }

  async listBackups(): Promise<BackupInfo[]> {
    const backupBaseDir = expandPath(this.config.directory);
    
    if (!(await fileExists(backupBaseDir))) {
      return [];
    }

    const entries = await readdir(backupBaseDir, { withFileTypes: true });
    const backups: BackupInfo[] = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const backupPath = join(backupBaseDir, entry.name);
        
        // Parse date from directory name (format: 2024-01-01T10-00-00)
        const dateStr = entry.name.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
        const date = new Date(dateStr);
        
        backups.push({
          name: entry.name,
          path: backupPath,
          date,
        });
      }
    }
    
    // Sort by date, most recent first
    backups.sort((a, b) => b.date.getTime() - a.date.getTime());

    return backups;
  }

  async restoreBackup(
    backupName: string,
    targetPaths?: string[],
    dryRun = false
  ): Promise<void> {
    const backupDir = join(this.config.directory, backupName);
    const expandedBackupDir = expandPath(backupDir);

    if (!(await fileExists(expandedBackupDir))) {
      throw new Error(`Backup not found: ${backupName}`);
    }

    this.logger.info(`Restoring from backup: ${backupName}`);
    
    const files = await this.getBackupFiles(expandedBackupDir);
    
    for (const file of files) {
      if (targetPaths) {
        const fullFilePath = file.startsWith("tmp/") || file.startsWith("var/") || file.startsWith("usr/") || file.startsWith("home/") || file.startsWith("opt/") 
          ? `/${file}` 
          : join(expandPath("~"), file);
        
        const shouldInclude = targetPaths.some(path => 
          fullFilePath === path || fullFilePath.includes(path) || file.includes(path)
        );
        
        if (!shouldInclude) {
          continue;
        }
      }

      const sourcePath = join(expandedBackupDir, file);
      // If file starts with known temp/absolute prefix, restore to original location
      // Otherwise, restore relative to home
      const targetPath = file.startsWith("tmp/") || file.startsWith("var/") || file.startsWith("usr/") || file.startsWith("home/") || file.startsWith("opt/") 
        ? `/${file}` 
        : join(expandPath("~"), file);

      this.logger.action("Restoring", `${file} -> ${targetPath}`);
      
      if (!dryRun) {
        await ensureDir(dirname(targetPath));
        await copyRecursive(sourcePath, targetPath);
      }
    }

    this.logger.success("Restore completed");
  }

  private async getBackupFiles(backupDir: string, basePath = ""): Promise<string[]> {
    const fullPath = join(backupDir, basePath);
    const entries = await readdir(fullPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = join(basePath, entry.name);
      
      if (entry.isDirectory()) {
        const subFiles = await this.getBackupFiles(backupDir, entryPath);
        files.push(...subFiles);
      } else {
        files.push(entryPath);
      }
    }

    return files;
  }

  async cleanOldBackups(dryRun = false): Promise<void> {
    const backups = await this.listBackups();
    
    if (this.config.keepLast && backups.length > this.config.keepLast) {
      const toDelete = backups.slice(this.config.keepLast);
      
      for (const backup of toDelete) {
        this.logger.action("Removing old backup", backup.name);
        
        if (!dryRun) {
          await removeRecursive(backup.path);
        }
      }
    }
  }

  getBackupDirectory(): string {
    return this.config.directory;
  }
}