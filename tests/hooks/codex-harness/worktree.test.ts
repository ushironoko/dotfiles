import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const CREATE_HOOK = join(ROOT, "codex/hooks/worktree/create.sh");
const REMOVE_HOOK = join(ROOT, "codex/hooks/worktree/remove.sh");
const BRANCH = "harness-safety-test";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WorktreeFixture {
  root: string;
  repository: string;
  worktree: string;
  commonDirectory: string;
  markerPath: string;
}

const runCommand = async (
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
  } = {},
): Promise<CommandResult> => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined) {
    const { stdin } = proc;
    if (stdin === undefined)
      throw new Error("command stdin pipe is unavailable");
    stdin.write(options.input);
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
};

const runGit = async (args: string[], cwd?: string): Promise<CommandResult> => {
  const result = await runCommand(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const createFixture = async (): Promise<WorktreeFixture> => {
  const root = await fs.realpath(
    await setupTestDirectory("codex-worktree-safety"),
  );
  const repository = join(root, "repository");
  const worktree = join(root, "linked-worktree");
  await fs.mkdir(repository);
  await runGit(["init", "-q", "-b", "main", repository]);
  await runGit(["config", "user.email", "codex-test@example.com"], repository);
  await runGit(["config", "user.name", "Codex Test"], repository);
  await runGit(["commit", "-q", "--allow-empty", "-m", "initial"], repository);
  await runGit(["worktree", "add", "-q", "-b", BRANCH, worktree], repository);

  const commonDirectory = await fs.realpath(join(repository, ".git"));
  const markerDirectory = join(commonDirectory, "codex-harness-worktrees");
  const pathSha1 = createHash("sha1").update(worktree).digest("hex");
  const markerPath = join(markerDirectory, `${pathSha1}.json`);
  await fs.mkdir(markerDirectory, { mode: 0o700 });
  await fs.writeFile(
    markerPath,
    JSON.stringify({ path: worktree, branch: BRANCH }),
    { mode: 0o600 },
  );

  return { root, repository, worktree, commonDirectory, markerPath };
};

const runRemoveHook = async (
  fixture: WorktreeFixture,
  input: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> =>
  runCommand(["bash", REMOVE_HOOK], {
    cwd: fixture.repository,
    env,
    input: JSON.stringify(input),
  });

describe("Codex worktree removal safety", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(cleanupTestDirectory));
  });

  const fixture = async (): Promise<WorktreeFixture> => {
    const value = await createFixture();
    temporaryDirectories.push(value.root);
    return value;
  };

  test("rejects removal without explicit confirmation", async () => {
    const value = await fixture();
    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("confirmed=true");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("rejects a dirty linked worktree", async () => {
    const value = await fixture();
    await fs.writeFile(join(value.worktree, "untracked.txt"), "dirty\n");

    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
      confirmed: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dirty worktree");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("rejects a marker whose branch does not exactly match", async () => {
    const value = await fixture();
    await fs.writeFile(
      value.markerPath,
      JSON.stringify({ path: value.worktree, branch: "different-branch" }),
    );

    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
      confirmed: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("marker does not exactly match");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("removes a clean confirmed worktree without force, then deletes its marker", async () => {
    const value = await fixture();
    const binDirectory = join(value.root, "bin");
    const gitCalls = join(value.root, "git-calls.log");
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await fs.mkdir(binDirectory);
    await fs.writeFile(
      join(binDirectory, "git"),
      [
        "#!/usr/bin/env bash",
        String.raw`printf '%s\n' "$*" >> "$GIT_CALLS"`,
        String.raw`exec "$REAL_GIT" "$@"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runRemoveHook(
      value,
      { worktree_path: value.worktree, confirmed: true },
      {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        GIT_CALLS: gitCalls,
        REAL_GIT: realGit,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await pathExists(value.worktree)).toBe(false);
    expect(await pathExists(value.markerPath)).toBe(false);

    const gitCallLog = await fs.readFile(gitCalls, "utf8");
    const calls = gitCallLog.split("\n").filter(Boolean);
    const removeCall = calls.find((call) => call.includes("worktree remove"));
    expect(removeCall).toBeDefined();
    expect(removeCall).not.toMatch(/(?:^|\s)(?:--force|-f)(?:\s|$)/);

    const list = await runGit(
      ["worktree", "list", "--porcelain"],
      value.repository,
    );
    expect(list.stdout).not.toContain(value.worktree);
  });

  test("create marker is accepted by the confirmed clean removal path", async () => {
    const root = await fs.realpath(
      await setupTestDirectory("codex-worktree-roundtrip"),
    );
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "linked-worktree");
    const binDirectory = join(root, "bin");
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await fs.mkdir(repository);
    await fs.mkdir(binDirectory);
    await runGit(["init", "-q", "-b", "main", repository]);
    await runGit(
      ["config", "user.email", "codex-test@example.com"],
      repository,
    );
    await runGit(["config", "user.name", "Codex Test"], repository);
    await runGit(
      ["commit", "-q", "--allow-empty", "-m", "initial"],
      repository,
    );
    await fs.writeFile(
      join(binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ] && [ "$2" = "-b" ]; then',
        '  exec "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q -b "$3" "$GWQ_WORKTREE"',
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const created = await runCommand(["bash", CREATE_HOOK], {
      cwd: repository,
      env: {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        GWQ_REPOSITORY: repository,
        GWQ_WORKTREE: worktree,
      },
      input: JSON.stringify({ name: BRANCH }),
    });

    expect(created.exitCode).toBe(0);
    expect(created.stdout).toBe(worktree);
    const commonDirectory = await fs.realpath(join(repository, ".git"));
    const pathSha1 = createHash("sha1").update(worktree).digest("hex");
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${pathSha1}.json`,
    );
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
      branch: string;
      path: string;
    };
    expect(marker).toEqual({ path: worktree, branch: BRANCH });
    const markerStats = await fs.stat(markerPath);
    expect(markerStats.mode & 0o777).toBe(0o600);

    const fixtureValue: WorktreeFixture = {
      root,
      repository,
      worktree,
      commonDirectory,
      markerPath,
    };
    const removed = await runRemoveHook(fixtureValue, {
      worktree_path: worktree,
      confirmed: true,
    });
    expect(removed.exitCode).toBe(0);
    expect(await pathExists(worktree)).toBe(false);
    expect(await pathExists(markerPath)).toBe(false);
  });
});
