import { colors } from "consola/utils";
import { createConfigManager } from "../core/config-manager.js";
import { fileExists, isSymlink } from "../utils/fs.js";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../utils/command-helpers.js";
import { expandPath } from "../utils/paths.js";
import { join, dirname, basename } from "node:path";
import { EXIT_FAILURE } from "../types/command.js";

const listCommand = define({
  name: "list",
  description: "List managed dotfiles and their status",
  args: {
    ...baseCommandArgs,
  },
  run: async (ctx) => {
    const { config, verbose } = ctx.values;

    const { logger } = createCommandContext({ verbose, dryRun: false });

    try {
      const configManager = await createConfigManager(config);

      const mappings = configManager.getMappings();

      console.log(colors.bold("\nManaged Dotfiles:\n"));

      // Group mappings by parent directory
      const groupedMappings = new Map<
        string,
        {
          path: string;
          source: string;
          type: string;
          status: string;
          permissions?: string;
        }[]
      >();

      for (const mapping of mappings) {
        const targetPath = expandPath(mapping.target);
        let parentDir = dirname(targetPath);

        // For selective mappings, group by target directory
        if (mapping.type === "selective" && Array.isArray(mapping.include)) {
          parentDir = targetPath; // Use the target directory itself
          for (const file of mapping.include) {
            const fullTarget = join(targetPath, file);
            const fullSource = join(expandPath(mapping.source), file);

            let status = "missing";
            const exists = await fileExists(fullTarget);
            if (exists) {
              const symlink = await isSymlink(fullTarget);
              status = symlink ? "linked" : "exists";
            }

            // Check for permissions
            let permissions = undefined;
            if (
              mapping.permissions &&
              typeof mapping.permissions === "object"
            ) {
              permissions = mapping.permissions[file];
            }

            if (!groupedMappings.has(parentDir)) {
              groupedMappings.set(parentDir, []);
            }

            groupedMappings.get(parentDir)?.push({
              path: fullTarget,
              source: fullSource,
              type: "selective-file",
              status,
              permissions,
            });
          }
        } else {
          // For regular file and directory mappings
          const exists = await fileExists(targetPath);
          let status = "missing";
          if (exists) {
            const symlink = await isSymlink(targetPath);
            status = symlink ? "linked" : "exists";
          }

          if (!groupedMappings.has(parentDir)) {
            groupedMappings.set(parentDir, []);
          }

          groupedMappings.get(parentDir)?.push({
            path: targetPath,
            source: expandPath(mapping.source),
            type: mapping.type,
            status,
          });
        }
      }

      // Sort parent directories
      const sortedParents = [...groupedMappings.keys()].sort();

      for (const [index, parent] of sortedParents.entries()) {
        const items = groupedMappings.get(parent) ?? [];

        // Tree-like display
        if (index > 0) {
          console.log(""); // Add spacing between groups
        }

        // For selective mappings
        if (items.length > 0 && items[0]?.type === "selective-file") {
          const parentStatus = await fileExists(parent);
          if (verbose) {
            console.log(
              parentStatus
                ? colors.green(
                    `✓ Processing selective symlinks for ${colors.cyan(parent)}`,
                  )
                : colors.red(
                    `✗ Parent directory missing: ${colors.cyan(parent)}`,
                  ),
            );
          } else {
            console.log(colors.cyan(parent));
          }

          // Display files with tree structure
          for (const [itemIndex, item] of items.entries()) {
            const isLast = itemIndex === items.length - 1;
            const prefix = isLast ? "└── " : "├── ";
            const name = basename(item.path);

            let statusIcon = "";
            if (item.status === "missing") {
              statusIcon = colors.red("✗");
            } else if (item.status === "linked") {
              statusIcon = colors.green("✓");
            } else {
              statusIcon = colors.yellow("⚠");
            }

            console.log(`${prefix}${statusIcon} ${name}`);

            if (verbose) {
              const detailPrefix = isLast ? "      " : "│     ";
              console.log(`${detailPrefix}Source: ${item.source}`);
              if (item.permissions) {
                console.log(`${detailPrefix}Permissions: ${item.permissions}`);
              }
            }
          }
        } else {
          // For regular file and directory mappings
          if (verbose) {
            // Verbose mode: show full status
            for (const item of items) {
              let statusColor;
              if (item.status === "missing") {
                statusColor = colors.red("✗ Not installed");
              } else if (item.status === "linked") {
                statusColor = colors.green("✓ Linked");
              } else {
                statusColor = colors.yellow("⚠ File exists (not symlink)");
              }

              console.log(`${statusColor} ${colors.cyan(item.path)}`);
              console.log(`  Source: ${item.source}`);
              console.log(`  Type: ${item.type}`);
              console.log("");
            }
          } else {
            // Non-verbose mode: tree view
            console.log(colors.cyan(parent));

            // Sort items for consistent display
            items.sort((a, b) => a.path.localeCompare(b.path));

            for (const [itemIndex, item] of items.entries()) {
              const isLast = itemIndex === items.length - 1;
              const prefix = isLast ? "└── " : "├── ";
              const name = basename(item.path);

              let statusIcon = "";
              if (item.status === "missing") {
                statusIcon = colors.red("✗");
              } else if (item.status === "linked") {
                statusIcon = colors.green("✓");
              } else {
                statusIcon = colors.yellow("⚠");
              }

              console.log(`${prefix}${statusIcon} ${name}`);

              if (verbose) {
                const detailPrefix = isLast ? "      " : "│     ";
                console.log(`${detailPrefix}Source: ${item.source}`);
              }
            }
          }
        }
      }

      // Display MCP configuration status if present
      const mcpConfig = configManager.getMCPConfig();
      if (mcpConfig) {
        console.log("");
        console.log(colors.bold("\nMCP Configuration:"));
        const targetExists = await fileExists(mcpConfig.targetFile);
        const status = targetExists
          ? colors.green("✓ Target exists")
          : colors.red("✗ Target missing");

        console.log(`${status} ${colors.cyan(mcpConfig.targetFile)}`);
        if (verbose) {
          console.log(`  Source: ${mcpConfig.sourceFile}`);
          console.log(`  Merge key: ${mcpConfig.mergeKey}`);
        }
      }
    } catch (error) {
      logger.error(`Failed to list dotfiles: ${error}`);
      process.exit(EXIT_FAILURE);
    }
  },
});

export { listCommand };
