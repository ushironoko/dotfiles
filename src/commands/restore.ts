import { createInterface } from "readline";
import { define } from "gunshi";
import { BackupManager } from "@/core/backup-manager";
import { ConfigManager } from "@/core/config-manager";
import { Logger } from "@/utils/logger";

const NO_BACKUPS_FOUND = 0;
const EXIT_FAILURE = 1;
const INDEX_OFFSET = 1;
const SLASH_COUNT_THRESHOLD = 3;

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

export const restoreCommand = define({
  name: "restore",
  description: "Restore from a backup",
  args: {
    backup: {
      description: "Backup timestamp or path",
      short: "b",
      type: "string",
    },
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
    interactive: {
      default: true,
      description: "Interactive mode",
      short: "i",
      type: "boolean",
    },
    partial: {
      description: "Restore specific files only",
      multiple: true,
      short: "p",
      type: "string",
    },
    verbose: {
      default: false,
      description: "Verbose output",
      short: "v",
      type: "boolean",
    },
  },
  run: async (ctx) => {
    const { backup, interactive, partial, dryRun, verbose, config } = ctx.values;

    const logger = new Logger(verbose, dryRun);
    let rl: ReturnType<typeof createInterface> | undefined;
    
    try {
      logger.info("Starting dotfiles restoration...");

      const configManager = new ConfigManager(config);
      await configManager.load();

      const backupConfig = configManager.getBackupConfig();
      const backupManager = new BackupManager(logger, backupConfig);

      let selectedBackup = backup;

      if (!selectedBackup && interactive) {
        rl = createReadlineInterface();
        const backups = await backupManager.listBackups();
        
        if (backups.length === NO_BACKUPS_FOUND) {
          logger.error("No backups found");
          process.exit(EXIT_FAILURE);
        }

        logger.info("Available backups:");
        backups.forEach((b, index) => {
          const date = b.name.replace(/T/g, " ").replace(/-/g, SLASH_COUNT_THRESHOLD > index ? "/" : ":");
          console.log(`  [${index + INDEX_OFFSET}] ${date}`);
        });

        const selection = await prompt(rl, "\nSelect backup number (or 'q' to quit): ");
        
        if ("q" === selection || "Q" === selection) {
          logger.info("Restoration cancelled");
          rl.close();
          return;
        }

        const index = parseInt(selection) - INDEX_OFFSET;
        if (index < NO_BACKUPS_FOUND || index >= backups.length) {
          logger.error("Invalid selection");
          rl.close();
          process.exit(EXIT_FAILURE);
        }

        selectedBackup = backups[index].name;
      }

      if (!selectedBackup) {
        logger.error("No backup specified");
        if (rl) rl.close();
        process.exit(EXIT_FAILURE);
      }

      if (interactive && !rl) {
        rl = createReadlineInterface();
      }

      if (interactive && rl) {
        logger.info(`Selected backup: ${selectedBackup}`);
        logger.warn("WARNING: This will overwrite existing files!");
        
        const confirm = await prompt(rl, "Are you sure you want to restore? (y/N): ");
        
        if ("y" !== confirm.toLowerCase()) {
          logger.info("Restoration cancelled");
          rl.close();
          return;
        }
      }

      await backupManager.restoreBackup(selectedBackup, partial, dryRun);
      
      logger.success("Restoration complete!");
      
      if (dryRun) {
        logger.info("This was a dry run - no changes were made");
      }

      if (rl) rl.close();
    } catch (error) {
      if (rl) rl.close();
      if (error instanceof Error) {
        logger.error(`Restoration failed: ${error.message}`);
      }
      process.exit(EXIT_FAILURE);
    }
  },
});