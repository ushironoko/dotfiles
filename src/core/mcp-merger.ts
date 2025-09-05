import { readFile, writeFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { MCPConfig } from "../types/config";
import { fileExists, ensureDir } from "../utils/fs";
import { Logger } from "../utils/logger";
import { expandPath } from "../utils/paths";

export const createMCPMerger = (logger: Logger, config: MCPConfig) => {
  const getExistingBackups = async (
    backupDir: string,
    filename: string,
  ): Promise<string[]> => {
    if (!(await fileExists(backupDir))) {
      return [];
    }

    try {
      const files = await readdir(backupDir);
      const prefix =
        "target.json" === filename ? ".claude.json." : `${filename}.`;
      return files
        .filter((file) => file.startsWith(prefix))
        .map((file) => join(backupDir, file))
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }
  };

  const merge = async (dryRun = false): Promise<void> => {
    const sourceFile = expandPath(config.sourceFile);
    const targetFile = expandPath(config.targetFile);

    if (!(await fileExists(sourceFile))) {
      logger.warn(`MCP source file not found: ${sourceFile}`);
      return;
    }

    logger.action("Merging MCP servers", `from ${sourceFile} to ${targetFile}`);

    if (dryRun) {
      logger.info("Would merge MCP configuration (dry run)");
      return;
    }

    try {
      const sourceContent = await readFile(sourceFile, "utf8");
      const sourceData = JSON.parse(sourceContent);

      if (!sourceData[config.mergeKey]) {
        logger.warn(`No ${config.mergeKey} found in source file`);
        return;
      }

      let targetData: { [key: string]: unknown } = {};
      if (await fileExists(targetFile)) {
        const targetContent = await readFile(targetFile, "utf8");
        targetData = JSON.parse(targetContent);
      } else {
        logger.info(`Creating target file: ${targetFile}`);
      }

      targetData[config.mergeKey] = sourceData[config.mergeKey];

      const JSON_INDENT = 2;
      const updatedContent = JSON.stringify(targetData, undefined, JSON_INDENT);
      await writeFile(targetFile, updatedContent, "utf8");

      logger.success("MCP servers configuration merged successfully");
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Failed to merge MCP configuration: ${error.message}`);
      }
      // Don't re-throw the error for malformed JSON - just log and continue
    }
  };

  const backup = async (dryRun = false): Promise<string | undefined> => {
    const targetFile = expandPath(config.targetFile);

    if (!(await fileExists(targetFile))) {
      logger.debug("No MCP target file to backup");
      return;
    }

    if (!config.backupDir) {
      logger.warn("No backup directory configured");
      return;
    }

    const backupDir = expandPath(config.backupDir);
    await ensureDir(backupDir);

    const timestamp = Date.now();
    const filename = basename(targetFile);
    // For .claude.json files, use the dot-prefixed format
    const backupFilename =
      "target.json" === filename
        ? `.claude.json.${timestamp}`
        : `${filename}.${timestamp}`;
    const backupPath = join(backupDir, backupFilename);

    // Check if backup already exists (within a second)
    const existingBackups = await getExistingBackups(backupDir, filename);
    if (0 < existingBackups.length) {
      logger.debug("Backup already exists, skipping");
      return existingBackups[0];
    }

    logger.action("Backing up", `MCP configuration to ${backupPath}`);

    if (!dryRun) {
      const content = await readFile(targetFile, "utf8");
      await writeFile(backupPath, content, "utf8");
    }

    return backupPath;
  };

  return {
    merge,
    backup,
  };
};

export type MCPMerger = ReturnType<typeof createMCPMerger>;
