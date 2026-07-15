import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import dotfilesConfig from "../../../dotfiles.config";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const HOOKS_JSON = join(ROOT, "codex/hooks.json");
const hook = (path: string): string => join(ROOT, "codex/hooks", path);

const listRelativeFiles = async (
  root: string,
  relative = "",
): Promise<string[]> => {
  const entries = await fs.readdir(join(root, relative), {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(relative, entry.name);
      return entry.isDirectory() ? listRelativeFiles(root, path) : [path];
    }),
  );
  return nested.flat().sort();
};

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const runHook = async (
  path: string,
  input: Record<string, unknown>,
  cwd = ROOT,
  env: Record<string, string | undefined> = {},
  args: string[] = [],
): Promise<HookResult> => {
  const proc = Bun.spawn(["bash", hook(path), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
};

beforeAll(async () => {
  await fs.access(HOOKS_JSON);
});

describe("Codex hooks configuration", () => {
  test("uses only supported synchronous command handlers", async () => {
    const config = JSON.parse(await fs.readFile(HOOKS_JSON, "utf8")) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    const supportedEvents = new Set([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]);

    expect(
      Object.keys(config.hooks).every((event) => supportedEvents.has(event)),
    ).toBe(true);
    expect(config.hooks.SubagentStop).toBeUndefined();
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(handler.type).toBe("command");
          expect(handler.async).toBeUndefined();
          expect(typeof handler.command).toBe("string");
        }
      }
    }
  });
});

describe("Codex harness deployment", () => {
  test("links every managed child without owning shared parent directories", async () => {
    const agentEntries = await fs.readdir(join(ROOT, "codex/agents"));
    const skillEntries = await fs.readdir(join(ROOT, "claude/.claude/skills"), {
      withFileTypes: true,
    });
    const cases = [
      {
        target: "~/.codex/agents",
        expected: agentEntries.filter((name) => name.endsWith(".toml")).sort(),
      },
      {
        target: "~/.codex/hooks",
        expected: await listRelativeFiles(join(ROOT, "codex/hooks")),
      },
      {
        target: "~/.agents/skills",
        expected: skillEntries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort(),
      },
    ];

    for (const { target, expected } of cases) {
      const mapping = dotfilesConfig.mappings.find(
        (candidate) => candidate.target === target,
      );
      expect(mapping?.type).toBe("selective");
      expect([...(mapping?.include ?? [])].sort()).toEqual(expected);
    }
  });
});

describe("PreToolUse policies", () => {
  test("denies relay-backed bit commands", async () => {
    const result = await runHook("pre_tool_use/bit_command_policy.sh", {
      tool_name: "Bash",
      tool_input: { command: "bit clone relay+ssh://example/repo" },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows local bit issue reads", async () => {
    const result = await runHook("pre_tool_use/bit_command_policy.sh", {
      tool_name: "Bash",
      tool_input: { command: "bit issue list --open" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("enforces npm-script preference without a Claude home install", async () => {
    const result = await runHook(
      "pre_tool_use/npm_script_preference.sh",
      {
        tool_name: "Bash",
        cwd: ROOT,
        tool_input: { command: "bunx oxlint" },
      },
      ROOT,
      { HOME: join(ROOT, ".missing-test-home") },
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("PostToolUse adapters", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
  });

  test("reports unsafe syntax only from added TypeScript lines", async () => {
    const result = await runHook("post_tool_use/type_safety_check.sh", {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/example.ts",
          "@@",
          "-const value = source;",
          "+const value = source as any;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      decision: string;
      reason: string;
    };
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("src/example.ts");
    expect(output.reason).toContain("as any");
  });

  test("ignores unsafe syntax removed by a patch", async () => {
    const result = await runHook("post_tool_use/type_safety_check.sh", {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/example.ts",
          "@@",
          "-const value = source as any;",
          "+const value = source satisfies Value;",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("runs the project format script for TypeScript patches", async () => {
    const directory = await setupTestDirectory("codex-coding-cycle");
    tempDirectories.push(directory);
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "touch format-ran" } }),
    );
    const configPath = join(directory, "config.toml");
    await fs.writeFile(
      configPath,
      `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
    );

    const result = await runHook(
      "post_tool_use/coding_cycle.sh",
      {
        cwd: directory,
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/example.ts",
            "*** End Patch",
          ].join("\n"),
        },
      },
      directory,
      { CODEX_CONFIG_PATH: configPath },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(directory, "format-ran")).exists()).toBe(true);
  });

  test("never runs project scripts when project trust is unavailable", async () => {
    const directory = await setupTestDirectory("codex-coding-cycle-untrusted");
    tempDirectories.push(directory);
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "touch format-ran" } }),
    );

    const result = await runHook(
      "post_tool_use/coding_cycle.sh",
      {
        cwd: directory,
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/example.ts",
            "*** End Patch",
          ].join("\n"),
        },
      },
      directory,
      { CODEX_CONFIG_PATH: join(directory, "missing-config.toml") },
    );

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(directory, "format-ran")).exists()).toBe(false);
  });

  test("a trusted subdirectory cannot authorize an untrusted parent script", async () => {
    const directory = await setupTestDirectory("codex-coding-cycle-parent");
    const nested = join(directory, "trusted-child");
    const configPath = join(directory, "config.toml");
    tempDirectories.push(directory);
    await fs.mkdir(nested);
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "touch format-ran" } }),
    );
    await fs.writeFile(
      configPath,
      `[projects.${JSON.stringify(nested)}]\ntrust_level = "trusted"\n`,
    );

    const result = await runHook(
      "post_tool_use/coding_cycle.sh",
      {
        cwd: nested,
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/example.ts",
            "*** End Patch",
          ].join("\n"),
        },
      },
      nested,
      { CODEX_CONFIG_PATH: configPath },
    );

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(directory, "format-ran")).exists()).toBe(false);
  });

  test("Codex status runner records checks for a trusted project", async () => {
    const directory = await setupTestDirectory("codex-status-runner");
    const cacheDirectory = join(directory, "cache");
    const configPath = join(directory, "config.toml");
    tempDirectories.push(directory);
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: { lint: "true", typecheck: "true", test: "true" },
      }),
    );
    await fs.writeFile(join(directory, "bun.lock"), "");
    await fs.writeFile(join(directory, "tsconfig.json"), "{}");
    await fs.writeFile(
      configPath,
      `[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n`,
    );

    const result = await runHook(
      "lib/statusline_checks_run.sh",
      {},
      directory,
      {
        CODEX_CONFIG_PATH: configPath,
        STATUSLINE_CACHE_DIR: cacheDirectory,
        STATUSLINE_NOW_OVERRIDE: "1000",
      },
      [directory],
    );

    expect(result.exitCode).toBe(0);
    const cacheFiles = await fs.readdir(cacheDirectory);
    const cacheFile = cacheFiles.find((name) => name.endsWith(".json"));
    expect(cacheFile).toBeDefined();
    const cache = JSON.parse(
      await fs.readFile(join(cacheDirectory, cacheFile ?? ""), "utf8"),
    ) as { checks: Record<string, { status: string }> };
    expect(cache.checks.lint?.status).toBe("ok");
    expect(cache.checks.typecheck?.status).toBe("ok");
    expect(cache.checks.test?.status).toBe("ok");
  });
});

describe("lifecycle compatibility", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
  });

  test("injects native agent guidance only for direct Codex ultracode prompts", async () => {
    const directEnv = { PI_CODING_AGENT: "false" };
    const enabled = await runHook(
      "user_prompt_submit/ultracode_context.sh",
      { prompt: "Use ultracode for this implementation" },
      ROOT,
      directEnv,
    );
    const disabled = await runHook(
      "user_prompt_submit/ultracode_context.sh",
      { prompt: "Implement this normally" },
      ROOT,
      directEnv,
    );
    const delegatedByPi = await runHook(
      "user_prompt_submit/ultracode_context.sh",
      { prompt: "Use ultracode for this implementation" },
      ROOT,
      { PI_CODING_AGENT: "true" },
    );

    const output = JSON.parse(enabled.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Codex native custom agents",
    );
    expect(disabled.stdout).toBe("");
    expect(delegatedByPi.exitCode).toBe(0);
    expect(delegatedByPi.stdout).toBe("");
  });

  test("explicit completion matches the sequence-aware bit task title", async () => {
    const directory = await setupTestDirectory("codex-bit-task");
    const bin = join(directory, "bin");
    const calls = join(directory, "bit-calls.log");
    tempDirectories.push(directory);
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      join(bin, "bit"),
      [
        "#!/usr/bin/env bash",
        String.raw`printf "%s\n" "$*" >> "$BIT_CALLS"`,
        `if [ "$1 $2" = "issue close" ] && [ "\${BIT_CLOSE_FAIL:-}" = "1" ]; then exit 1; fi`,
        'if [ "$1 $2 $3" = "issue list --open" ]; then',
        String.raw`  printf "%s\n" "$BIT_OPEN_LINE"`,
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    const init = Bun.spawn(
      ["git", "init", "-q", "-b", "feature/harness", directory],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await init.exited).toBe(0);

    const result = await runHook(
      "task_completed/bit_issue_update.sh",
      {},
      directory,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
        BIT_CALLS: calls,
        BIT_OPEN_LINE:
          "#42 [open] [task:feature/harness#3:task-123] Implement adapter",
      },
      ["task-123", "Implement", "adapter"],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const recorded = await fs.readFile(calls, "utf8");
    expect(recorded).toContain("issue comment add 42");
    expect(recorded).toContain("--body Task completed: Implement adapter");
    expect(recorded).toContain("issue close 42");

    const failed = await runHook(
      "task_completed/bit_issue_update.sh",
      {},
      directory,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
        BIT_CALLS: calls,
        BIT_CLOSE_FAIL: "1",
        BIT_OPEN_LINE:
          "#42 [open] [task:feature/harness#3:task-123] Implement adapter",
      },
      ["task-123", "Implement", "adapter"],
    );
    expect(failed.exitCode).toBe(1);
  });
});
