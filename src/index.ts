#!/usr/bin/env bun
import chalk from "chalk";
import { cli } from "gunshi";
import { installCommand } from "./commands/install";
import { listCommand } from "./commands/list";
import { restoreCommand } from "./commands/restore";

const ARGV_SKIP_COUNT = 2;
const args = process.argv.slice(ARGV_SKIP_COUNT);
const COMMAND_INDEX = 0;
const command = args[COMMAND_INDEX];

// If a valid command is provided, run it directly
if ("install" === command) {
  await cli(args, installCommand);
} else if ("restore" === command) {
  await cli(args, restoreCommand);
} else if ("list" === command) {
  await cli(args, listCommand);
} else {
  // Show help if no command or unknown command
  console.log(chalk.bold.cyan("\nDotfiles Manager v2.0.0"));
  console.log(chalk.gray("Personal configuration management tool\n"));
  console.log("Available commands:");
  console.log("  " + chalk.cyan("install") + "  - Install dotfiles by creating symlinks");
  console.log("  " + chalk.cyan("restore") + "  - Restore from a backup");
  console.log("  " + chalk.cyan("list") + "     - List managed dotfiles and their status");
  console.log("\nUsage: " + chalk.yellow("dotfiles <command> [options]"));
  console.log("       " + chalk.yellow("dotfiles <command> --help") + " for command options");
  
  if (command && "--help" !== command && "-h" !== command) {
    console.log("\n" + chalk.red(`Unknown command: ${command}`));
    const EXIT_CODE_ERROR = 1;
    process.exit(EXIT_CODE_ERROR);
  }
}