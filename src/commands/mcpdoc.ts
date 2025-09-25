import { createInterface } from "readline";
import { colors } from "consola/utils";
import { createMCPDocManager } from "../core/mcpdoc-manager.js";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../utils/command-helpers.js";
import { dryRunArg } from "../types/command.js";

const mcpdocCommand = define({
  name: "mcpdoc",
  description: "Manage mcpdoc documentation sources",
  args: {
    ...baseCommandArgs,
    ...dryRunArg,
  },
  run: async (ctx) => {
    const { dryRun, verbose } = ctx.values;

    // Get positional arguments from process.argv
    // Skip: node, script, "mcpdoc", and flag arguments
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith("-"));
    const [subcommand, name, url] = args;

    const { logger } = createCommandContext({ verbose, dryRun });

    try {
      const mcpdocManager = await createMCPDocManager(logger);

      if (!subcommand) {
        // Show help if no subcommand
        console.log(colors.bold(colors.cyan("\nMCPDoc Documentation Manager")));
        console.log(
          colors.gray("Manage llms.txt documentation sources for MCPDoc\n"),
        );
        console.log("Usage:");
        console.log(
          `  ${colors.yellow("dotfiles mcpdoc add <name> <url>")}     - Add a new documentation source`,
        );
        console.log(
          `  ${colors.yellow("dotfiles mcpdoc remove <name>")}        - Remove a documentation source`,
        );
        console.log(
          `  ${colors.yellow("dotfiles mcpdoc list")}                 - List all documentation sources`,
        );
        console.log(`\nOptions:`);
        console.log(
          `  ${colors.gray("--dry-run")}  Preview changes without modifying files`,
        );
        console.log(`  ${colors.gray("--verbose")}  Show detailed output`);
        return;
      }

      switch (subcommand) {
        case "add": {
          if (!name || !url) {
            logger.error("Both name and URL are required for add command");
            logger.info(
              `Usage: ${colors.yellow("dotfiles mcpdoc add <name> <url>")}`,
            );
            process.exit(1);
          }

          // Validate URL format
          try {
            const parsedUrl = new URL(url);
            // Only allow https protocol
            if (parsedUrl.protocol !== "https:") {
              logger.error(
                `Invalid protocol: ${parsedUrl.protocol}. Only HTTPS URLs are allowed`,
              );
              process.exit(1);
            }
          } catch {
            logger.error(`Invalid URL format: ${url}`);
            process.exit(1);
          }

          await mcpdocManager.addSource(name, url, dryRun);
          break;
        }

        case "remove": {
          if (!name) {
            logger.error("Name is required for remove command");
            logger.info(
              `Usage: ${colors.yellow("dotfiles mcpdoc remove <name>")}`,
            );
            process.exit(1);
          }

          const sources = await mcpdocManager.getSources();
          const sourceExists = sources.some((s) => s.name === name);

          if (!sourceExists) {
            logger.error(`Source "${name}" not found`);
            logger.info("Run 'dotfiles mcpdoc list' to see available sources");
            process.exit(1);
          }

          if (!dryRun) {
            const rl = createInterface({
              input: process.stdin,
              output: process.stdout,
            });

            const answer = await new Promise<string>((resolve) => {
              rl.question(
                `Are you sure you want to remove "${name}"? (y/N): `,
                resolve,
              );
            });

            rl.close();

            if (answer.toLowerCase() !== "y") {
              logger.info("Operation cancelled");
              return;
            }
          }

          await mcpdocManager.removeSource(name, dryRun);
          break;
        }

        case "list": {
          const sources = await mcpdocManager.getSources();

          if (sources.length === 0) {
            logger.info("No documentation sources configured");
            logger.info(
              `Run '${colors.yellow("dotfiles mcpdoc add <name> <url>")}' to add a source`,
            );
          } else {
            console.log(
              colors.bold(colors.cyan("\nConfigured Documentation Sources:\n")),
            );
            sources.forEach((source, index) => {
              console.log(
                `${colors.gray(`${index + 1}.`)} ${colors.bold(source.name)}`,
              );
              console.log(`   ${colors.gray("URL:")} ${source.llms_txt}`);
              if (source.description) {
                console.log(
                  `   ${colors.gray("Description:")} ${source.description}`,
                );
              }
              console.log();
            });
            console.log(colors.gray(`Total: ${sources.length} source(s)`));
          }
          break;
        }

        default: {
          logger.error(`Unknown subcommand: ${subcommand}`);
          logger.info("Valid subcommands: add, remove, list");
          process.exit(1);
        }
      }
    } catch (error) {
      logger.error("Failed to execute mcpdoc command");
      if (error instanceof Error) {
        logger.error(error.message);
      }
      process.exit(1);
    }
  },
});

export { mcpdocCommand };
