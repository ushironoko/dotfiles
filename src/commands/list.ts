import chalk from "chalk";
import { define } from "gunshi";
import { createConfigManager } from "../core/config-manager";
import { fileExists, isSymlink } from "../utils/fs";
import { createLogger } from "../utils/logger";
import { expandPath } from "../utils/paths";
import { join, dirname, basename } from "node:path";

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

    const logger = createLogger(verbose, false);

    try {
      const configManager = createConfigManager(config);
      await configManager.load();

      const mappings = configManager.getMappings();

      console.log(chalk.bold("\nManaged Dotfiles:\n"));

      // Group mappings by parent directory
      const groupedMappings = new Map<
        string,
        Array<{
          path: string;
          source: string;
          type: string;
          status: string;
          permissions?: string;
        }>
      >();
      const processedPaths = new Set<string>();

      // First pass: identify directories with multiple file mappings
      const dirCounts = new Map<string, number>();
      for (const mapping of mappings) {
        if ("file" === mapping.type) {
          const dir = dirname(mapping.target);
          dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        }
      }

      for (const mapping of mappings) {
        // For selective type, process individual files
        if ("selective" === mapping.type && mapping.include) {
          const parentDir = mapping.target;
          if (!groupedMappings.has(parentDir)) {
            groupedMappings.set(parentDir, []);
          }

          for (const file of mapping.include) {
            const targetPath = join(expandPath(mapping.target), file);
            const exists = await fileExists(targetPath);
            const isLink = exists && (await isSymlink(targetPath));

            let status = "";
            if (!exists) {
              status = "✗";
            } else if (isLink) {
              status = "✓";
            } else {
              status = "⚠";
            }

            let perms: string | undefined;
            if (
              mapping.permissions &&
              "object" === typeof mapping.permissions &&
              mapping.permissions[file]
            ) {
              perms = mapping.permissions[file] as string;
            }

            groupedMappings.get(parentDir)?.push({
              path: file,
              source: join(mapping.source, file),
              type: "selective",
              status,
              permissions: perms,
            });
          }
          processedPaths.add(mapping.target);
        } else if ("file" === mapping.type) {
          const dir = dirname(mapping.target);
          const fileName = basename(mapping.target);

          // Group files if there are multiple in the same directory
          if (1 < (dirCounts.get(dir) || 0)) {
            if (!groupedMappings.has(dir)) {
              groupedMappings.set(dir, []);
            }

            const targetPath = expandPath(mapping.target);
            const exists = await fileExists(targetPath);
            const isLink = exists && (await isSymlink(targetPath));

            let status = "";
            if (!exists) {
              status = "✗";
            } else if (isLink) {
              status = "✓";
            } else {
              status = "⚠";
            }

            groupedMappings.get(dir)?.push({
              path: fileName,
              source: mapping.source,
              type: mapping.type,
              status,
            });
            processedPaths.add(mapping.target);
          } else {
            // Single file, add as standalone
            const targetPath = expandPath(mapping.target);
            const exists = await fileExists(targetPath);
            const isLink = exists && (await isSymlink(targetPath));

            let status = "";
            if (!exists) {
              status = "✗";
            } else if (isLink) {
              status = "✓";
            } else {
              status = "⚠";
            }

            groupedMappings.set(mapping.target, [
              {
                path: "",
                source: mapping.source,
                type: mapping.type,
                status,
              },
            ]);
            processedPaths.add(mapping.target);
          }
        } else {
          // For directory type
          const targetPath = expandPath(mapping.target);
          const exists = await fileExists(targetPath);
          const isLink = exists && (await isSymlink(targetPath));

          let status = "";
          if (!exists) {
            status = "✗";
          } else if (isLink) {
            status = "✓";
          } else {
            status = "⚠";
          }

          // Add as standalone entry
          groupedMappings.set(mapping.target, [
            {
              path: "",
              source: mapping.source,
              type: mapping.type,
              status,
            },
          ]);
          processedPaths.add(mapping.target);
        }
      }

      // Display grouped mappings
      for (const [parent, files] of groupedMappings) {
        if (1 === files.length && "" === files[0].path) {
          // Single file or directory mapping
          const file = files[0];
          let statusColor = "";
          if ("✗" === file.status) {
            statusColor = chalk.red("✗ Not installed");
          } else if ("✓" === file.status) {
            statusColor = chalk.green("✓ Linked");
          } else {
            statusColor = chalk.yellow("⚠ File exists (not symlink)");
          }

          console.log(`${statusColor} ${chalk.cyan(parent)}`);

          if (verbose) {
            console.log(`  Source: ${file.source}`);
            console.log(`  Type: ${file.type}`);
            console.log();
          }
        } else {
          // Directory with multiple files (tree display)
          console.log(chalk.cyan(parent));

          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const isLast = i === files.length - 1;
            const prefix = isLast ? "└── " : "├── ";

            let statusIcon = "";
            if ("✗" === file.status) {
              statusIcon = chalk.red("✗");
            } else if ("✓" === file.status) {
              statusIcon = chalk.green("✓");
            } else {
              statusIcon = chalk.yellow("⚠");
            }

            console.log(`${prefix}${statusIcon} ${file.path}`);

            if (verbose) {
              const indent = isLast ? "    " : "│   ";
              console.log(`${indent}  Source: ${file.source}`);
              if (file.permissions) {
                console.log(`${indent}  Permissions: ${file.permissions}`);
              }
            }
          }

          if (verbose) {
            console.log();
          }
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
