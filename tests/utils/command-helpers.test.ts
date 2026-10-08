import { describe, expect, it } from "bun:test";
import {
  define,
  baseCommandArgs,
  createCommandContext,
} from "../../src/utils/command-helpers";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCommand } from "../../src/commands/install";
import { restoreCommand } from "../../src/commands/restore";
import { listCommand } from "../../src/commands/list";
import { doctorCommand } from "../../src/commands/doctor";
import { analyzeCommand } from "../../src/commands/analyze";
import { logproxyCommand } from "../../src/commands/logproxy";
import { captureLogger } from "./logger-output-fixture";
import { dryRunArg } from "../../src/types/command";

const withNativeHelp = (
  check: (run: (args: string[]) => SpawnSyncReturns<string>) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-command-help-"));
  const records: Record<string, unknown>[] = [];
  try {
    let ancestor = realpathSync(root);
    for (;;) {
      assert.equal(existsSync(join(ancestor, ".git")), false);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const home = join(root, "home");
    const bin = join(root, "bin");
    const temp = join(root, "temp");
    for (const path of [home, bin, temp]) mkdirSync(path);
    const env = {
      HOME: home,
      PATH: bin,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      NO_COLOR: "1",
      NODE_ENV: "cli-audit",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: join(home, "agent"),
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    check((args) => {
      const argv = [
        process.execPath,
        fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
        ...args,
      ];
      const started = performance.now();
      const result = spawnSync(argv[0], argv.slice(1), {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10000,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
      });
      records.push({
        argv,
        cwd: root,
        env,
        duration_ms: performance.now() - started,
        deadline_ms: 10000,
        exit_code: result.status,
        signal: result.signal,
        timeout: Boolean(
          result.error &&
            "code" in result.error &&
            result.error.code === "ETIMEDOUT",
        ),
        driver_error: result.error?.message ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (result.error) throw result.error;
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      return result;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    const cleanupAbsent = !existsSync(root);
    const evidence = process.env.CLI_LOGGER_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      for (const record of records)
        writeFileSync(
          join(evidence, `help-${randomUUID()}.json`),
          JSON.stringify({ ...record, cleanup_absent: cleanupAbsent }, null, 2),
          { mode: 0o600 },
        );
    }
    assert.equal(cleanupAbsent, true, `Fixture cleanup failed: ${root}`);
  }
};

describe("command-helpers", () => {
  describe("define with baseCommandArgs", () => {
    it("should merge base args with custom args", () => {
      const command = define({
        name: "test",
        description: "Test command",
        args: {
          ...baseCommandArgs,
          ...dryRunArg,
          custom: {
            default: "value",
            description: "Custom arg",
            short: "x",
            type: "string" as const,
          },
        },
        run: async () => {},
      });

      expect(command.args).toHaveProperty("config");
      expect(command.args).toHaveProperty("verbose");
      expect(command.args).toHaveProperty("dryRun");
      expect(command.args).toHaveProperty("custom");
      expect(command.args?.config).toEqual(baseCommandArgs.config);
      expect(command.args?.verbose).toEqual(baseCommandArgs.verbose);
    });

    it("should preserve command metadata", () => {
      const command = define({
        name: "test",
        description: "Test command",
        args: {
          ...baseCommandArgs,
        },
        run: async () => {},
      });

      expect(command.name).toBe("test");
      expect(command.description).toBe("Test command");
    });
  });

  describe("createCommandContext", () => {
    it("should create context with logger", () => {
      const context = createCommandContext({
        verbose: true,
        dryRun: false,
      });

      for (const method of [
        "info",
        "error",
        "warn",
        "success",
        "debug",
        "action",
        "setVerbose",
        "setDryRun",
      ] as const) {
        expect(typeof context.logger[method]).toBe("function");
      }
    });

    it("should pass options to logger", () => {
      const cases = [
        [
          "context-plain",
          "[info] INFO_MARKER\n[success] SUCCESS_MARKER\n[log] → ACTION_MARKER DETAIL_MARKER\n",
        ],
        [
          "context-verbose",
          "[info] INFO_MARKER\n[success] SUCCESS_MARKER\n[log] → ACTION_MARKER DETAIL_MARKER\n[debug] DEBUG_MARKER\n",
        ],
        [
          "context-dry",
          "[info] [DRY RUN] INFO_MARKER\n[success] [DRY RUN] SUCCESS_MARKER\n[log] → [DRY RUN] ACTION_MARKER DETAIL_MARKER\n",
        ],
        [
          "context-combined",
          "[info] [DRY RUN] INFO_MARKER\n[success] [DRY RUN] SUCCESS_MARKER\n[log] → [DRY RUN] ACTION_MARKER DETAIL_MARKER\n[debug] DEBUG_MARKER\n",
        ],
      ];
      for (const [scenario, stdout] of cases) {
        const result = captureLogger(scenario);
        expect(result.exit_code).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toBe(stdout);
        expect(result.stderr).toBe(
          "[warn] WARN_MARKER\n[error] ERROR_MARKER\n",
        );
        expect(result.stderr).not.toContain("[DRY RUN]");
      }
      const transitions = captureLogger("context-transitions");
      expect(transitions.exit_code).toBe(0);
      expect(transitions.signal).toBeNull();
      expect(transitions.stdout).toBe(
        "[info] PLAIN_BEFORE\n[debug] VISIBLE_DURING\n[info] [DRY RUN] DRY_DURING\n[success] [DRY RUN] DRY_SUCCESS\n[log] → [DRY RUN] DRY_ACTION DRY_DETAIL\n[info] OTHER_PLAIN\n[success] OTHER_SUCCESS\n[log] → OTHER_ACTION OTHER_DETAIL\n[info] PLAIN_AFTER\n[success] PLAIN_SUCCESS\n[log] → PLAIN_ACTION PLAIN_DETAIL\n",
      );
      expect(transitions.stdout).not.toContain("HIDDEN");
      expect(transitions.stderr).toBe("");
    });
  });

  describe("registered public commands", () => {
    it("should preserve all six actual command objects and exact common argument metadata", () => {
      const commands = [
        installCommand,
        restoreCommand,
        listCommand,
        doctorCommand,
        analyzeCommand,
        logproxyCommand,
      ];
      expect(commands.map((command) => command.name)).toEqual([
        "install",
        "restore",
        "list",
        "doctor",
        "analyze",
        "logproxy",
      ]);
      expect(new Set(commands.map((command) => command.name)).size).toBe(6);
      expect(
        commands.map((command) => Object.keys(command.args ?? {}).sort()),
      ).toEqual(
        [
          ["config", "verbose", "dryRun", "force", "select"],
          ["config", "verbose", "backup", "dryRun", "interactive", "partial"],
          ["config", "verbose"],
          ["config", "verbose", "fix", "check"],
          [
            "verbose",
            "session",
            "days",
            "format",
            "patterns",
            "minFrequency",
            "maxLength",
          ],
          [
            "port",
            "host",
            "upstream",
            "dir",
            "keepDays",
            "gzipIdleMinutes",
            "session",
            "turn",
            "format",
            "full",
            "verbose",
          ],
        ].map((names) => names.sort()),
      );

      expect(commands.map((command) => command.description)).toEqual([
        "Install dotfiles by creating symlinks",
        "Restore from a backup",
        "List managed dotfiles and their status",
        "Diagnose and fix common dotfiles environment issues",
        "Analyze Claude Code operation logs",
        "Capture Claude Code context-window payloads via a local reverse proxy",
      ]);
      for (const command of commands) {
        expect(typeof command.run).toBe("function");
        expect(command.args?.verbose.type).toBe("boolean");
        expect(command.args?.verbose.default).toBe(false);
        expect(command.args?.verbose.short).toBe("v");
        expect(command.description?.trim().length).toBeGreaterThan(0);
      }
      expect(
        commands.map((command) => command.args?.verbose.description),
      ).toEqual([
        "Verbose output",
        "Verbose output",
        "Verbose output",
        "Verbose output",
        "Verbose output with session details",
        "Verbose output",
      ]);
      for (const command of [
        installCommand,
        restoreCommand,
        listCommand,
        doctorCommand,
      ]) {
        expect(command.args?.config).toEqual({
          type: "string",
          default: "",
          short: "c",
          description: "Path to config directory or file",
        });
      }
      for (const command of [analyzeCommand, logproxyCommand])
        expect(command.args).not.toHaveProperty("config");
      for (const command of [installCommand, restoreCommand]) {
        expect(command.args?.dryRun).toEqual({
          type: "boolean",
          default: false,
          short: "d",
          description: "Perform a dry run without making changes",
        });
      }
      for (const command of [
        listCommand,
        doctorCommand,
        analyzeCommand,
        logproxyCommand,
      ])
        expect(command.args).not.toHaveProperty("dryRun");
      expect(doctorCommand.args?.fix).toEqual({
        type: "boolean",
        default: false,
        short: "f",
        description:
          "Attempt to automatically fix issues (not yet implemented)",
      });
      expect(doctorCommand.args?.check).toEqual({
        type: "string",
        short: "c",
        description:
          "Comma-separated list of categories to check (environment,conflicts,ghq,config,mcp)",
      });
      expect(doctorCommand.args?.config.short).toBe("c");
    });

    it("should expose top-level registration order and reject unknown commands", () => {
      withNativeHelp((run) => {
        const help = run(["--help"]);
        expect(help.status).toBe(0);
        expect(
          [...help.stdout.matchAll(/^  ([a-z][a-z-]*)\s+-/gm)].map(
            (match) => match[1],
          ),
        ).toEqual([
          "install",
          "restore",
          "list",
          "doctor",
          "analyze",
          "logproxy",
        ]);
        expect(help.stdout).toContain("Usage: dotfiles <command> [options]\n");
        const unknown = run(["unknown-fixture-command"]);
        expect(unknown.status).toBe(1);
        expect(unknown.stdout).toContain(
          "Unknown command: unknown-fixture-command\n",
        );
      });
    });

    it("should corroborate all six registrations through native public help", () => {
      const cases = [
        {
          name: "install",
          description: "Install dotfiles by creating symlinks",
          options: [
            [
              "-c, --config <config>",
              "Path to config directory or file (default: )",
            ],
            ["-v, --verbose", "Verbose output (default: false)"],
            [
              "-d, --dryRun",
              "Perform a dry run without making changes (default: false)",
            ],
            ["-f, --force", "Force overwrite existing files (default: false)"],
            [
              "-s, --select",
              "Interactively select which files to install (default: false)",
            ],
          ],
        },
        {
          name: "restore",
          description: "Restore from a backup",
          options: [
            [
              "-c, --config <config>",
              "Path to config directory or file (default: )",
            ],
            ["-v, --verbose", "Verbose output (default: false)"],
            ["-b, --backup <backup>", "Backup timestamp or path"],
            [
              "-d, --dryRun",
              "Perform a dry run without making changes (default: false)",
            ],
            ["-i, --interactive", "Interactive mode (default: true)"],
            ["-p, --partial <partial>", "Restore specific files only"],
          ],
        },
        {
          name: "list",
          description: "List managed dotfiles and their status",
          options: [
            [
              "-c, --config <config>",
              "Path to config directory or file (default: )",
            ],
            ["-v, --verbose", "Verbose output (default: false)"],
          ],
        },
        {
          name: "doctor",
          description: "Diagnose and fix common dotfiles environment issues",
          options: [
            [
              "-c, --config <config>",
              "Path to config directory or file (default: )",
            ],
            ["-v, --verbose", "Verbose output (default: false)"],
            [
              "-f, --fix",
              "Attempt to automatically fix issues (not yet implemented) (default: false)",
            ],
            [
              "-c, --check <check>",
              "Comma-separated list of categories to check (environment,conflicts,ghq,config,mcp)",
            ],
          ],
        },
        {
          name: "analyze",
          description: "Analyze Claude Code operation logs",
          options: [
            [
              "-v, --verbose",
              "Verbose output with session details (default: false)",
            ],
            ["-s, --session <session>", "Analyze a specific session by ID"],
            [
              "-d, --days [days]",
              "Number of days to analyze (default: 7) (default: 7)",
            ],
            [
              "-f, --format [format]",
              "Output format: text, json, or markdown (default: text)",
            ],
            [
              "-p, --patterns",
              "Include pattern detection in analysis (default: true)",
            ],
            [
              "--minFrequency [minFrequency]",
              "Minimum pattern frequency to report (default: 2)",
            ],
            [
              "--maxLength [maxLength]",
              "Maximum pattern sequence length (default: 5)",
            ],
          ],
        },
        {
          name: "logproxy",
          description:
            "Capture Claude Code context-window payloads via a local reverse proxy",
          options: [
            ["-p, --port [port]", "Proxy port (default: 8787) (default: 8787)"],
            ["--host [host]", "Bind host (loopback only) (default: 127.0.0.1)"],
            [
              "--upstream [upstream]",
              "Upstream Anthropic API base URL (default: https://api.anthropic.com)",
            ],
            ["--dir [dir]", "Log directory (default: ~/.claude/context-logs)"],
            [
              "--keepDays [keepDays]",
              "Delete logs older than N days (default: 14)",
            ],
            [
              "--gzipIdleMinutes [gzipIdleMinutes]",
              "Gzip a session after N idle minutes (default: 30)",
            ],
            ["-s, --session <session>", "Target session id (for tail/show)"],
            ["-t, --turn <turn>", "Turn to show (1-based; default: latest)"],
            [
              "-f, --format [format]",
              "show/tail --full format: text | json | md (default: text)",
            ],
            [
              "--full",
              "tail: render each new turn's full context (show-style) (default: false)",
            ],
            ["-v, --verbose", "Verbose output (default: false)"],
          ],
        },
      ];
      withNativeHelp((run) => {
        for (const { name, description, options } of cases) {
          const result = run([name, "--help"]);
          expect(result.status).toBe(0);
          const [header, optionText] = result.stdout.split("OPTIONS:\n");
          expect(header).toBe(
            `${description}\n\nUSAGE:\n  COMMAND ${name} <OPTIONS>\n\n`,
          );
          expect(optionText).toBeDefined();
          const rows = optionText.split("\n").filter((line) => line.length > 0);
          const actualOptions = rows.map((line) => {
            const match = /^  (-\S.*?)(?: {2,})(\S.*)$/.exec(line);
            expect(match).not.toBeNull();
            return [match?.[1], match?.[2]];
          });
          const expectedOptions = [
            ...options,
            ["-h, --help", "Display this help message"],
            ["-v, --version", "Display this version"],
          ];
          expect(actualOptions.sort()).toEqual(expectedOptions.sort());
        }
      });
    });
  });
});
