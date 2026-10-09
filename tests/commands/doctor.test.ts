import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorCommand } from "../../src/commands/doctor";
import type { DotfilesConfig } from "../../src/types/config";

const entrypoint = fileURLToPath(
  new URL("../../src/index.ts", import.meta.url),
);

const snapshotTree = (root: string): unknown[] => {
  const entries: unknown[] = [];
  const visit = (path: string, relative: string): void => {
    const stat = lstatSync(path);
    const state = {
      relative,
      mode: stat.mode & 0o7777,
      inode: stat.ino,
      modified: stat.mtimeMs,
      changed: stat.ctimeMs,
    };
    if (stat.isSymbolicLink()) {
      entries.push({ ...state, link: readlinkSync(path) });
    } else if (stat.isDirectory()) {
      entries.push({ ...state, directory: true });
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), join(relative, name));
      }
    } else {
      entries.push({
        ...state,
        bytes: readFileSync(path).toString("hex"),
      });
    }
  };
  visit(root, ".");
  return entries;
};

describe("doctor command", () => {
  let tempDir: string;
  let home: string;
  let bin: string;
  let configDir: string;
  let config: DotfilesConfig;

  beforeEach(() => {
    tempDir = realpathSync(
      mkdtempSync(join(tmpdir(), "dotfiles-doctor-test-")),
    );
    home = join(tempDir, "home");
    bin = join(tempDir, "bin");
    configDir = join(tempDir, "configuration");
    for (const directory of [
      home,
      bin,
      configDir,
      join(tempDir, "cwd"),
      join(tempDir, "tmp"),
    ]) {
      mkdirSync(directory);
    }
    writeFileSync(join(home, "unrelated.json"), '{"preserve":"日本語"}\n');
    chmodSync(join(home, "unrelated.json"), 0o600);
    symlinkSync("unrelated.json", join(home, "unrelated-link"));
    writeFileSync(join(configDir, "source.txt"), "fixture source\n");
    writeFileSync(
      join(tempDir, "cwd", "dotfiles.config.json"),
      '{"mappings":"wrong-cwd","backup":{"directory":"~/wrong-backups"}}',
    );
    config = {
      mappings: [
        {
          source: join(configDir, "source.txt"),
          target: join(home, "managed.txt"),
          type: "file",
        },
      ],
      backup: {
        directory: join(home, "backups"),
        keepLast: 10,
        compress: false,
      },
    };
    writeConfig();
    writeFileSync(join(bin, "which"), '#!/bin/sh\ncommand -v "$1"\n');
    chmodSync(join(bin, "which"), 0o755);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeConfig = (): void => {
    writeFileSync(
      join(configDir, "dotfiles.config.json"),
      JSON.stringify(config),
    );
  };

  const tool = (name: string): void => {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' '${name}-fixture-1.0'\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };

  const diagnose = (
    category: string,
    extra: string[] = [],
    path = bin,
    selectedConfig: string | null = configDir,
    cliEntrypoint = entrypoint,
  ) => {
    const before = snapshotTree(tempDir);
    const result = spawnSync(
      process.execPath,
      [
        cliEntrypoint,
        "doctor",
        ...(selectedConfig === null ? [] : ["--config", selectedConfig]),
        "--check",
        category,
        ...extra,
      ],
      {
        cwd: join(tempDir, "cwd"),
        env: {
          HOME: home,
          PATH: path,
          GHQ_ROOT: join(home, "ghq"),
          TMPDIR: join(tempDir, "tmp"),
          TMP: join(tempDir, "tmp"),
          TEMP: join(tempDir, "tmp"),
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          CODEX_HOME: join(home, "codex"),
          CLAUDE_CONFIG_DIR: join(home, "claude"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          NODE_ENV: "test",
          NO_COLOR: "1",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          JITI_FS_CACHE: "0",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(snapshotTree(tempDir)).toEqual(before);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  const summary = (
    output: string,
    ok: number,
    warnings: number,
    errors: number,
  ): void => {
    expect(output).toContain(
      `✅ OK: ${ok} | ⚠️  Warnings: ${warnings} | ❌ Errors: ${errors}`,
    );
  };

  describe("environment checks", () => {
    it("should check for environment tools", () => {
      for (const name of ["mise", "bun", "ghq", "starship"]) tool(name);
      const localBin = join(home, ".local", "bin");
      const miseBin = join(home, ".local", "share", "mise", "shims");
      mkdirSync(localBin, { recursive: true });
      mkdirSync(miseBin, { recursive: true });
      mkdirSync(join(home, ".bun", "bin"), { recursive: true });
      const path = [bin, localBin, miseBin].join(":");
      const verbose = diagnose("environment", ["--verbose", "--fix"], path);
      expect(verbose.status).toBe(0);
      for (const name of ["mise", "bun", "ghq", "starship"]) {
        expect(verbose.output).toContain(
          `✅ ${name}\n   ${name} is installed (${name}-fixture-1.0)`,
        );
      }
      expect(verbose.output).toContain("⚠️ bun conflicts");
      expect(verbose.output).toContain(
        "Found standalone bun installation at ~/.bun/bin",
      );
      expect(verbose.output).toContain("PATH includes ~/.local/bin");
      expect(verbose.output).toContain("mise tools are accessible in PATH");
      expect(verbose.output).toContain("Auto-fix mode is not yet implemented");
      summary(verbose.output, 6, 1, 0);
      const plain = diagnose("environment", [], path);
      expect(plain.status).toBe(0);
      expect(plain.output).toContain("mise is installed");
      expect(plain.output).not.toContain("fixture-1.0");
      rmSync(join(bin, "starship"));
      const optionalMissing = diagnose("environment", [], path);
      expect(optionalMissing.status).toBe(0);
      expect(optionalMissing.output).toContain(
        "⚠️ starship\n   starship is not installed (optional)",
      );
      summary(optionalMissing.output, 5, 2, 0);
      rmSync(join(bin, "mise"));
      rmSync(join(bin, "ghq"));
      rmSync(join(bin, "bun"));
      const missing = diagnose("environment");
      expect(missing.status).toBe(1);
      expect(missing.output).toContain("❌ mise\n   mise is not installed");
      expect(missing.output).toContain("❌ ghq\n   ghq is not installed");
      expect(missing.output).toContain("❌ bun\n   bun is not installed");
      expect(missing.output).toContain(
        "⚠️ starship\n   starship is not installed (optional)",
      );
      expect(missing.output).toContain("mise tools are not accessible");
      summary(missing.output, 0, 2, 4);
    }, 45000);

    it("should handle missing ghq root directory", () => {
      const result = diagnose("ghq");
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        `⚠️ ghq root\n   GHQ root directory doesn't exist: ${join(home, "ghq")}`,
      );
      expect(result.output).toContain(`Fix: mkdir -p ${join(home, "ghq")}`);
      expect(result.output).not.toContain("Environment Checks");
      summary(result.output, 0, 1, 0);
    }, 15000);

    it("should detect unmigrated repositories", () => {
      mkdirSync(join(home, "ghq"));
      mkdirSync(join(home, "dev", "alpha", ".git"), { recursive: true });
      mkdirSync(join(home, "dev", "beta"), { recursive: true });
      writeFileSync(join(home, "dev", "beta", ".git"), "gitdir: isolated\n");
      mkdirSync(join(home, "dev", "ordinary"));
      mkdirSync(join(home, "ghq", "migrated", ".git"), { recursive: true });
      symlinkSync(join(home, "ghq", "migrated"), join(home, "dev", "linked"));
      const result = diagnose("ghq", ["--verbose"]);
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        "⚠️ ~/dev migration\n   Found 2 unmigrated repositories in ~/dev",
      );
      expect(result.output).toContain("  - alpha");
      expect(result.output).toContain("  - beta");
      expect(result.output).not.toContain("  - linked");
      expect(result.output).not.toContain("  - ordinary");
      summary(result.output, 1, 1, 0);
    }, 15000);

    it("should handle symlinked dev directory", () => {
      mkdirSync(join(home, "ghq", "repo", ".git"), { recursive: true });
      symlinkSync(join(home, "ghq", "repo"), join(home, "dev"));
      const result = diagnose("ghq");
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        "✅ ~/dev\n   ~/dev contains only symlinks or doesn't exist",
      );
      expect(result.output).not.toContain("unmigrated repositories");
      summary(result.output, 2, 0, 0);
    }, 15000);
  });

  describe("config validation", () => {
    it("should handle backup directory", () => {
      mkdirSync(join(home, "backups", "2024-01-01T00-00-00"), {
        recursive: true,
      });
      mkdirSync(join(home, "backups", "2024-01-02T00-00-00"));
      writeFileSync(
        join(home, "backups", "2024-01-01T00-00-00", "retained"),
        "backup bytes\n",
      );
      const result = diagnose("config");
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        "✅ source files\n   All source files exist",
      );
      expect(result.output).toContain(
        "✅ backup directory\n   Backup directory exists with 2 backups",
      );
      summary(result.output, 2, 0, 0);
    }, 15000);

    it("should report isolated missing sources and backup warnings", () => {
      config.mappings[0].source = join(configDir, "missing-source.txt");
      writeConfig();
      const result = diagnose("config", ["--verbose"]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `Missing source: ${join(configDir, "missing-source.txt")}`,
      );
      expect(result.output).toContain(
        "❌ source files\n   1 source files missing",
      );
      expect(result.output).toContain(
        "⚠️ backup directory\n   Backup directory doesn't exist yet",
      );
      summary(result.output, 0, 1, 1);
    }, 15000);

    it("should report an invalid explicit configuration", () => {
      writeFileSync(
        join(configDir, "dotfiles.config.json"),
        '{"mappings":"invalid","backup":{"directory":"~/backups"}}',
      );
      const result = diagnose("config");
      expect(result.status).toBe(1);
      expect(result.output).toContain("❌ configuration");
      expect(result.output).toContain(
        "Invalid config: mappings must be an array",
      );
      summary(result.output, 0, 0, 1);
    }, 15000);

    it("should diagnose isolated target conflicts without modifying links or siblings", () => {
      writeFileSync(join(configDir, "other.txt"), "other source\n");
      const correct = join(home, "correct");
      const wrong = join(home, "wrong");
      const regular = join(home, "regular");
      const selective = join(home, "selective");
      const invalidSelective = join(home, "selective-file");
      symlinkSync(join(configDir, "source.txt"), correct);
      symlinkSync(join(configDir, "other.txt"), wrong);
      writeFileSync(regular, "user-owned file\n");
      mkdirSync(selective);
      symlinkSync(join(configDir, "source.txt"), join(selective, "linked"));
      writeFileSync(join(selective, "sibling"), "unrelated sibling\n");
      writeFileSync(invalidSelective, "user-owned selective target\n");
      config.mappings = [
        {
          source: join(configDir, "source.txt"),
          target: correct,
          type: "file",
        },
        { source: join(configDir, "source.txt"), target: wrong, type: "file" },
        {
          source: join(configDir, "source.txt"),
          target: regular,
          type: "file",
        },
        {
          source: join(configDir, "source.txt"),
          target: join(home, "absent"),
          type: "file",
        },
        {
          source: configDir,
          target: selective,
          type: "selective",
          include: ["linked", "missing"],
        },
        {
          source: configDir,
          target: invalidSelective,
          type: "selective",
          include: ["linked"],
        },
      ];
      writeConfig();
      const result = diagnose("conflicts", ["--fix"]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`✅ ${correct}\n   Correctly linked`);
      expect(result.output).toContain(
        `⚠️ ${wrong}\n   Symlink exists but points to wrong location`,
      );
      expect(result.output).toContain(
        `⚠️ ${regular}\n   Existing file/directory (not a symlink)`,
      );
      expect(result.output).toContain(
        `⚠️ ${join(home, "absent")}\n   Not installed`,
      );
      expect(result.output).toContain(
        `⚠️ ${selective}\n   Some files not properly linked`,
      );
      expect(result.output).toContain(
        `❌ ${invalidSelective}\n   Expected directory for selective mapping but found file`,
      );
      summary(result.output, 1, 4, 1);
    }, 15000);
  });

  describe("explicit configuration resolution", () => {
    for (const category of ["conflicts", "config", "mcp"]) {
      for (const absentHome of category === "mcp" ? [false, true] : [false]) {
        const homeState = absentHome
          ? "absent claude.json"
          : "present claude.json";

        for (const selection of [
          "valid directory",
          "valid nonstandard file",
          "missing path",
          "empty directory",
          "invalid existing file",
        ]) {
          it(`should resolve ${selection} for ${category} with ${homeState}`, () => {
            if (!absentHome) {
              writeFileSync(join(home, ".claude.json"), '{"mcpServers":{}}\n');
            }
            writeFileSync(join(configDir, "mcp.json"), '{"mcpServers":{}}\n');
            config.mcp = {
              sourceFile: join(configDir, "mcp.json"),
              targetFile: join(home, ".claude.json"),
              mergeKey: "mcpServers",
            };
            writeConfig();

            let selectedPath = configDir;
            if (selection === "valid nonstandard file") {
              selectedPath = join(configDir, "chosen-settings.json");
              config.backup.directory = join(home, "chosen-backups");
              mkdirSync(join(home, "chosen-backups", "one"), {
                recursive: true,
              });
              mkdirSync(join(home, "chosen-backups", "two"));
              writeFileSync(selectedPath, JSON.stringify(config));
              writeFileSync(
                join(configDir, "dotfiles.config.json"),
                '{"mappings":"conflicting-default","backup":{"directory":"~/wrong-backups"}}',
              );
            } else if (selection === "missing path") {
              selectedPath = join(tempDir, "missing-configuration");
            } else if (selection === "empty directory") {
              selectedPath = join(tempDir, "empty-configuration");
              mkdirSync(selectedPath);
            } else if (selection === "invalid existing file") {
              selectedPath = join(configDir, "invalid-settings.json");
              writeFileSync(
                selectedPath,
                '{"mappings":"invalid","backup":{"directory":"~/backups"}}',
              );
            }

            const result = diagnose(category, [], bin, selectedPath);
            expect(result.output).not.toContain("wrong-cwd");
            expect(result.output).not.toContain("conflicting-default");
            expect(result.output).not.toContain("wrong-backups");

            if (
              selection === "valid directory" ||
              selection === "valid nonstandard file"
            ) {
              expect(result.status).toBe(0);
              expect(result.output).not.toContain(
                "Failed to load configuration",
              );
              expect(result.output).not.toContain(
                "Failed to check MCP configuration",
              );
              if (category === "conflicts") {
                expect(result.output).toContain(
                  `⚠️ ${join(home, "managed.txt")}\n   Not installed`,
                );
                summary(result.output, 0, 1, 0);
              } else if (category === "config") {
                expect(result.output).toContain(
                  "✅ source files\n   All source files exist",
                );
                if (selection === "valid nonstandard file") {
                  expect(result.output).toContain(
                    "✅ backup directory\n   Backup directory exists with 2 backups",
                  );
                  summary(result.output, 2, 0, 0);
                } else {
                  expect(result.output).toContain(
                    "⚠️ backup directory\n   Backup directory doesn't exist yet",
                  );
                  summary(result.output, 1, 1, 0);
                }
              } else if (absentHome) {
                expect(result.output).toContain(
                  "⚠️ ~/.claude.json\n   Claude configuration file doesn't exist",
                );
                expect(result.output).not.toContain("MCP source");
                summary(result.output, 0, 1, 0);
              } else {
                expect(result.output).toContain(
                  `✅ MCP source\n   MCP source file exists: ${join(configDir, "mcp.json")}`,
                );
                expect(result.output).toContain(
                  "✅ ~/.claude.json\n   Claude configuration file exists",
                );
                summary(result.output, 2, 0, 0);
              }
            } else {
              expect(result.status).toBe(1);
              let item = "MCP check";
              if (category === "conflicts") item = "config check";
              else if (category === "config") item = "configuration";
              expect(result.output).toContain(`❌ ${item}`);
              expect(result.output).toContain(
                category === "mcp"
                  ? "Failed to check MCP configuration:"
                  : "Failed to load configuration:",
              );
              if (selection === "invalid existing file") {
                expect(result.output).toContain(
                  "Invalid config: mappings must be an array",
                );
              } else {
                expect(result.output).toContain("Required config (");
                expect(result.output).toContain(selectedPath);
                expect(result.output).toContain("cannot be resolved.");
              }
              expect(result.output).not.toContain("All source files exist");
              expect(result.output).not.toContain(
                "Claude configuration file exists",
              );
              expect(result.output).not.toContain(
                "Claude configuration file doesn't exist",
              );
              summary(result.output, 0, 0, 1);
            }
          }, 15000);
        }
      }
    }

    for (const { selection, selectedPath } of [
      { selection: "omitted", selectedPath: null },
      { selection: "empty", selectedPath: "" },
      { selection: "legacy ./", selectedPath: "./" },
    ]) {
      for (const category of ["conflicts", "config", "mcp"]) {
        it(`should use isolated repository defaults for ${category} with ${selection} config`, () => {
          const repository = join(tempDir, "repository");
          mkdirSync(repository);
          cpSync(
            fileURLToPath(new URL("../../src", import.meta.url)),
            join(repository, "src"),
            { recursive: true },
          );
          symlinkSync(
            fileURLToPath(new URL("../../node_modules", import.meta.url)),
            join(repository, "node_modules"),
            "dir",
          );
          writeFileSync(
            join(repository, "default-source.txt"),
            "default source\n",
          );
          writeFileSync(
            join(repository, "default-mcp.json"),
            '{"mcpServers":{}}\n',
          );
          writeFileSync(join(home, ".claude.json"), '{"mcpServers":{}}\n');
          writeFileSync(
            join(repository, "dotfiles.config.json"),
            JSON.stringify({
              mappings: [
                {
                  source: "./default-source.txt",
                  target: "~/default-managed",
                  type: "file",
                },
              ],
              backup: { directory: "~/default-backups" },
              mcp: {
                sourceFile: "./default-mcp.json",
                targetFile: "~/.claude.json",
                mergeKey: "mcpServers",
              },
            }),
          );
          const result = diagnose(
            category,
            [],
            bin,
            selectedPath,
            join(repository, "src", "index.ts"),
          );
          expect(result.status).toBe(0);
          expect(result.output).not.toContain("wrong-cwd");
          expect(result.output).not.toContain("Failed to");
          expect(result.output).not.toContain(join(home, "managed.txt"));
          if (category === "conflicts") {
            expect(result.output).toContain(
              `⚠️ ${join(home, "default-managed")}\n   Not installed`,
            );
            summary(result.output, 0, 1, 0);
          } else if (category === "config") {
            expect(result.output).toContain(
              "✅ source files\n   All source files exist",
            );
            expect(result.output).toContain(
              "⚠️ backup directory\n   Backup directory doesn't exist yet",
            );
            summary(result.output, 1, 1, 0);
          } else {
            expect(result.output).toContain(
              `✅ MCP source\n   MCP source file exists: ${join(repository, "default-mcp.json")}`,
            );
            expect(result.output).toContain(
              "✅ ~/.claude.json\n   Claude configuration file exists",
            );
            summary(result.output, 2, 0, 0);
          }
        }, 15000);
      }
    }
  });

  describe("MCP configuration checks", () => {
    it("should detect claude.json existence", () => {
      writeFileSync(
        join(home, ".claude.json"),
        '{"mcpServers":{},"unrelated":"keep"}\n',
      );
      writeFileSync(join(home, ".claude.json.backup"), "original backup\n");
      writeFileSync(join(configDir, "mcp.json"), '{"mcpServers":{}}\n');
      config.mcp = {
        sourceFile: join(configDir, "mcp.json"),
        targetFile: join(home, ".claude.json"),
        mergeKey: "mcpServers",
      };
      writeConfig();
      const result = diagnose("mcp");
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        `✅ MCP source\n   MCP source file exists: ${join(configDir, "mcp.json")}`,
      );
      expect(result.output).toContain(
        "✅ MCP backup\n   MCP configuration backup exists",
      );
      expect(result.output).toContain(
        "✅ ~/.claude.json\n   Claude configuration file exists",
      );
      summary(result.output, 3, 0, 0);
    }, 15000);

    it("should detect missing claude.json", () => {
      const result = diagnose("mcp", ["--fix"]);
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        "⚠️ ~/.claude.json\n   Claude configuration file doesn't exist",
      );
      expect(result.output).toContain("Fix: dotfiles install");
      expect(result.output).not.toContain("MCP source file");
      summary(result.output, 0, 1, 0);
    }, 15000);

    it("should report a missing isolated MCP source", () => {
      writeFileSync(join(home, ".claude.json"), '{"mcpServers":{}}\n');
      config.mcp = {
        sourceFile: join(configDir, "missing-mcp.json"),
        targetFile: join(home, ".claude.json"),
        mergeKey: "mcpServers",
      };
      writeConfig();
      const result = diagnose("mcp");
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `❌ MCP source\n   MCP source file missing: ${join(configDir, "missing-mcp.json")}`,
      );
      expect(result.output).not.toContain("MCP configuration backup exists");
      summary(result.output, 1, 0, 1);
    }, 15000);
  });

  describe("command structure", () => {
    it("should export doctorCommand", () => {
      expect(typeof doctorCommand).toBe("object");
      expect(doctorCommand.name).toBe("doctor");
      expect(doctorCommand.description).toBe(
        "Diagnose and fix common dotfiles environment issues",
      );
      expect(typeof doctorCommand.run).toBe("function");
    });

    it("should have correct command arguments", () => {
      expect(doctorCommand.args?.config).toMatchObject({
        type: "string",
        default: "",
        short: "c",
      });
      expect(doctorCommand.args?.verbose).toMatchObject({
        type: "boolean",
        default: false,
        short: "v",
      });
      expect(doctorCommand.args?.fix).toMatchObject({
        type: "boolean",
        default: false,
        short: "f",
      });
      expect(doctorCommand.args?.check).toMatchObject({
        type: "string",
        short: "c",
      });
    });
  });
});
