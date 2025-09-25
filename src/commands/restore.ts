import { createInterface } from "readline";
import { createBackupManager } from "../core/backup-manager.js";
import { createConfigManager } from "../core/config-manager.js";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../utils/command-helpers.js";
import { EXIT_FAILURE, dryRunArg, interactiveArg } from "../types/command.js";

const NO_BACKUPS_FOUND = 0;
const INDEX_OFFSET = 1;
const SLASH_COUNT_THRESHOLD = 3;

const createReadlineInterface = () => {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
};

const prompt = (
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

const restoreCommand = define({
  name: "restore",
  description: "Restore from a backup",
  args: {
    ...baseCommandArgs,
    backup: {
      description: "Backup timestamp or path",
      short: "b",
      type: "string",
    },
    ...dryRunArg,
    ...interactiveArg,
    partial: {
      description: "Restore specific files only",
      multiple: true,
      short: "p",
      type: "string",
    },
  },
  run: async (ctx) => {
    const { backup, interactive, partial, dryRun, verbose, config } =
      ctx.values;

    const { logger } = createCommandContext({ verbose, dryRun });
    let rl: ReturnType<typeof createInterface> | undefined = undefined;

    try {
      logger.info("Starting dotfiles restoration...");

      const configManager = await createConfigManager(config);

      const backupConfig = configManager.getBackupConfig();
      const backupManager = createBackupManager(logger, backupConfig);

      let selectedBackup = backup;

      if (!selectedBackup && interactive) {
        rl = createReadlineInterface();
        const backups = await backupManager.listBackups();

        if (backups.length === NO_BACKUPS_FOUND) {
          logger.error("No backups found");
          process.exit(EXIT_FAILURE);
        }

        logger.info("Available backups:");
        backups.forEach((backup, index) => {
          const date = backup.name
            .replace(/T/g, " ")
            .replace(/-/g, SLASH_COUNT_THRESHOLD > index ? "/" : ":");
          console.log(`  [${index + INDEX_OFFSET}] ${date}`);
        });

        const selection = await prompt(
          rl,
          "\nSelect backup number (or 'q' to quit): ",
        );

        if (selection === "q" || selection === "Q") {
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
        if (rl) {
          rl.close();
        }
        process.exit(EXIT_FAILURE);
      }

      if (interactive && !rl) {
        rl = createReadlineInterface();
      }

      if (interactive && rl) {
        logger.info(`Selected backup: ${selectedBackup}`);
        logger.warn("WARNING: This will overwrite existing files!");

        const confirm = await prompt(
          rl,
          "Are you sure you want to restore? (y/N): ",
        );

        if (confirm.toLowerCase() !== "y") {
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

export { restoreCommand };
