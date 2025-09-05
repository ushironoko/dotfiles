import chalk from "chalk";
import { define } from "gunshi";
import { ConfigManager } from "@/core/config-manager";
import { fileExists, isSymlink } from "@/utils/fs";
import { Logger } from "@/utils/logger";
import { expandPath } from "@/utils/paths";

const EXIT_FAILURE = 1;

export const listCommand = define({
  name: "list",
  description: "List managed dotfiles and their status",
  args: {
    config: {
      default: "./config/dotfiles.json",
      description: "Path to config file",
      short: "c",
      type: "string",
    },
    verbose: {
      default: false,
      description: "Show detailed information",
      short: "v",
      type: "boolean",
    },
  },
  run: async (ctx) => {
    const { config, verbose } = ctx.values;

    const logger = new Logger(verbose, false);
    
    try {
      const configManager = new ConfigManager(config);
      await configManager.load();

      const mappings = configManager.getMappings();
      
      console.log(chalk.bold("\nManaged Dotfiles:\n"));

      for (const mapping of mappings) {
        const targetPath = expandPath(mapping.target);
        const exists = await fileExists(targetPath);
        const isLink = exists && await isSymlink(targetPath);

        let status = "";
        if (!exists) {
          status = chalk.red("✗ Not installed");
        } else if (isLink) {
          status = chalk.green("✓ Linked");
        } else {
          status = chalk.yellow("⚠ File exists (not symlink)");
        }

        console.log(`${status} ${chalk.cyan(mapping.target)}`);
        
        if (verbose) {
          console.log(`  Source: ${mapping.source}`);
          console.log(`  Type: ${mapping.type}`);
          if (mapping.include) {
            console.log(`  Include: ${mapping.include.join(", ")}`);
          }
          if (mapping.permissions) {
            console.log(`  Permissions: ${JSON.stringify(mapping.permissions)}`);
          }
          console.log();
        }
      }

      const mcpConfig = configManager.getMCPConfig();
      if (mcpConfig) {
        console.log(chalk.bold("\nMCP Configuration:"));
        const targetExists = await fileExists(expandPath(mcpConfig.targetFile));
        const status = targetExists 
          ? chalk.green("✓ Target exists")
          : chalk.red("✗ Target missing");
        
        console.log(`${status} ${chalk.cyan(mcpConfig.targetFile)}`);
        if (verbose) {
          console.log(`  Source: ${mcpConfig.sourceFile}`);
          console.log(`  Merge key: ${mcpConfig.mergeKey}`);
        }
      }

    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Failed to list dotfiles: ${error.message}`);
      }
      process.exit(EXIT_FAILURE);
    }
  },
});