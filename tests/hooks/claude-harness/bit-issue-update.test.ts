import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const HOOK = join(
  ROOT,
  "claude/.claude/hooks/task-completed/bit-issue-update.sh",
);

interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const runHook = async (
  input: Record<string, unknown>,
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<HookResult> => {
  const proc = Bun.spawn(["bash", HOOK], {
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

const setupRepoWithBitStub = async (
  name: string,
  branch: string,
): Promise<{ directory: string; bin: string; calls: string }> => {
  const directory = await setupTestDirectory(name);
  const bin = join(directory, "bin");
  const calls = join(directory, "bit-calls.log");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    join(bin, "bit"),
    [
      "#!/usr/bin/env bash",
      String.raw`printf "%s\n" "$*" >> "$BIT_CALLS"`,
      'if [ "$1 $2 $3" = "issue list --open" ]; then',
      String.raw`  printf "%s\n" "$BIT_OPEN_LINES"`,
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );
  const init = Bun.spawn(["git", "init", "-q", "-b", branch, directory], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await init.exited).toBe(0);
  return { directory, bin, calls };
};

describe("TaskCompleted bit issue hook", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
  });

  test("closes the issue matching the sequence-aware task title", async () => {
    const { directory, bin, calls } = await setupRepoWithBitStub(
      "claude-bit-task-seq",
      "feature/harness",
    );
    tempDirectories.push(directory);

    const result = await runHook(
      { task_id: "task-123", task_subject: "Implement adapter" },
      directory,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
        BIT_CALLS: calls,
        BIT_OPEN_LINES:
          "#42 [open] [task:feature/harness#3:task-123] Implement adapter",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const recorded = await fs.readFile(calls, "utf8");
    expect(recorded).toContain("issue comment add 42");
    expect(recorded).toContain("--body Task completed: Implement adapter");
    expect(recorded).toContain("issue close 42");
  });

  test("falls back to the legacy title format", async () => {
    const { directory, bin, calls } = await setupRepoWithBitStub(
      "claude-bit-task-legacy",
      "feature/harness",
    );
    tempDirectories.push(directory);

    const result = await runHook(
      { task_id: "task-9", task_subject: "Legacy task" },
      directory,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
        BIT_CALLS: calls,
        BIT_OPEN_LINES: "#7 [open] [task:feature/harness:task-9] Legacy task",
      },
    );

    expect(result.exitCode).toBe(0);
    const recorded = await fs.readFile(calls, "utf8");
    expect(recorded).toContain("issue comment add 7");
    expect(recorded).toContain("issue close 7");
  });

  test("ignores issues from other branches or other task ids", async () => {
    const { directory, bin, calls } = await setupRepoWithBitStub(
      "claude-bit-task-nomatch",
      "feature/harness",
    );
    tempDirectories.push(directory);

    const result = await runHook(
      { task_id: "task-123", task_subject: "No match" },
      directory,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
        BIT_CALLS: calls,
        BIT_OPEN_LINES: [
          "#1 [open] [task:other-branch#1:task-123] Other branch",
          "#2 [open] [task:feature/harness#1:task-999] Other task",
        ].join("\n"),
      },
    );

    expect(result.exitCode).toBe(0);
    const recorded = await fs.readFile(calls, "utf8");
    expect(recorded).not.toContain("issue close");
  });

  test("does nothing when task_id is missing", async () => {
    const { directory, bin, calls } = await setupRepoWithBitStub(
      "claude-bit-task-noid",
      "feature/harness",
    );
    tempDirectories.push(directory);

    const result = await runHook({}, directory, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: join(directory, "tmp"),
      BIT_CALLS: calls,
      BIT_OPEN_LINES: "#42 [open] [task:feature/harness#3:task-123] Anything",
    });

    expect(result.exitCode).toBe(0);
    expect(fs.access(calls)).rejects.toThrow();
  });
});
