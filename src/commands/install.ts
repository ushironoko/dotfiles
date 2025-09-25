import { createBackupManager } from "../core/backup-manager.js";
import { createConfigManager } from "../core/config-manager.js";
import {
  confirmMappingSelection,
  selectMappings,
} from "../core/interactive-selector.js";
import { createMCPMerger } from "../core/mcp-merger.js";
import { createSymlinkManager } from "../core/symlink-manager.js";
import {
  EXIT_FAILURE,
  dryRunArg,
  forceArg,
  selectArg,
} from "../types/command.js";
import type { FileMapping } from "../types/config.js";
import { fileExists, isSymlink } from "../utils/fs.js";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../utils/command-helpers.js";

const NO_PATHS_TO_BACKUP = 0;

const installCommand = define({
  name: "install",
  description: "Install dotfiles by creating symlinks",
  args: {
    ...baseCommandArgs,
    ...dryRunArg,
    ...forceArg,
    ...selectArg,
  },
  run: async (ctx) => {
    const { dryRun, force, verbose, config, select } = ctx.values;

    const { logger } = createCommandContext({ verbose, dryRun });

    try {
      logger.info("Starting dotfiles installation...");

      const configManager = await createConfigManager(config);

      const backupConfig = configManager.getBackupConfig();
      const backupManager = createBackupManager(logger, backupConfig);

      let mappings = configManager.getMappings();

      // 対話型選択モード
      let deselectedMappings: FileMapping[] = [];
      if (select) {
        const result = await selectMappings(mappings, logger);
        if (result === undefined) {
          // キャンセルされた
          process.exit(EXIT_FAILURE);
        }
        mappings = result.selected;
        deselectedMappings = result.deselected;

        if (mappings.length > 0 || deselectedMappings.length > 0) {
          const confirmed = await confirmMappingSelection(result, logger);
          if (!confirmed) {
            process.exit(EXIT_FAILURE);
          }
        }
      }
      const targetPaths = mappings.map((mapping) => mapping.target);

      const pathsToBackup = [];
      for (const path of targetPaths) {
        if ((await fileExists(path)) && !(await isSymlink(path))) {
          pathsToBackup.push(path);
        }
      }

      if (pathsToBackup.length > NO_PATHS_TO_BACKUP) {
        logger.info("Creating backup of existing files...");
        await backupManager.createBackup(pathsToBackup, dryRun);
      }

      const symlinkManager = createSymlinkManager(logger);

      // Remove deselected symlinks first
      if (deselectedMappings.length > 0) {
        logger.info("Removing deselected symlinks...");
        await symlinkManager.removeMultipleSymlinks(deselectedMappings, dryRun);
      }

      // Create selected symlinks
      if (mappings.length > 0) {
        logger.info("Creating symlinks...");
        for (const mapping of mappings) {
          await symlinkManager.createFromMapping(mapping, {
            dryRun,
            force,
            verbose,
          });
        }
      }

      const mcpConfig = configManager.getMCPConfig();
      if (mcpConfig) {
        logger.info("Merging MCP server configuration...");
        const mcpMerger = createMCPMerger(logger, mcpConfig);
        await mcpMerger.merge(dryRun);
      }

      logger.success("Dotfiles installation complete!");

      if (dryRun) {
        logger.info("This was a dry run - no changes were made");
      } else {
        logger.info("To reload your shell configuration, run:");
        logger.info("  source ~/.bashrc  # for Bash");
        logger.info("  source ~/.zshrc   # for Zsh");
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Installation failed: ${error.message}`);
      }
      process.exit(EXIT_FAILURE);
    }
  },
});

export { installCommand };
