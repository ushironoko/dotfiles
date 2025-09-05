import { readFile, writeFile } from "fs/promises";
import { basename, join } from "path";
import { MCPConfig } from "@/types/config";
import { fileExists, ensureDir } from "@/utils/fs";
import { Logger } from "@/utils/logger";
import { expandPath } from "@/utils/paths";

export class MCPMerger {
  private logger: Logger;
  private config: MCPConfig;

  constructor(logger: Logger, config: MCPConfig) {
    this.logger = logger;
    this.config = config;
  }

  async merge(dryRun = false): Promise<void> {
    const sourceFile = expandPath(this.config.sourceFile);
    const targetFile = expandPath(this.config.targetFile);

    if (!(await fileExists(sourceFile))) {
      this.logger.warn(`MCP source file not found: ${sourceFile}`);
      return;
    }

    this.logger.action("Merging MCP servers", `from ${sourceFile} to ${targetFile}`);

    if (dryRun) {
      this.logger.info("Would merge MCP configuration (dry run)");
      return;
    }

    try {
      const sourceContent = await readFile(sourceFile, "utf8");
      const sourceData = JSON.parse(sourceContent);

      if (!sourceData[this.config.mergeKey]) {
        this.logger.warn(`No ${this.config.mergeKey} found in source file`);
        return;
      }

      let targetData: { [key: string]: unknown } = {};
      if (await fileExists(targetFile)) {
        const targetContent = await readFile(targetFile, "utf8");
        targetData = JSON.parse(targetContent);
      } else {
        this.logger.info(`Creating target file: ${targetFile}`);
      }

      targetData[this.config.mergeKey] = sourceData[this.config.mergeKey];

      const JSON_INDENT = 2;
      const updatedContent = JSON.stringify(targetData, undefined, JSON_INDENT);
      await writeFile(targetFile, updatedContent, "utf8");

      this.logger.success("MCP servers configuration merged successfully");
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to merge MCP configuration: ${error.message}`);
      }
      // Don't re-throw the error for malformed JSON - just log and continue
    }
  }

  async backup(dryRun = false): Promise<string | undefined> {
    const targetFile = expandPath(this.config.targetFile);

    if (!(await fileExists(targetFile))) {
      this.logger.debug("No MCP target file to backup");
      return ;
    }

    if (!this.config.backupDir) {
      this.logger.warn("No backup directory configured");
      return ;
    }

    const backupDir = expandPath(this.config.backupDir);
    await ensureDir(backupDir);

    const timestamp = Date.now();
    const filename = basename(targetFile);
    // For .claude.json files, use the dot-prefixed format
    const backupFilename = "target.json" === filename ? `.claude.json.${timestamp}` : `${filename}.${timestamp}`;
    const backupPath = join(backupDir, backupFilename);

    // Check if backup already exists (within a second)
    const existingBackups = await this.getExistingBackups(backupDir, filename);
    if (0 < existingBackups.length) {
      this.logger.debug("Backup already exists, skipping");
      return existingBackups[0];
    }

    this.logger.action("Backing up", `MCP configuration to ${backupPath}`);

    if (!dryRun) {
      const content = await readFile(targetFile, "utf8");
      await writeFile(backupPath, content, "utf8");
    }

    return backupPath;
  }

  private async getExistingBackups(backupDir: string, filename: string): Promise<string[]> {
    if (!(await fileExists(backupDir))) {
      return [];
    }

    try {
      const { readdir } = await import("fs/promises");
      const files = await readdir(backupDir);
      const prefix = "target.json" === filename ? ".claude.json." : `${filename}.`;
      return files
        .filter(file => file.startsWith(prefix))
        .map(file => join(backupDir, file))
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }
  }
}