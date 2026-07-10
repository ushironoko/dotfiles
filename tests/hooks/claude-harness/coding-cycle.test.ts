import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const HOOK = join(ROOT, "claude/.claude/hooks/post_tool_use/coding_cycle.sh");

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const runHook = async (
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookResult> => {
  const proc = Bun.spawn(["bash", HOOK], {
    cwd,
    env: { ...process.env },
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

describe("coding cycle format hook", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
  });

  const setupProject = async (
    name: string,
    packageJson: Record<string, unknown> | null,
  ): Promise<string> => {
    const directory = await setupTestDirectory(name);
    tempDirectories.push(directory);
    if (packageJson !== null) {
      await fs.writeFile(
        join(directory, "package.json"),
        JSON.stringify(packageJson),
      );
    }
    return directory;
  };

  test("runs the format script for a TypeScript file and stays silent on success", async () => {
    const directory = await setupProject("coding-cycle-ok", {
      scripts: { format: "touch format-ran" },
    });

    const result = await runHook(
      {
        tool_input: { file_path: join(directory, "src.ts") },
        cwd: directory,
      },
      directory,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    await fs.access(join(directory, "format-ran"));
  });

  test("emits a block decision when the format script fails", async () => {
    const directory = await setupProject("coding-cycle-fail", {
      scripts: { format: "exit 1" },
    });

    const result = await runHook(
      {
        tool_input: { file_path: join(directory, "src.ts") },
        cwd: directory,
      },
      directory,
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { decision: string };
    expect(output.decision).toBe("block");
  });

  test("skips files that are not JavaScript or TypeScript", async () => {
    const directory = await setupProject("coding-cycle-skip-ext", {
      scripts: { format: "touch format-ran" },
    });

    const result = await runHook(
      {
        tool_input: { file_path: join(directory, "README.md") },
        cwd: directory,
      },
      directory,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.access(join(directory, "format-ran"))).rejects.toThrow();
  });

  test("skips projects without a format script", async () => {
    const directory = await setupProject("coding-cycle-no-script", {
      scripts: { lint: "exit 0" },
    });

    const result = await runHook(
      {
        tool_input: { file_path: join(directory, "src.ts") },
        cwd: directory,
      },
      directory,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
