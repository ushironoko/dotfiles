import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { fileExists, ensureDir } from "../utils/fs.js";
import { Logger } from "../utils/logger.js";
import { getDotfilesDir } from "../utils/paths.js";
import { colors } from "consola/utils";

// MCPDoc source interface
interface MCPDocSource {
  name: string;
  llms_txt: string;
  description?: string;
}

const MCPDOC_SOURCES_FILE = "config/mcpdoc/mcpdoc-sources.json";

export const createMCPDocManager = async (logger: Logger, testDir?: string) => {
  // Use repository path or test directory
  const baseDir = testDir || getDotfilesDir();
  const sourcesFile = join(baseDir, MCPDOC_SOURCES_FILE);
  const configDir = join(baseDir, "config/mcpdoc");

  // Ensure config directory exists
  await ensureDir(configDir);

  const readSources = async (): Promise<MCPDocSource[]> => {
    if (!(await fileExists(sourcesFile))) {
      return [];
    }

    try {
      const content = await readFile(sourcesFile, "utf8");
      const sources = JSON.parse(content);

      // Validate the structure
      if (!Array.isArray(sources)) {
        logger.warn("Invalid sources file format, resetting to empty array");
        return [];
      }

      return sources.filter((source): source is MCPDocSource => {
        return (
          typeof source === "object" &&
          source !== null &&
          typeof source.name === "string" &&
          typeof source.llms_txt === "string" &&
          source.name.length > 0 &&
          source.name.length <= 100 &&
          source.llms_txt.length > 0 &&
          source.llms_txt.length <= 2048 &&
          // Validate URL is HTTPS
          (() => {
            try {
              const url = new URL(source.llms_txt);
              return url.protocol === "https:";
            } catch {
              return false;
            }
          })()
        );
      });
    } catch (error) {
      logger.error(`Failed to read sources file: ${sourcesFile}`);
      if (error instanceof Error) {
        logger.error(error.message);
      }
      return [];
    }
  };

  const writeSources = async (
    sources: MCPDocSource[],
    dryRun: boolean,
  ): Promise<void> => {
    if (dryRun) {
      logger.info(
        `[Dry Run] Would write ${sources.length} source(s) to ${sourcesFile}`,
      );
      logger.debug("Sources to write:");
      sources.forEach((source) => {
        logger.debug(`  - ${source.name}: ${source.llms_txt}`);
      });
      return;
    }

    try {
      const content = JSON.stringify(sources, undefined, 2);
      await writeFile(sourcesFile, content, "utf8");
      logger.success(`Updated sources file: ${sourcesFile}`);
    } catch (error) {
      logger.error(`Failed to write sources file: ${sourcesFile}`);
      if (error instanceof Error) {
        logger.error(error.message);
      }
      throw error;
    }
  };

  return {
    /**
     * Get all configured MCPDoc sources
     */
    getSources: async (): Promise<MCPDocSource[]> => {
      return readSources();
    },

    /**
     * Add a new MCPDoc source
     */
    addSource: async (
      name: string,
      url: string,
      dryRun: boolean,
    ): Promise<void> => {
      // Validate name (prevent path traversal and special characters)
      if (name.length === 0 || name.length > 100) {
        logger.error("Source name must be between 1 and 100 characters");
        return;
      }

      // Only allow alphanumeric, spaces, hyphens, and underscores
      const namePattern = /^[a-zA-Z0-9\s\-_]+$/;
      if (!namePattern.test(name)) {
        logger.error(
          "Source name can only contain letters, numbers, spaces, hyphens, and underscores",
        );
        return;
      }

      // Validate URL length
      if (url.length > 2048) {
        logger.error("URL must not exceed 2048 characters");
        return;
      }

      const sources = await readSources();

      // Check for duplicates
      const existingByName = sources.find((s) => s.name === name);
      if (existingByName) {
        logger.warn(`Source with name "${name}" already exists`);
        logger.info(`Current URL: ${existingByName.llms_txt}`);

        if (existingByName.llms_txt !== url) {
          logger.info(`New URL: ${url}`);
          logger.info(
            "Use a different name or remove the existing source first",
          );
        }
        return;
      }

      const existingByUrl = sources.find((s) => s.llms_txt === url);
      if (existingByUrl) {
        logger.warn(`URL already configured with name "${existingByUrl.name}"`);
        return;
      }

      // Add new source
      const newSource: MCPDocSource = {
        name,
        llms_txt: url,
      };

      sources.push(newSource);
      await writeSources(sources, dryRun);

      if (!dryRun) {
        logger.success(`Added documentation source: ${colors.bold(name)}`);
        logger.info(`  URL: ${url}`);
        logger.info(
          `\nRun '${colors.yellow("dotfiles install")}' to apply the configuration`,
        );
      } else {
        logger.info(
          `[Dry Run] Would add documentation source: ${colors.bold(name)}`,
        );
        logger.info(`  URL: ${url}`);
      }
    },

    /**
     * Remove an MCPDoc source by name
     */
    removeSource: async (name: string, dryRun: boolean): Promise<void> => {
      const sources = await readSources();

      const filteredSources = sources.filter((s) => s.name !== name);

      if (filteredSources.length === sources.length) {
        logger.warn(`Source "${name}" not found`);
        return;
      }

      await writeSources(filteredSources, dryRun);

      if (!dryRun) {
        logger.success(`Removed documentation source: ${colors.bold(name)}`);
        logger.info(
          `\nRun '${colors.yellow("dotfiles install")}' to apply the configuration`,
        );
      } else {
        logger.info(
          `[Dry Run] Would remove documentation source: ${colors.bold(name)}`,
        );
      }
    },

    /**
     * Get the sources file path
     */
    getSourcesFilePath: (): string => {
      return sourcesFile;
    },

    /**
     * Check if the mcpdoc config directory exists
     */
    configExists: async (): Promise<boolean> => {
      return fileExists(sourcesFile);
    },
  };
};

export type { MCPDocSource };
