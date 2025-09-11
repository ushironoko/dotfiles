import { execSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { colors } from "consola/utils";
import { createConfigManager } from "../core/config-manager.js";
import { fileExists, isSymlink } from "../utils/fs.js";
import { expandPath as expandTilde } from "../utils/paths.js";
import {
  defineCommandWithBase,
  createCommandContext,
} from "../utils/command-helpers.js";

interface CheckResult {
  category: string;
  item: string;
  status: "ok" | "warning" | "error";
  message: string;
  fix?: string;
}

interface DoctorOptions {
  verbose: boolean;
  fix: boolean;
  check?: string;
}

interface DoctorContext {
  results: CheckResult[];
  logger: ReturnType<typeof createCommandContext>["logger"];
  options: DoctorOptions;
}

const createDoctorContext = (options: DoctorOptions): DoctorContext => {
  const { logger } = createCommandContext({
    verbose: options.verbose,
    dryRun: false,
  });
  return {
    results: [],
    logger,
    options,
  };
};

const addResult = (ctx: DoctorContext, result: CheckResult): void => {
  ctx.results.push(result);
};

const addSectionHeader = (title: string, results: CheckResult[]): void => {
  if (results.length > 0) {
    console.log(); // Add spacing between sections
  }
  console.log(colors.bold(colors.cyan(`📋 ${title}`)));
  console.log(colors.gray("─".repeat(40)));
};

const checkCommand = (
  ctx: DoctorContext,
  command: string,
  versionCommand: string,
  options?: {
    errorMessage?: string;
    fix?: string;
    warningOnly?: boolean;
  },
): CheckResult => {
  try {
    execSync(`which ${command}`, { stdio: "pipe" });
    if (ctx.options.verbose) {
      const version = execSync(versionCommand, { encoding: "utf8" }).trim();
      addResult(ctx, {
        category: "environment",
        item: command,
        status: "ok",
        message: `${command} is installed (${version})`,
      });
    } else {
      addResult(ctx, {
        category: "environment",
        item: command,
        status: "ok",
        message: `${command} is installed`,
      });
    }
    return {
      category: "environment",
      item: command,
      status: "ok",
      message: "",
    };
  } catch {
    const result: CheckResult = {
      category: "environment",
      item: command,
      status: options?.warningOnly ? "warning" : "error",
      message: options?.errorMessage || `${command} is not installed`,
      fix: options?.fix,
    };
    addResult(ctx, result);
    return result;
  }
};

const checkPathIncludes = (
  ctx: DoctorContext,
  pathSegment: string,
  description: string,
): void => {
  const expandedPath = expandTilde(pathSegment);
  const currentPath = process.env.PATH || "";

  if (currentPath.includes(expandedPath)) {
    addResult(ctx, {
      category: "environment",
      item: `PATH (${description})`,
      status: "ok",
      message: `PATH includes ${pathSegment}`,
    });
  } else {
    addResult(ctx, {
      category: "environment",
      item: `PATH (${description})`,
      status: "warning",
      message: `PATH doesn't include ${pathSegment}`,
      fix: `Add to your shell config: export PATH="${pathSegment}:$PATH"`,
    });
  }
};

const checkMiseInPath = (ctx: DoctorContext): void => {
  const currentPath = process.env.PATH || "";
  const hasMisePaths = currentPath.includes("/.local/share/mise/");

  if (hasMisePaths) {
    addResult(ctx, {
      category: "environment",
      item: "PATH (mise tools)",
      status: "ok",
      message: "mise tools are accessible in PATH",
    });
  } else {
    // Check if mise activate is configured
    try {
      execSync("which mise", { stdio: "pipe" });
      addResult(ctx, {
        category: "environment",
        item: "PATH (mise tools)",
        status: "warning",
        message: "mise is installed but tools may not be in PATH",
        fix: "Ensure 'eval \"$(mise activate bash)\"' is in your shell config",
      });
    } catch {
      addResult(ctx, {
        category: "environment",
        item: "PATH (mise tools)",
        status: "error",
        message: "mise tools are not accessible",
        fix: "Add 'eval \"$(mise activate bash)\"' to your shell config",
      });
    }
  }
};

const checkEnvironment = async (ctx: DoctorContext): Promise<void> => {
  addSectionHeader("Environment Checks", ctx.results);

  // Check mise installation
  checkCommand(ctx, "mise", "mise --version", {
    errorMessage: "mise is not installed",
    fix: "curl -fsSL https://mise.jdx.dev/install.sh | sh",
  });

  // Check bun installation via mise
  const bunCheck = checkCommand(ctx, "bun", "bun --version");
  if (bunCheck.status === "ok") {
    // Check for conflicting ~/.bun/bin installation (not just cache)
    const homeBunBinPath = join(homedir(), ".bun", "bin");
    if (existsSync(homeBunBinPath)) {
      addResult(ctx, {
        category: "environment",
        item: "bun conflicts",
        status: "warning",
        message: `Found standalone bun installation at ~/.bun/bin which may conflict with mise-managed bun`,
        fix: "rm -rf ~/.bun/bin && remove bun PATH exports from shell config",
      });
    }
    // Note: ~/.bun/install/cache is normal and used by mise-managed bun for package caching
  }

  // Check important tools
  checkCommand(ctx, "ghq", "ghq --version", {
    errorMessage: "ghq is not installed",
    fix: "mise use -g ghq@latest",
  });

  checkCommand(ctx, "starship", "starship --version", {
    errorMessage: "starship is not installed (optional)",
    fix: "mise use -g starship@latest",
    warningOnly: true,
  });

  // Check PATH includes necessary directories
  checkPathIncludes(ctx, "~/.local/bin", "dotfiles command");
  // Check if mise tools are in PATH (either through shims or direct paths)
  checkMiseInPath(ctx);
};

const checkConflicts = async (ctx: DoctorContext): Promise<void> => {
  addSectionHeader("File/Directory Conflicts", ctx.results);

  try {
    const configManager = await createConfigManager("./");
    const mappings = configManager.getMappings();

    for (const mapping of mappings) {
      const targetPath = expandTilde(mapping.target);

      if (await fileExists(targetPath)) {
        // For selective type, directory itself won't be a symlink
        if (mapping.type === "selective") {
          // Check if it's a directory as expected
          const stats = lstatSync(targetPath);
          if (stats.isDirectory()) {
            // Check individual files within selective mapping
            let allCorrect = true;
            if (mapping.include) {
              for (const file of mapping.include) {
                const filePath = join(targetPath, file);
                if (existsSync(filePath)) {
                  const isLink = lstatSync(filePath).isSymbolicLink();
                  if (!isLink) {
                    allCorrect = false;
                    break;
                  }
                } else {
                  allCorrect = false;
                  break;
                }
              }
            }
            addResult(ctx, {
              category: "conflicts",
              item: mapping.target,
              status: allCorrect ? "ok" : "warning",
              message: allCorrect
                ? "Correctly configured (selective)"
                : "Some files not properly linked",
              fix: allCorrect ? undefined : "dotfiles install --force",
            });
          } else {
            addResult(ctx, {
              category: "conflicts",
              item: mapping.target,
              status: "error",
              message:
                "Expected directory for selective mapping but found file",
              fix: `Remove ${targetPath} and run: dotfiles install`,
            });
          }
        } else {
          // For file and directory types, check if it's a symlink
          const isLink = await isSymlink(targetPath);
          if (isLink) {
            // Check if symlink points to the correct source
            try {
              const linkTarget = readlinkSync(targetPath);
              const expectedTarget = resolve(expandTilde(mapping.source));
              if (resolve(linkTarget) !== expectedTarget) {
                addResult(ctx, {
                  category: "conflicts",
                  item: mapping.target,
                  status: "warning",
                  message: `Symlink exists but points to wrong location`,
                  fix: `dotfiles install --force`,
                });
              } else {
                addResult(ctx, {
                  category: "conflicts",
                  item: mapping.target,
                  status: "ok",
                  message: "Correctly linked",
                });
              }
            } catch {
              addResult(ctx, {
                category: "conflicts",
                item: mapping.target,
                status: "error",
                message: "Broken symlink detected",
                fix: `rm ${targetPath} && dotfiles install`,
              });
            }
          } else {
            addResult(ctx, {
              category: "conflicts",
              item: mapping.target,
              status: "warning",
              message: `Existing file/directory (not a symlink)`,
              fix: `Backup the file and run: dotfiles install --force`,
            });
          }
        }
      } else {
        addResult(ctx, {
          category: "conflicts",
          item: mapping.target,
          status: "warning",
          message: "Not installed",
          fix: "dotfiles install",
        });
      }
    }
  } catch (error) {
    addResult(ctx, {
      category: "conflicts",
      item: "config check",
      status: "error",
      message: `Failed to load configuration: ${error}`,
    });
  }
};

const findUnmigratedRepos = (
  dir: string,
  logger: ReturnType<typeof createCommandContext>["logger"],
): string[] => {
  const unmigrated: string[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        // Check if it's a git repository
        if (existsSync(join(fullPath, ".git"))) {
          unmigrated.push(entry.name);
        }
      }
    }
  } catch (error) {
    logger.debug(`Error scanning directory ${dir}: ${error}`);
  }

  return unmigrated;
};

const checkGhqStatus = async (ctx: DoctorContext): Promise<void> => {
  addSectionHeader("GHQ Migration Status", ctx.results);

  const ghqRoot = process.env.GHQ_ROOT || join(homedir(), "ghq");
  const devDir = join(homedir(), "dev");

  // Check if ghq root exists
  if (!existsSync(ghqRoot)) {
    addResult(ctx, {
      category: "ghq",
      item: "ghq root",
      status: "warning",
      message: `GHQ root directory doesn't exist: ${ghqRoot}`,
      fix: `mkdir -p ${ghqRoot}`,
    });
  } else {
    addResult(ctx, {
      category: "ghq",
      item: "ghq root",
      status: "ok",
      message: `GHQ root exists at ${ghqRoot}`,
    });
  }

  // Check ~/dev directory status
  if (existsSync(devDir)) {
    const stats = lstatSync(devDir);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      // Check for git repositories that haven't been migrated
      try {
        const unmigrated = findUnmigratedRepos(devDir, ctx.logger);
        if (unmigrated.length > 0) {
          addResult(ctx, {
            category: "ghq",
            item: "~/dev migration",
            status: "warning",
            message: `Found ${unmigrated.length} unmigrated repositories in ~/dev`,
            fix: "./scripts/migrate-to-ghq.sh --dry-run",
          });
          if (ctx.options.verbose) {
            for (const repo of unmigrated) {
              ctx.logger.info(`  - ${repo}`);
            }
          }
        } else {
          addResult(ctx, {
            category: "ghq",
            item: "~/dev migration",
            status: "ok",
            message: "All repositories migrated (only symlinks remain)",
          });
        }
      } catch (error) {
        addResult(ctx, {
          category: "ghq",
          item: "~/dev scan",
          status: "error",
          message: `Failed to scan ~/dev: ${error}`,
        });
      }
    } else {
      addResult(ctx, {
        category: "ghq",
        item: "~/dev",
        status: "ok",
        message: "~/dev contains only symlinks or doesn't exist",
      });
    }
  }
};

const checkDotfilesConfig = async (ctx: DoctorContext): Promise<void> => {
  addSectionHeader("Dotfiles Configuration", ctx.results);

  try {
    const configManager = await createConfigManager("./");
    const mappings = configManager.getMappings();

    // Check if source files exist
    let missingSourceCount = 0;
    for (const mapping of mappings) {
      const sourcePath = expandTilde(mapping.source);
      if (!existsSync(sourcePath)) {
        missingSourceCount++;
        if (ctx.options.verbose) {
          ctx.logger.error(`  Missing source: ${mapping.source}`);
        }
      }
    }

    if (missingSourceCount > 0) {
      addResult(ctx, {
        category: "config",
        item: "source files",
        status: "error",
        message: `${missingSourceCount} source files missing`,
        fix: "Check dotfiles.config.ts for incorrect paths",
      });
    } else {
      addResult(ctx, {
        category: "config",
        item: "source files",
        status: "ok",
        message: "All source files exist",
      });
    }

    // Check backup directory
    const backupConfig = configManager.getBackupConfig();
    const backupDir = expandTilde(backupConfig.directory);
    if (existsSync(backupDir)) {
      const backups = readdirSync(backupDir);
      addResult(ctx, {
        category: "config",
        item: "backup directory",
        status: "ok",
        message: `Backup directory exists with ${backups.length} backups`,
      });
    } else {
      addResult(ctx, {
        category: "config",
        item: "backup directory",
        status: "warning",
        message: "Backup directory doesn't exist yet",
      });
    }
  } catch (error) {
    addResult(ctx, {
      category: "config",
      item: "configuration",
      status: "error",
      message: `Failed to load configuration: ${error}`,
    });
  }
};

const checkMCPConfig = async (ctx: DoctorContext): Promise<void> => {
  addSectionHeader("MCP Configuration", ctx.results);

  const claudeJsonPath = join(homedir(), ".claude.json");

  if (existsSync(claudeJsonPath)) {
    try {
      const configManager = await createConfigManager("./");
      const mcpConfig = configManager.getMCPConfig();

      if (mcpConfig) {
        const sourceFile = expandTilde(mcpConfig.sourceFile);
        if (existsSync(sourceFile)) {
          addResult(ctx, {
            category: "mcp",
            item: "MCP source",
            status: "ok",
            message: `MCP source file exists: ${mcpConfig.sourceFile}`,
          });
        } else {
          addResult(ctx, {
            category: "mcp",
            item: "MCP source",
            status: "error",
            message: `MCP source file missing: ${mcpConfig.sourceFile}`,
          });
        }

        // Check if backup exists
        const backupPath = `${claudeJsonPath}.backup`;
        if (existsSync(backupPath)) {
          addResult(ctx, {
            category: "mcp",
            item: "MCP backup",
            status: "ok",
            message: "MCP configuration backup exists",
          });
        }
      }

      addResult(ctx, {
        category: "mcp",
        item: "~/.claude.json",
        status: "ok",
        message: "Claude configuration file exists",
      });
    } catch (error) {
      addResult(ctx, {
        category: "mcp",
        item: "MCP check",
        status: "error",
        message: `Failed to check MCP configuration: ${error}`,
      });
    }
  } else {
    addResult(ctx, {
      category: "mcp",
      item: "~/.claude.json",
      status: "warning",
      message: "Claude configuration file doesn't exist",
      fix: "dotfiles install",
    });
  }
};

const printResults = (ctx: DoctorContext): void => {
  let currentCategory = "";
  let okCount = 0;
  let warningCount = 0;
  let errorCount = 0;

  for (const result of ctx.results) {
    if (result.category !== currentCategory) {
      currentCategory = result.category;
    }

    let statusIcon: string;
    let statusColor: typeof colors.green;

    if (result.status === "ok") {
      statusIcon = colors.green("✅");
      statusColor = colors.green;
    } else if (result.status === "warning") {
      statusIcon = colors.yellow("⚠️");
      statusColor = colors.yellow;
    } else {
      statusIcon = colors.red("❌");
      statusColor = colors.red;
    }

    console.log(`${statusIcon} ${colors.bold(result.item)}`);
    console.log(`   ${statusColor(result.message)}`);

    if (
      result.fix &&
      (result.status === "warning" || result.status === "error")
    ) {
      console.log(`   ${colors.gray("Fix:")} ${colors.cyan(result.fix)}`);
    }

    // Count results
    if (result.status === "ok") okCount++;
    else if (result.status === "warning") warningCount++;
    else if (result.status === "error") errorCount++;
  }

  // Print summary
  console.log(`\n${colors.gray("─".repeat(40))}`);
  console.log(colors.bold("\n📊 Diagnostic Summary:"));
  console.log(
    `   ${colors.green(`✅ OK: ${okCount}`)} | ${colors.yellow(`⚠️  Warnings: ${warningCount}`)} | ${colors.red(`❌ Errors: ${errorCount}`)}`,
  );

  if (errorCount > 0) {
    console.log(
      colors.red(
        "\n⚠️  Some issues require attention. Review the errors above.",
      ),
    );
  } else if (warningCount > 0) {
    console.log(
      colors.yellow(
        "\n⚠️  Some warnings were found. Consider addressing them for optimal setup.",
      ),
    );
  } else {
    console.log(
      colors.green("\n✨ All checks passed! Your environment is healthy."),
    );
  }

  if (ctx.options.fix) {
    console.log(
      colors.cyan(
        "\n🔧 Auto-fix mode is not yet implemented. Please run the suggested fixes manually.",
      ),
    );
  }
};

const runDiagnostics = async (
  options: DoctorOptions,
): Promise<CheckResult[]> => {
  const ctx = createDoctorContext(options);
  const categories = options.check?.split(",") || [
    "environment",
    "conflicts",
    "ghq",
    "config",
    "mcp",
  ];

  ctx.logger.info("🩺 Running dotfiles environment diagnostics...\n");

  if (categories.includes("environment")) {
    await checkEnvironment(ctx);
  }

  if (categories.includes("conflicts")) {
    await checkConflicts(ctx);
  }

  if (categories.includes("ghq")) {
    await checkGhqStatus(ctx);
  }

  if (categories.includes("config")) {
    await checkDotfilesConfig(ctx);
  }

  if (categories.includes("mcp")) {
    await checkMCPConfig(ctx);
  }

  printResults(ctx);
  return ctx.results;
};

const doctorCommand = defineCommandWithBase({
  name: "doctor",
  description: "Diagnose and fix common dotfiles environment issues",
  additionalArgs: {
    fix: {
      default: false,
      description: "Attempt to automatically fix issues (not yet implemented)",
      short: "f",
      type: "boolean",
    },
    check: {
      description:
        "Comma-separated list of categories to check (environment,conflicts,ghq,config,mcp)",
      short: "c",
      type: "string",
    },
  },
  run: async (ctx) => {
    const results = await runDiagnostics(ctx.values);

    // Exit with error code if there are errors
    const hasErrors = results.some((r) => r.status === "error");
    if (hasErrors) {
      process.exit(1);
    }
  },
});

export { doctorCommand };
