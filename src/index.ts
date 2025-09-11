#!/usr/bin/env bun
import { cli } from "gunshi";
import { colors } from "consola/utils";
import { doctorCommand } from "./commands/doctor";
import { installCommand } from "./commands/install";
import { listCommand } from "./commands/list";
import { restoreCommand } from "./commands/restore";

const ARGV_SKIP_COUNT = 2;
const args = process.argv.slice(ARGV_SKIP_COUNT);
const COMMAND_INDEX = 0;
const command = args[COMMAND_INDEX];

// If a valid command is provided, run it directly
if (command === "install") {
  await cli(args, installCommand);
} else if (command === "restore") {
  await cli(args, restoreCommand);
} else if (command === "list") {
  await cli(args, listCommand);
} else if (command === "doctor") {
  await cli(args, doctorCommand);
} else {
  // Show help if no command or unknown command
  console.log(colors.bold(colors.cyan("\nDotfiles Manager v2.0.0")));
  console.log(colors.gray("Personal configuration management tool\n"));
  console.log("Available commands:");
  console.log(
    `  ${colors.cyan("install")}  - Install dotfiles by creating symlinks`,
  );
  console.log(`  ${colors.cyan("restore")}  - Restore from a backup`);
  console.log(
    `  ${colors.cyan("list")}     - List managed dotfiles and their status`,
  );
  console.log(
    `  ${colors.cyan("doctor")}   - Diagnose environment and configuration issues`,
  );
  console.log(`\nUsage: ${colors.yellow("dotfiles <command> [options]")}`);
  console.log(
    `       ${colors.yellow("dotfiles <command> --help")} for command options`,
  );

  if (command && command !== "--help" && command !== "-h") {
    console.log(`\n${colors.red(`Unknown command: ${command}`)}`);
    const EXIT_CODE_ERROR = 1;
    process.exit(EXIT_CODE_ERROR);
  }
}
