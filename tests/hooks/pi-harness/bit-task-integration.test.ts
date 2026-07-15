import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessConfig } from "../../../pi/extensions/pi-harness/config";
import setupBitTask from "../../../pi/extensions/pi-harness/features/bit-task/index";
import { resolvePaths } from "../../../pi/extensions/pi-harness/lib/paths";
import type {
  CtxLike,
  ToolDefLike,
} from "../../../pi/extensions/pi-harness/lib/pi-like";
import { createFakePi } from "../../pi-harness/fake-pi";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const CODEX_HOOKS = join(ROOT, "codex/hooks");

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TestRepo {
  directory: string;
  repo: string;
  worktrees: string;
  bin: string;
  calls: string;
  openIssues: string;
  env: Record<string, string | undefined>;
  config: HarnessConfig;
}

const tempDirectories: string[] = [];

const run = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<CommandResult> => {
  const process = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...globalThis.process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const runChecked = async (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<CommandResult> => {
  const result = await run(command, args, options);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
};

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: { ...resolvePaths(home), codexHooksDir: CODEX_HOOKS },
});

const setupRepo = async (branch = "feature/pi-bit-task"): Promise<TestRepo> => {
  const directory = await setupTestDirectory("pi-bit-task-integration", [
    "repo",
    "worktrees",
    "bin",
    "tmp",
  ]);
  tempDirectories.push(directory);
  const repo = join(directory, "repo");
  const worktrees = join(directory, "worktrees");
  const bin = join(directory, "bin");
  const calls = join(directory, "bit-calls.log");
  const openIssues = join(directory, "bit-open.txt");

  await runChecked("git", ["init", "-q", "-b", branch, repo]);
  await runChecked("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "test@example.com",
  ]);
  await runChecked("git", [
    "-C",
    repo,
    "config",
    "user.name",
    "Pi Harness Test",
  ]);
  await fs.writeFile(join(repo, "README.md"), "fixture\n");
  await runChecked("git", ["-C", repo, "add", "README.md"]);
  await runChecked("git", ["-C", repo, "commit", "-q", "-m", "initial"]);

  await fs.writeFile(
    join(bin, "gwq"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "$1" = "add" ] && [ "$2" = "-b" ]; then',
      '  git -C "$GWQ_REPO" worktree add -b "$3" "$GWQ_BASE/$3" >&2',
      'elif [ "$1" = "get" ]; then',
      String.raw`  printf "%s\n" "$GWQ_BASE/$2"`,
      "else",
      String.raw`  printf "unexpected gwq arguments: %s\n" "$*" >&2`,
      "  exit 2",
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.writeFile(
    join(bin, "bit"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      String.raw`printf "%s\n" "$*" >> "$BIT_CALLS"`,
      'if [ "$1 $2 $3" = "issue list --open" ]; then',
      '  cat "$BIT_OPEN_FILE"',
      'elif [ "$1 $2" = "issue close" ]; then',
      '  awk -v id="$3" \'index($0, "#" id " ") != 1 { print }\' "$BIT_OPEN_FILE" > "$BIT_OPEN_FILE.tmp"',
      '  mv "$BIT_OPEN_FILE.tmp" "$BIT_OPEN_FILE"',
      "fi",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.writeFile(openIssues, "");

  const env = {
    HOME: directory,
    PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
    TMPDIR: join(directory, "tmp"),
    GWQ_REPO: repo,
    GWQ_BASE: worktrees,
    BIT_CALLS: calls,
    BIT_OPEN_FILE: openIssues,
  };
  return {
    directory,
    repo,
    worktrees,
    bin,
    calls,
    openIssues,
    env,
    config: makeConfig(directory),
  };
};

const executeTool = (
  tool: ToolDefLike,
  params: Record<string, unknown>,
  ctx: CtxLike,
): Promise<unknown> =>
  Promise.resolve(
    Reflect.apply(tool.execute, undefined, [
      "bit-task-integration",
      params,
      undefined,
      undefined,
      ctx,
    ]),
  );

const getTool = (tools: ToolDefLike[], name: string): ToolDefLike => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Tool not registered: ${name}`);
  return tool;
};

const readTextResult = (result: unknown): string => {
  if (result === null || typeof result !== "object") {
    throw new Error("Tool result was not an object");
  }
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) throw new Error("Tool result had no content");
  const [first] = content;
  if (first === null || typeof first !== "object") {
    throw new Error("Tool result had no first content block");
  }
  const text = Reflect.get(first, "text");
  if (typeof text !== "string") throw new Error("Tool result was not text");
  return text;
};

const setupTools = (fixture: TestRepo) => {
  const pi = createFakePi({ cwd: fixture.repo });
  setupBitTask(pi, fixture.config, {
    cwd: fixture.repo,
    env: fixture.env,
  });
  return pi;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

describe("pi-harness bit-task integration", () => {
  test("creates a genuine linked worktree and returns its absolute path", async () => {
    const fixture = await setupRepo();
    const pi = setupTools(fixture);
    const result = await executeTool(
      getTool(pi.tools, "worktree_create"),
      { name: "pi-worktree-create" },
      pi.ctx,
    );
    const expected = await fs.realpath(
      join(fixture.worktrees, "pi-worktree-create"),
    );

    expect(readTextResult(result)).toBe(expected);
  });

  test("rejects a successful create hook that returns a nonexistent path", async () => {
    const fixture = await setupRepo();
    const hooks = join(fixture.directory, "fake-hooks");
    await fs.mkdir(join(hooks, "worktree"), { recursive: true });
    const bogusPath = join(fixture.directory, "does-not-exist");
    await fs.writeFile(
      join(hooks, "worktree/create.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${bogusPath}'\n`,
      { mode: 0o755 },
    );
    const config: HarnessConfig = {
      ...fixture.config,
      paths: { ...fixture.config.paths, codexHooksDir: hooks },
    };
    const pi = createFakePi({ cwd: fixture.repo });
    setupBitTask(pi, config, { cwd: fixture.repo, env: fixture.env });

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_create"),
        { name: "bogus-success" },
        pi.ctx,
      ),
    ).rejects.toThrow(/worktree_create postcondition failed/i);
  });

  test("removes a clean worktree created through the tool", async () => {
    const fixture = await setupRepo();
    const pi = setupTools(fixture);
    const created = readTextResult(
      await executeTool(
        getTool(pi.tools, "worktree_create"),
        { name: "pi-worktree-remove" },
        pi.ctx,
      ),
    );

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: created, confirmed: true },
        pi.ctx,
      ),
    ).resolves.toBeDefined();
    const listed = await runChecked("git", [
      "-C",
      fixture.repo,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(listed.stdout).not.toContain(`worktree ${created}`);
    expect(fs.access(created)).rejects.toThrow();
  });

  test("surfaces the real remove hook's dirty-worktree refusal", async () => {
    const fixture = await setupRepo();
    const pi = setupTools(fixture);
    const created = readTextResult(
      await executeTool(
        getTool(pi.tools, "worktree_create"),
        { name: "pi-worktree-dirty" },
        pi.ctx,
      ),
    );
    await fs.writeFile(join(created, "untracked.txt"), "dirty\n");

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: created, confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/dirty/i);
    const createdStat = await fs.stat(created);
    expect(createdStat.isDirectory()).toBe(true);
  });

  test("refuses to remove the current repository toplevel", async () => {
    const fixture = await setupRepo();
    const pi = setupTools(fixture);

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: fixture.repo, confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/refuses to remove the current repository checkout/i);
    const repoStat = await fs.stat(fixture.repo);
    expect(repoStat.isDirectory()).toBe(true);
  });

  test("refuses to remove a subdirectory of the current checkout", async () => {
    const fixture = await setupRepo();
    const subdirectory = join(fixture.repo, "nested");
    await fs.mkdir(subdirectory);
    const pi = setupTools(fixture);

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: subdirectory, confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/registered linked worktree/i);
    const subdirectoryStat = await fs.stat(subdirectory);
    expect(subdirectoryStat.isDirectory()).toBe(true);
  });

  test("canonicalizes a symlink before refusing the current checkout", async () => {
    const fixture = await setupRepo();
    const symlink = join(fixture.directory, "repo-link");
    await fs.symlink(fixture.repo, symlink);
    const pi = setupTools(fixture);

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: symlink, confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/refuses to remove the current repository checkout/i);
    const repoStat = await fs.stat(fixture.repo);
    expect(repoStat.isDirectory()).toBe(true);
  });

  test("refuses a linked worktree owned by another repository", async () => {
    const fixture = await setupRepo();
    const repoB = join(fixture.directory, "repo-b");
    const worktreeB = join(fixture.directory, "repo-b-worktree");
    await runChecked("git", ["init", "-q", "-b", "main", repoB]);
    await runChecked("git", [
      "-C",
      repoB,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await runChecked("git", [
      "-C",
      repoB,
      "config",
      "user.name",
      "Pi Harness Test",
    ]);
    await fs.writeFile(join(repoB, "README.md"), "repo b\n");
    await runChecked("git", ["-C", repoB, "add", "README.md"]);
    await runChecked("git", ["-C", repoB, "commit", "-q", "-m", "initial"]);
    await runChecked("git", [
      "-C",
      repoB,
      "worktree",
      "add",
      "-q",
      "-b",
      "linked-b",
      worktreeB,
    ]);
    const pi = setupTools(fixture);

    await expect(
      executeTool(
        getTool(pi.tools, "worktree_remove"),
        { path: worktreeB, confirmed: true },
        pi.ctx,
      ),
    ).rejects.toThrow(/another repository/i);
    const worktreeStat = await fs.stat(worktreeB);
    expect(worktreeStat.isDirectory()).toBe(true);
  });

  test("closes a matching bit task and verifies that it is no longer open", async () => {
    const branch = "feature/pi-bit-task";
    const fixture = await setupRepo(branch);
    await fs.writeFile(
      fixture.openIssues,
      `#42 [open] [task:${branch}#3:task-123] Implement adapter\n`,
    );
    const pi = setupTools(fixture);

    const result = await executeTool(
      getTool(pi.tools, "task_completed"),
      { task_id: "task-123", task_subject: "Implement adapter" },
      pi.ctx,
    );
    const recorded = await fs.readFile(fixture.calls, "utf8");
    const remainingOpen = await fs.readFile(fixture.openIssues, "utf8");
    expect(readTextResult(result)).toContain("completed and verified");
    expect(recorded).toContain("issue comment add 42");
    expect(recorded).toContain("issue close 42");
    expect(remainingOpen).not.toContain(`[task:${branch}#3:task-123]`);
  });
});
