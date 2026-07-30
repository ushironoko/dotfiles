import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const WRAPPER = join(ROOT, "claude/.claude/hooks/lib/codex-stage.sh");
const tempDirectories: string[] = [];

const setupFixture = async () => {
  const root = await setupTestDirectory("codex-stage-wrapper");
  tempDirectories.push(root);
  const target = join(root, "target");
  const bin = join(root, "bin");
  const temporaryDirectory = join(root, "tmp");
  await fs.mkdir(target);
  await fs.mkdir(bin);
  await fs.mkdir(temporaryDirectory);
  await fs.writeFile(
    join(bin, "codex"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `if [ "${"$"}{1:-} ${"$"}{2:-}" = "login status" ]; then exit 0; fi`,
      "cat >/dev/null",
      String.raw`printf 'PWD=%s\n' "$PWD"`,
      "printf 'ARGS='",
      "printf ' <%s>' \"$@\"",
      String.raw`printf '\n'`,
    ].join("\n"),
    { mode: 0o700 },
  );
  return { root, target, bin, temporaryDirectory };
};

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

const runPrompt = (
  fixture: Fixture,
  args: string[],
  env: Record<string, string> = {},
) =>
  Bun.spawnSync(["bash", WRAPPER, "prompt", ...args], {
    cwd: fixture.root,
    env: {
      HOME: fixture.root,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      TMPDIR: fixture.temporaryDirectory,
      ...env,
    },
    stdin: Buffer.from("Return a smoke result."),
    stdout: "pipe",
    stderr: "pipe",
  });

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs = 2_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  return !isProcessAlive(pid);
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

describe("codex-stage execution boundary", () => {
  test("runs Codex from the requested canonical cwd without -C", async () => {
    const fixture = await setupFixture();
    const result = runPrompt(fixture, [
      "--dir",
      fixture.target,
      "--timeout",
      "10",
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`PWD=${await fs.realpath(fixture.target)}`);
    expect(stdout).toContain("<exec> <--sandbox> <read-only>");
    expect(stdout).not.toContain("<-C>");
    expect(result.stderr.toString()).toBe("");
  });

  test("rejects sandbox-external output and unsafe numeric controls", async () => {
    const fixture = await setupFixture();
    const output = join(fixture.root, "review-output.md");
    const injected = join(fixture.root, "injected");
    const cases: { args: string[]; error: string }[] = [
      { args: ["--out", output], error: "unknown argument: --out" },
      { args: ["--timeout", "0"], error: "must be between 1 and 3600" },
      { args: ["--timeout", "01"], error: "canonical decimal integer" },
      { args: ["--timeout", "10x"], error: "canonical decimal integer" },
      { args: ["--timeout", "10 "], error: "canonical decimal integer" },
      { args: ["--timeout", "3601"], error: "must be between 1 and 3600" },
      { args: ["--retry", "-1"], error: "canonical decimal integer" },
      { args: ["--retry", "1x"], error: "canonical decimal integer" },
      { args: ["--retry", "11"], error: "must be between 0 and 10" },
      { args: ["--retry-wait", "30x"], error: "canonical decimal integer" },
      { args: ["--retry-wait", "301"], error: "must be between 0 and 300" },
      { args: ["--retry-wait", "LANG"], error: "canonical decimal integer" },
    ];

    for (const value of cases) {
      const result = runPrompt(fixture, value.args, {
        LANG: `x[$(touch ${injected})]`,
      });
      expect(result.exitCode).toBe(13);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain(value.error);
    }
    expect(await Bun.file(output).exists()).toBe(false);
    expect(await Bun.file(injected).exists()).toBe(false);
  });

  test("kills a TERM-ignoring Codex grandchild process group on timeout", async () => {
    const fixture = await setupFixture();
    const grandchildPidFile = join(fixture.root, "grandchild.pid");
    await fs.writeFile(
      join(fixture.bin, "codex"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        `if [ "${"$"}{1:-} ${"$"}{2:-}" = "login status" ]; then exit 0; fi`,
        "cat >/dev/null",
        String.raw`bash -c 'trap "" TERM; printf "%s" "$$" > "$GRANDCHILD_PID_FILE"; while :; do sleep 1; done' &`,
        "wait",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = Bun.spawnSync(
      ["bash", WRAPPER, "prompt", "--dir", fixture.target, "--timeout", "1"],
      {
        cwd: fixture.root,
        env: {
          GRANDCHILD_PID_FILE: grandchildPidFile,
          HOME: fixture.root,
          PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
          TMPDIR: fixture.temporaryDirectory,
        },
        stdin: Buffer.from("Timeout this run."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(124);
    expect(result.stderr.toString()).toContain("codex timed out after 1s");
    const grandchildPid = Number(await fs.readFile(grandchildPidFile, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    const exited = await waitForProcessExit(grandchildPid);
    if (!exited) process.kill(grandchildPid, "SIGKILL");
    expect(exited).toBe(true);
  }, 10_000);

  test("retains the watchdog when the Codex leader exits before its grandchild", async () => {
    const fixture = await setupFixture();
    const grandchildPidFile = join(fixture.root, "early-exit-grandchild.pid");
    await fs.writeFile(
      join(fixture.bin, "codex"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        `if [ "${"$"}{1:-} ${"$"}{2:-}" = "login status" ]; then exit 0; fi`,
        "cat >/dev/null",
        String.raw`bash -c 'trap "" TERM; printf "%s" "$$" > "$GRANDCHILD_PID_FILE"; while :; do sleep 1; done' &`,
        "exit 0",
      ].join("\n"),
      { mode: 0o700 },
    );
    await fs.writeFile(join(fixture.bin, "ps"), "#!/bin/bash\nexit 99\n", {
      mode: 0o700,
    });

    const result = Bun.spawnSync(
      ["bash", WRAPPER, "prompt", "--dir", fixture.target, "--timeout", "1"],
      {
        cwd: fixture.root,
        env: {
          GRANDCHILD_PID_FILE: grandchildPidFile,
          HOME: fixture.root,
          PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
          TMPDIR: fixture.temporaryDirectory,
        },
        stdin: Buffer.from("Leader exits before timeout."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(124);
    expect(result.stderr.toString()).toContain("codex timed out after 1s");
    const grandchildPid = Number(await fs.readFile(grandchildPidFile, "utf8"));
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    const exited = await waitForProcessExit(grandchildPid);
    if (!exited) process.kill(grandchildPid, "SIGKILL");
    expect(exited).toBe(true);
  }, 10_000);
});
