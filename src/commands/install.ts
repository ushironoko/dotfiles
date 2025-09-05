import { define } from "gunshi";
import { BackupManager } from "../core/backup-manager";
import { ConfigManager } from "../core/config-manager";
import { MCPMerger } from "../core/mcp-merger";
import { SymlinkManager } from "../core/symlink-manager";
import { fileExists, isSymlink } from "../utils/fs";
import { Logger } from "../utils/logger";

const NO_PATHS_TO_BACKUP = 0;
const EXIT_FAILURE = 1;

export const installCommand = define({
  name: "install",
  description: "Install dotfiles by creating symlinks",
  args: {
    config: {
      default: "./config/dotfiles.json",
      description: "Path to config file",
      short: "c",
      type: "string",
    },
    dryRun: {
      default: false,
      description: "Perform a dry run without making changes",
      short: "d",
      type: "boolean",
    },
    force: {
      default: false,
      description: "Force overwrite existing files",
      short: "f",
      type: "boolean",
    },
    verbose: {
      default: false,
      description: "Verbose output",
      short: "v",
      type: "boolean",
    },
  },
  run: async (ctx) => {
    const { dryRun, force, verbose, config } = ctx.values;

    const logger = new Logger(verbose, dryRun);
    
    try {
      logger.info("Starting dotfiles installation...");

      const configManager = new ConfigManager(config);
      await configManager.load();

      const backupConfig = configManager.getBackupConfig();
      const backupManager = new BackupManager(logger, backupConfig);

      const mappings = configManager.getMappings();
      const targetPaths = mappings.map(m => m.target);

      const pathsToBackup = [];
      for (const path of targetPaths) {
        if (await fileExists(path) && !(await isSymlink(path))) {
          pathsToBackup.push(path);
        }
      }

      if (NO_PATHS_TO_BACKUP < pathsToBackup.length) {
        logger.info("Creating backup of existing files...");
        await backupManager.createBackup(pathsToBackup, dryRun);
      }

      const symlinkManager = new SymlinkManager(logger);
      
      logger.info("Creating symlinks...");
      for (const mapping of mappings) {
        await symlinkManager.createFromMapping(mapping, { dryRun, force, verbose });
      }

      const mcpConfig = configManager.getMCPConfig();
      if (mcpConfig) {
        logger.info("Merging MCP server configuration...");
        const mcpMerger = new MCPMerger(logger, mcpConfig);
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