import { readFile, writeFile, readdir } from "fs/promises";
import { basename, join } from "path";
import { createDefu } from "defu";
import { MCPConfig } from "../types/config.js";
import { fileExists, ensureDir } from "../utils/fs.js";
import { Logger } from "../utils/logger.js";
import { expandPath } from "../utils/paths.js";

// Type definitions for MCP data structures
interface MCPServerObject {
  command: string;
  args?: string[];
  env?: { [key: string]: string };
  type?: string;
}

interface MCPServersObject {
  [key: string]: MCPServerObject;
}

type MCPServersArray = {
  name?: string;
  command?: string;
  args?: string[];
  env?: { [key: string]: string };
}[];

interface MCPConfigData {
  mcpServers?: MCPServersObject | MCPServersArray;
  [key: string]: unknown;
}

export const createMCPMerger = (logger: Logger, config: MCPConfig) => {
  // Custom merge function for MCP configurations
  // Using generic function to satisfy defu's Merger type requirements
  const mergeMCPConfig = createDefu(
    <T extends MCPConfigData>(obj: T, key: keyof T, value: T[keyof T]) => {
      // Handle mcpServers merging with proper type guards
      if (
        key === config.mergeKey &&
        value !== null &&
        value !== undefined &&
        typeof value === "object"
      ) {
        // For object-style mcpServers (current implementation) - replace entirely
        if (!Array.isArray(value)) {
          // Replace the entire mcpServers object rather than merging
          obj[key] = value;
          return true;
        }

        // For array-style mcpServers (future compatibility)
        if (Array.isArray(obj[key]) && Array.isArray(value)) {
          const existingServers = obj[key] as MCPServersArray;
          const newServers = value as MCPServersArray;

          // Prevent duplicates based on name or command property
          const existingIdentifiers = new Set(
            existingServers.map((server) => server.name || server.command),
          );

          const uniqueNewServers = newServers.filter(
            (server) => !existingIdentifiers.has(server.name || server.command),
          );

          // TypeScript requires explicit type assertion here due to generic constraints
          obj["mcpServers"] = [...existingServers, ...uniqueNewServers];
          return true;
        }
      }
      return false;
    },
  );
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
        filename === "target.json" ? ".claude.json." : `${filename}.`;
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

      let targetData: MCPConfigData = {};
      if (await fileExists(targetFile)) {
        const targetContent = await readFile(targetFile, "utf8");
        targetData = JSON.parse(targetContent);
      } else {
        logger.info(`Creating target file: ${targetFile}`);
      }

      const mergedData = mergeMCPConfig(
        { [config.mergeKey]: sourceData[config.mergeKey] },
        targetData,
      );

      const JSON_INDENT = 2;
      const updatedContent = JSON.stringify(mergedData, undefined, JSON_INDENT);
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
      filename === "target.json"
        ? `.claude.json.${timestamp}`
        : `${filename}.${timestamp}`;
    const backupPath = join(backupDir, backupFilename);

    // Check if backup already exists (within a second)
    const existingBackups = await getExistingBackups(backupDir, filename);
    if (existingBackups.length > 0) {
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
